import { join } from 'node:path';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import {
  buildLlmTools,
  callMcpTool,
  formatMcpToolResult,
  formatMcpToolsForAgent,
  resolveToolCallName,
  truncateToolResult,
} from '../core/mcp.js';
import { formatSkillsForAgent, readOptionalText } from '../core/skills.js';
import { handleSlashCommand } from '../commands/slash.js';
import { extractActivity, formatActivitySummary, parseJsonText, sessionActivities } from '../core/activity.js';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { enqueueProductionJob, ensureJobQueue, formatQueue, productionLockBusy } from '../core/jobQueue.js';
import { updateWorkspaceProfilePreference } from '../core/profile.js';
import { createCapabilityRegistry } from '../orchestrator/capabilityRegistry.js';

const MAX_TOOL_ITERATIONS = 80;
const MAX_SPINNER_ARG_LENGTH = 96;
const MAX_PROFILE_CHARS = 4000;

// Pseudo-servers handled directly by the tool executor (not present in
// session.mcp). Listed so unqualified names like "plan_set" resolve the same
// way as MCP tools in resolveToolCallName.
const INTERNAL_TOOL_SERVERS = {
  wiki: ['plan_set', 'plan_done'],
  shell: ['run_command', 'read_command', 'profile_update'],
};

const AGENT_SLASH_COMMANDS = new Set([
  'help',
  'version',
  'workspace',
  'use',
  'config',
  'status',
  'services',
  'skills',
  'upload',
  'uploads',
  'queue',
]);

const SHELL_RUN_COMMAND_TOOL = {
  type: 'function',
  function: {
    name: 'shell__run_command',
    description: [
      'Run a deterministic wiki-manager slash command inside the current shell session.',
      'Allowed commands: /workspace list, /workspace init <name> [path], /use <workspace>, /config, /status, /services, /skills, /skills show <name>, /skills run <name>, /upload <path>, /upload convert <id|pending>, /uploads.',
      'Do not use for arbitrary system shell commands, /workspace delete, /mcp call, /wiki run, /start, /stop, /logs, or /exit.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: {
          type: 'string',
          description: 'Slash command to run, for example "/workspace list", "/workspace init <name>", or "/use <workspace>".',
        },
      },
      required: ['command'],
    },
  },
};

const SHELL_READ_COMMAND_TOOL = {
  type: 'function',
  function: {
    name: 'shell__read_command',
    description: [
      'Run a read-only deterministic wiki-manager slash command inside the current shell session.',
      'Allowed commands: /help, /version, /config, /config list, /config status, /status, /services, /skills, /skills list, /skills show <name>, /uploads, /uploads list, /queue.',
      'Do not use for workspace creation/deletion, uploads conversion, service start/stop, MCP calls, wiki runs, or any mutation.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: {
          type: 'string',
          description: 'Read-only slash command to run, for example "/status", "/config status", or "/services".',
        },
      },
      required: ['command'],
    },
  },
};

const SHELL_PROFILE_UPDATE_TOOL = {
  type: 'function',
  function: {
    name: 'shell__profile_update',
    description: [
      'Append one explicit durable user preference to the current workspace .wiki/profile.md.',
      'Use when the user explicitly asks to remember, persist, note, or update profile information and wiki__profile_update is not available.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        preference: {
          type: 'string',
          description: 'The durable preference to append, without Markdown bullet syntax.',
        },
      },
      required: ['preference'],
    },
  },
};

const WIKI_PLAN_SET_TOOL = {
  type: 'function',
  function: {
    name: 'wiki__plan_set',
    description: [
      'Declare the ordered list of steps you intend to execute for this multi-step task.',
      'Call this once at the start, before executing any step.',
      'The orchestrator will track progress and show step status on each re-invocation.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        steps: {
          type: 'array',
          items: {
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  description: { type: 'string' },
                  requiredCapability: { type: ['string', 'null'] },
                  status: { type: 'string', enum: ['pending', 'queued', 'running', 'waiting', 'pending_approval', 'done', 'failed', 'cancelled', 'stalled', 'added_during_run'] },
                  dependsOn: { type: 'array', items: { type: 'string' } },
                  outputRefs: { type: 'array', items: { type: 'string' } },
                },
                required: ['description'],
              },
            ],
          },
          description: 'Ordered steps. Backward-compatible strings are accepted; structured steps may include id, requiredCapability, dependsOn, outputRefs.',
        },
      },
      required: ['steps'],
    },
  },
};

const WIKI_PLAN_DONE_TOOL = {
  type: 'function',
  function: {
    name: 'wiki__plan_done',
    description: [
      'Mark a plan step as done or failed.',
      'Use for steps that complete synchronously (no _activity polling needed).',
      'For async MCP jobs, the orchestrator marks steps automatically via activity matching.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        step: {
          type: 'number',
          description: 'Step number to update (1-based, matching the order declared in wiki__plan_set).',
        },
        status: {
          type: 'string',
          enum: ['done', 'failed'],
          description: 'Step outcome. Defaults to "done".',
        },
      },
      required: ['step'],
    },
  },
};

const AgentState = Annotation.Root({
  input: Annotation(),
  session: Annotation(),
  response: Annotation(),
  messages: Annotation({
    reducer: (existing, update) => [...(existing ?? []), ...(update ?? [])],
    default: () => [],
  }),
  toolIterations: Annotation({ default: () => 0 }),
  pendingToolCalls: Annotation(),
  inputClassification: Annotation(),
  readyToStream: Annotation(),
  streamContext: Annotation(),
  streamedInline: Annotation(),
});

function commandList(session) {
  return session.commands.map((command) => `/${command}`).join(', ');
}

function summarizeToolArguments(rawArguments) {
  if (!rawArguments || rawArguments === '{}') return '';
  try {
    const parsed = JSON.parse(rawArguments);
    const entries = Object.entries(parsed ?? {});
    if (entries.length === 0) return '';
    const summary = entries
      .slice(0, 4)
      .map(([key, value]) => {
        const rendered = typeof value === 'string' ? value : JSON.stringify(value);
        return `${key}=${String(rendered).replace(/\s+/g, ' ').slice(0, 36)}`;
      })
      .join(', ');
    return summary.length > MAX_SPINNER_ARG_LENGTH
      ? `${summary.slice(0, MAX_SPINNER_ARG_LENGTH - 3)}...`
      : summary;
  } catch {
    return String(rawArguments).replace(/\s+/g, ' ').slice(0, MAX_SPINNER_ARG_LENGTH);
  }
}

function buildQueuedResult(session, item, activeJobId = null) {
  const message = activeJobId != null
    ? `Production job queued as ${item.id}; waiting for ${activeJobId}.`
    : `Production job queued as ${item.id}; waiting for the current production lock.`;
  session._onStep?.(`Queue: ${item.id} waiting for production lock`);
  return JSON.stringify({
    ok: false,
    queued: true,
    queueId: item.id,
    status: item.status,
    workspace: item.workspace,
    ...(activeJobId != null ? { activeJobId } : {}),
    message,
  }, null, 2);
}

function basename(value) {
  return String(value ?? '').split('/').filter(Boolean).pop() ?? '';
}

function formatProductionProgress(payload) {
  const progress = payload?.progress;
  const job = payload?.job;
  if (!progress && !job && !payload?.jobId) return null;

  const percent = Number.isFinite(Number(progress?.percent))
    ? `${Math.round(Number(progress.percent))}%`
    : null;
  const sourceCount = Number(progress?.sourceCount);
  const sourceIndex = Number(progress?.sourceIndex);
  const sourceDoneCount = Number(progress?.sourceDoneCount);
  const fileProgress = Number.isFinite(sourceCount) && sourceCount > 0
    ? Number.isFinite(sourceIndex)
      ? `file ${Math.min(sourceCount, sourceIndex + 1)}/${sourceCount}`
      : Number.isFinite(sourceDoneCount)
        ? `files ${Math.min(sourceCount, sourceDoneCount)}/${sourceCount}`
        : null
    : null;
  const batchProgress = progress?.batchCount
    ? `batch ${Number(progress.batchIndex ?? 0) + 1}/${progress.batchCount}`
    : null;
  const progressDetail = batchProgress && /^batch\s+\d+\/\d+/i.test(String(progress?.detail ?? ''))
    ? null
    : progress?.detail;
  const parts = [
    progress?.phase ?? progress?.currentStep ?? job?.type,
    job?.status ?? payload?.status,
    percent,
    fileProgress,
    batchProgress,
    progress?.source ? basename(progress.source) : null,
    progress?.template ? basename(progress.template) : null,
    progress?.deliverable ? basename(progress.deliverable) : null,
    progressDetail,
    progress?.instructionCount ? `${progress.instructionCount} instructions` : null,
    progress?.lastEvent ? `last ${progress.lastEvent}` : null,
  ].filter(Boolean);

  return parts.length > 0 ? `Production: ${parts.join(' · ')}` : null;
}

function normalizeShellCommand(value) {
  const command = String(value ?? '').trim();
  return command.startsWith('/') ? command : `/${command}`;
}

function assertAgentSlashCommandAllowed(commandLine) {
  const parts = commandLine.slice(1).trim().split(/\s+/).filter(Boolean);
  const command = parts[0] ?? '';
  if (!AGENT_SLASH_COMMANDS.has(command)) {
    throw new Error(`Command is not available to the agent: /${command}`);
  }
  if (command === 'workspace' && parts[1] !== 'init') {
    throw new Error('Only /workspace init is available to the agent.');
  }
}

function assertAgentReadSlashCommandAllowed(commandLine) {
  const parts = commandLine.slice(1).trim().split(/\s+/).filter(Boolean);
  const command = parts[0] ?? '';
  const subcommand = parts[1] ?? '';
  const allowed =
    command === 'help' ||
    command === 'version' ||
    command === 'status' ||
    command === 'services' ||
    command === 'queue' ||
    (command === 'config' && ['', 'list', 'status'].includes(subcommand)) ||
    (command === 'skills' && ['', 'list', 'show'].includes(subcommand)) ||
    (command === 'uploads' && ['', 'list'].includes(subcommand));
  if (!allowed) {
    throw new Error(`Read-only command is not available to the agent: /${parts.join(' ')}`);
  }
}

function withActiveWorkspaceForExternalTool(session, server, tool, args) {
  const needsWorkspace =
    (server === 'documents' && tool.startsWith('documents_') && tool !== 'documents_status') ||
    (server === 'cme' && tool.startsWith('cme_') && tool !== 'cme_export_cancel' && !(tool === 'cme_export_status' && args.job_id));
  if (!needsWorkspace) return args;
  if (!session.workspace) {
    throw new Error(`No active workspace available for ${server}.${tool}. Use /use <workspace> first.`);
  }
  if (args.workspace && args.workspace !== session.workspace) {
    throw new Error(
      `${server}.${tool} targets workspace "${args.workspace}" but the active workspace is "${session.workspace}". Use /use ${args.workspace} first.`,
    );
  }
  return { ...args, workspace: session.workspace };
}

async function runShellCommandTool(session, commandLine) {
  const command = normalizeShellCommand(commandLine);
  assertAgentSlashCommandAllowed(command);
  session._onStep?.(`Shell: ${command}`);
  const result = await handleSlashCommand(command, {
    packageJson: session.packageJson ?? { version: '0.0.0' },
    session,
    onStep: session._onStep,
  });
  if (result.exit) {
    throw new Error('/exit is not available to the agent.');
  }
  return result.output ?? 'Command completed.';
}

async function runShellReadCommandTool(session, commandLine) {
  const command = normalizeShellCommand(commandLine);
  assertAgentReadSlashCommandAllowed(command);
  session._onStep?.(`Shell: ${command}`);
  const result = await handleSlashCommand(command, {
    packageJson: session.packageJson ?? { version: '0.0.0' },
    session,
    onStep: session._onStep,
  });
  if (result.exit) {
    throw new Error('/exit is not available to the agent.');
  }
  return result.output ?? 'Command completed.';
}

function rememberProductionProgress(session, payload, label) {
  const job = payload?.job;
  const jobId = payload?.jobId ?? job?.jobId;
  if (!jobId && !label) return;
  const status = job?.status ?? payload?.status ?? payload?.progress?.status ?? 'running';
  session.productionActivity = {
    jobId: jobId ?? session.productionActivity?.jobId ?? null,
    status,
    label: label ?? `Production: ${status}`,
    terminal: ['done', 'failed', 'cancelled'].includes(String(status)),
    updatedAt: new Date().toISOString(),
  };
}

function toolRequiresApproval(session, server, tool) {
  const policy = session.mcp?.[server]?.requireApproval;
  if (policy === true) return true;
  if (typeof policy === 'string') return policy === tool || policy === '*';
  if (Array.isArray(policy)) return policy.includes(tool) || policy.includes('*');
  return false;
}

function queueApprovalItem(session, { itemId, server, tool, args }) {
  const queue = ensureJobQueue(session);
  const existing = queue.find((item) => item.id === itemId);
  if (existing) return existing;
  const item = {
    id: itemId,
    workspace: session.workspace ?? null,
    server,
    tool,
    args,
    status: 'pending_approval',
    reason: 'approval_required',
    createdAt: new Date().toISOString(),
  };
  queue.push(item);
  session.queueStore?.changed?.();
  return item;
}

function markApprovalQueueItem(session, itemId, status) {
  const item = ensureJobQueue(session).find((entry) => entry.id === itemId);
  if (!item) return;
  item.status = status;
  item.finishedAt = new Date().toISOString();
  session.queueStore?.changed?.();
}

async function awaitRunApproval(session, { runId, tool }) {
  if (!session._runApprovalRequired || session._runApprovalResolved || !session._requestApproval) return;
  const plan = (session.headlessPlan ?? []).map((step) => step.description ?? step.label ?? `Step ${step.step}`);
  await session._requestApproval({
    scope: 'run',
    runId,
    reason: `Approve run plan before executing ${tool}.`,
    plan,
    tool,
    timeoutMs: session._approvalTimeoutMs,
    signal: session._abortSignal,
  });
  session._runApprovalResolved = true;
}

async function awaitToolApproval(session, { runId, server, tool, args, callId }) {
  if (!toolRequiresApproval(session, server, tool) || !session._requestApproval) return;
  const itemId = `approval-${callId ?? `${server}-${tool}`}`;
  queueApprovalItem(session, { itemId, server, tool, args });
  try {
    await session._requestApproval({
      scope: 'tool',
      runId,
      itemId,
      reason: `Approve MCP tool ${server}.${tool}.`,
      tool: `${server}.${tool}`,
      timeoutMs: session._approvalTimeoutMs,
      signal: session._abortSignal,
    });
    markApprovalQueueItem(session, itemId, 'approved');
  } catch (err) {
    markApprovalQueueItem(session, itemId, 'failed');
    throw err;
  }
}

function emitAgentEvent(session, type, origin, payload = {}) {
  dispatchAgentEvent(session, createAgentEvent(type, { origin, payload }));
}

// Capability ids currently provided by discovered, orchestrable, healthy
// agents. This is the live registry the dispatcher will resolve against —
// a plan declaring anything outside this set can only stall forever.
export function knownCapabilityIds(session) {
  const registry = session?.capabilityRegistry ?? createCapabilityRegistry({
    agents: session?.agentRegistrySnapshot ?? session?.agents ?? [],
  });
  const snapshot = typeof registry.snapshot === 'function' ? registry.snapshot() : registry;
  return [...new Set(Object.keys(snapshot ?? {}).map((key) => {
    const index = key.lastIndexOf('@');
    return index > 0 ? key.slice(0, index) : key;
  }))].sort();
}

function handleWikiTool(session, tool, args) {
  if (tool === 'plan_set') {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    // Reject fantasy capabilities BEFORE the plan exists: once registered,
    // unresolvable steps become tasks that wait forever and flood the queue.
    // A tool-level error (not an exception) lets the LLM correct itself in
    // the same turn. An empty registry (discovery not done yet) skips the
    // check rather than blocking legitimate early plans.
    const known = knownCapabilityIds(session);
    if (known.length > 0) {
      const unknown = [...new Set(steps
        .map((step) => (step && typeof step === 'object' ? step.requiredCapability : null))
        .filter(Boolean)
        .map(String)
        .filter((capability) => !known.includes(capability.includes('@') ? capability.slice(0, capability.lastIndexOf('@')) : capability)))];
      if (unknown.length > 0) {
        return `Plan rejected: unknown capabilities [${unknown.join(', ')}]. `
          + `Available capabilities: ${known.join(', ')}. `
          + 'Redeclare the plan using only available capabilities, or use requiredCapability: null for a step you execute yourself.';
      }
    } else if (steps.some((step) => step && typeof step === 'object' && step.requiredCapability)) {
      session._onStep?.('plan_set: capability registry empty, validation skipped');
    }
    emitAgentEvent(session, 'plan_set', 'tool', {
      steps: steps.map((raw, i) => normalizeDeclaredPlanStep(raw, i, session)),
    });
    return `Plan registered: ${steps.length} step${steps.length !== 1 ? 's' : ''}.`;
  }
  if (tool === 'plan_done') {
    const plan = session.headlessPlan;
    if (!plan) return 'No active plan. Call wiki__plan_set first.';
    const step = plan.find((s) => s.step === Number(args.step));
    if (!step) return `Step ${args.step} not found (plan has ${plan.length} steps).`;
    const status = args.status === 'failed' ? 'failed' : 'done';
    emitAgentEvent(session, 'plan_step_updated', 'tool', { step: Number(args.step), status });
    return `Step ${args.step} marked as ${status}.`;
  }
  return `Unknown wiki tool: ${tool}`;
}

function normalizeDeclaredPlanStep(raw, index) {
  const item = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw
    : { description: String(raw) };
  const description = String(item.description ?? item.label ?? item.name ?? item.id ?? `Step ${index + 1}`);
  return {
    step: Number(item.step ?? index + 1),
    id: item.id ? String(item.id) : slugStepId(description, index),
    description,
    status: item.status ?? 'pending',
    dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(String) : [],
    requiredCapability: item.requiredCapability != null ? String(item.requiredCapability) : null,
    executor: null,
    executorQuery: null,
    outputRefs: Array.isArray(item.outputRefs) ? item.outputRefs.map(String) : [],
  };
}

function slugStepId(description, index) {
  const slug = String(description)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || `task-${index + 1}`;
}

// The manager runs on the same host filesystem as the workspace directory
// (this is the same local file wiki__profile_update writes to via its
// volume-mounted container), so read it fresh on every turn instead of
// relying on the model proactively calling wiki__profile_read — profile
// content (tutoiement, formatting preferences, etc.) is meant to shape every
// reply, not just ones where the model happens to think to check it.
function loadWorkspaceProfile(workspacePath) {
  if (!workspacePath) return null;
  const content = readOptionalText(join(workspacePath, '.wiki', 'profile.md'));
  return content ? content.slice(0, MAX_PROFILE_CHARS) : null;
}

export function buildAgentSystemPrompt(state) {
  const workspace = state.session.workspace ?? 'no workspace selected';
  const wikirc = state.session.wikirc?.profile ?? 'no profile loaded';
  const language = state.session.language ?? 'en-US';
  const mcpTools = formatMcpToolsForAgent(state.session.mcp);
  const skills = formatSkillsForAgent(state.session);
  const customPrompt = state.session.systemPrompt ?? null;
  const workspaceProfile = loadWorkspaceProfile(state.session.workspacePath);

  const agentContext = [
    'You are Donna, the terminal orchestrator agent for llm-wiki-manager.',
    'The shell is agent-first: every input without a leading slash is routed to you.',
    'Default to a plain conversational reply with no tool call. Only call a tool, create a plan, or start a job when the user\'s message clearly requests an action (ingest, build, export, configure, run a skill, check a concrete status, etc.). Greetings, small talk, thanks, and general questions do not warrant starting a job or calling a tool — just answer in text.',
    'Commands starting with / are deterministic primitives. You may run a safe subset through shell__run_command.',
    `Reply language: ${language}.`,
    `Current workspace: ${workspace}.`,
    `Current wikirc profile: ${wikirc}.`,
    `Available primitives: ${commandList(state.session)}.`,
    'Only announce or call slash commands that appear exactly in Available primitives. Do not invent command names, subcommands, or arguments.',
    'Connected MCP tools (use the server__tool naming convention for tool calls):',
    mcpTools,
    'Current local MCP job queue:',
    formatQueue(state.session),
    'Available skills:',
    skills,
    'You can call MCP tools directly using the provided tool functions.',
    'When the user asks for an action that can be performed with connected MCP tools or safe primitives, do not answer with future intent such as "I will call...", "I am going to run...", or "launching..." unless you also call the tool in the same turn. Either call the tool now, ask for the exact missing required arguments, or explain the concrete blocker.',
    'For connector configuration/setup/update requests, if a matching setup/configuration tool is connected and the required arguments are known, call it immediately. If the connector or tool is not connected, say which concrete capability is missing and recommend the exact service/status primitive to inspect it. Do not invent a pending connector action in plain text.',
    'For workspace-scoped external MCP tools, the orchestrator enforces workspace injection. Use the active workspace for configuration, source, import, export, conversion, and generation tools unless a tool is explicitly job-scoped and only requires a job id.',
    'You can call shell__run_command for safe manager slash commands such as /workspace list, /workspace init <name> [path], /use <workspace>, /config, /status, /services, /skills, /skills show <name>, and /skills run <name>.',
    'Skills are workflow instructions, not executable code. When a user asks to run a skill, inspect it, propose the concrete primitive/tool plan, and ask for confirmation before costly or mutating actions.',
    [
      state.session.headless ? 'HEADLESS MODE ACTIVE. Execute the requested skill or task autonomously using available safe primitives and MCP tools. Do not ask for interactive confirmation unless the request is genuinely ambiguous or outside the loaded workspace.' : null,
      '',
      'You have two internal planning tools: wiki__plan_set and wiki__plan_done.',
      'Prefer MCP tools that declare their own plan via _activity.plan.steps — when such a tool returns _activity, the shell creates and tracks the plan automatically without requiring wiki__plan_set.',
      'Use wiki__plan_set when the MCP tool cannot declare its own plan or when the task spans multiple independent tools (e.g. CME export then email report). For a single self-describing async job, wiki__plan_set is optional.',
      '',
      (() => {
        const capabilityIds = knownCapabilityIds(state.session);
        return capabilityIds.length > 0
          ? `Known orchestration capabilities — the ONLY values allowed in requiredCapability: ${capabilityIds.join(', ')}. Never invent capability names; a plan declaring an unknown capability will be rejected. A step you execute yourself directly takes requiredCapability: null.`
          : 'No orchestration capabilities discovered yet: declare plan steps with requiredCapability: null and execute them yourself with the connected MCP tools.';
      })(),
      '',
      'Task startup:',
      '  1. If the next MCP tool returns _activity.plan.steps, call that tool directly; the shell will create the visible plan from the returned activity.',
      '  2. If the tool cannot declare its own plan, call wiki__plan_set before executing the first step. Prefer structured steps: {id, description, requiredCapability, dependsOn, outputRefs}; a legacy list of strings is still accepted.',
      '     Multi-tool example: wiki__plan_set(steps=[{id:"cme-export",description:"CME export",requiredCapability:"external-source.export",dependsOn:[],outputRefs:["raw/untracked"]},{id:"production",description:"Production pipeline",requiredCapability:"knowledge.pipeline",dependsOn:["cme-export"],outputRefs:["deliverables"]}])',
      '  3. Immediately execute the first step using the appropriate MCP tool. Do not start step 2 in the same turn unless one async pipeline tool owns and declares the whole sequence.',
      '  For synchronous steps (result is immediate, no _activity polling), call wiki__plan_done(step=1) after confirming success.',
      '  For async MCP jobs (returns _activity with poll), the orchestrator tracks completion automatically.',
      '',
      state.session.headless ? [
        'Headless follow-up turns — the orchestrator re-invokes you with:',
        '  (a) the original task,',
        '  (b) the current plan status — [✓] done / [✗] failed / [ ] pending,',
        '  (c) the just-completed activities.',
        '  Read the plan status. Find the first [ ] pending step. Execute it only.',
        '  Never re-execute a [✓] or [✗] step. Never skip a [ ] step.',
        '',
        'Final turn — when all steps are [✓] or [✗]: respond with a concise summary. Do not start new actions.',
      ].join('\n') : null,
      '',
      'On failure: if a completed activity is failed/error/cancelled, call wiki__plan_done(step=N, status="failed") then stop with a clear error report.',
    ].filter(Boolean).join('\n'),
    'For service actions, recommend only available service primitives from Available primitives, with the exact service name when the primitive supports one.',
    'Scope discipline: execute ONLY the action(s) the user explicitly requested. Never chain additional mutating operations (ingest, build, export, polish, delete, send…) that the user did not ask for — even when diagnostics or recommendations suggest them. Finish the requested work, then list the suggested follow-ups in your final answer and stop. Example: "applique les recommandations de config" means apply the config; it does NOT authorize launching the ingest those recommendations mention.',
    'Disambiguate export requests carefully.',
    'Confluence/CME/source export means exporting external Confluence sources into raw/untracked: use cme MCP tools (`cme__cme_export_run`, then `cme__cme_export_status`). Never use production `type=export` for Confluence source export.',
    'Wiki/deliverable/publication export means exporting generated deliverables from the wiki: use production MCP tools (`production__production_start_job` with `type:"export"` or pipeline steps). Require the deliverable path when exporting deliverables.',
    'For ingest/build/export/polish/pipeline workflows, use production MCP tools. Do not route these through direct /wiki shortcuts. To chain multiple sequential steps (e.g. build then polish), always use a single production__production_start_job call with type="pipeline" and steps=["build","polish"] — never start them as separate jobs: the first job is asynchronous and the second would run before it completes. For existing deliverables where content stability matters, pass stabilize:true so the build step preserves unchanged sections; keep polish in the pipeline when publication output is requested. Do not ask the user to confirm between steps; start the pipeline call directly.',
    'Long-running MCP jobs: do not call the same status tool more than once consecutively. When chaining jobs sequentially: (1) start the job, report job/activity id and status; (2) check status once — if done, proceed to the next step immediately; (3) if still running, report status, list the remaining steps, and return control; (4) when re-invoked, check status first, then proceed. Do not spin-poll (status → status → status with no new action between). The shell activity panel monitors non-terminal jobs automatically.',
    'If production__production_start_job is returned as queued/waiting by the manager, report that it is waiting in the local queue and return control. Do not continue as if the production job has started.',
    'For diagnostics, use /wiki run doctor when the user asks for doctor. Use /workspace init <name> [path] for low-level non-interactive workspace creation. In the interactive TUI, /new <name> opens the setup wizard. Use /wiki for index, or /wiki run index through the explicit backup hatch. Use /wiki run init only for explicit current-workspace llm-wiki init.',
    'If an action requires tools or skills not available yet, explain the limitation and name the expected primitive.',
    workspaceProfile
      ? `Workspace profile (.wiki/profile.md) — durable user preferences, apply these to every reply (tone, tutoiement/vouvoiement, formatting, etc.):\n${workspaceProfile}`
      : null,
    'When the user explicitly asks you to remember, persist, or update durable preference/profile information, call wiki__profile_update when it is available; otherwise call shell__profile_update. Do not just acknowledge in text without calling a profile update tool.',
  ].filter(Boolean).join('\n');

  return customPrompt ? `${customPrompt}\n\n${agentContext}` : agentContext;
}

export function buildLimitedAgentResponse(state, reason = 'no workspace loaded with .wikirc.yaml') {
  const workspace = state.session.workspace ?? 'no workspace selected';
  const wikirc = state.session.wikirc?.profile ?? 'no profile loaded';
  return [
    `Donna is active. Current workspace: ${workspace}.`,
    `Current wikirc profile: ${wikirc}.`,
    '',
    'I am the shell agent mode: use `/agent` to route free text through this LangGraph graph, or `/chat` for direct chat.',
    `LLM connection: limited mode (${reason}).`,
    `Available primitives: ${commandList(state.session)}.`,
    '',
    'Connected MCP tools:',
    formatMcpToolsForAgent(state.session.mcp),
    '',
    'Limited mode: workspace, Docker Compose tools, MCP calls, /wiki fallback, skill discovery, and headless mode are wired.',
    'Use `/help` to see deterministic shell commands.',
  ].join('\n');
}

export function formatLlmUnavailableMessage(reason) {
  const clean = String(reason ?? 'raison inconnue').replace(/\s+/g, ' ').trim();
  return `⚠ LLM injoignable : ${clean || 'raison inconnue'}`;
}

// Verbs that clearly request work (a runtime run), in French and English.
// "configure/configurer" is an action; the nouns "config/configuration" are
// NOT matched here — asking for a config is an observe request.
const ACTION_REQUEST_PATTERN = /\b(lance|relance|d[eé]marre|start|ex[eé]cute|execute|g[eé]n[eè]re|generate|build|construis|exporte?|ingest\w*|ing[eè]re|importe?|convert(?:is|it|s)?|cr[eé]e|create|polish|publie|publish|d[eé]ploie|deploy|envoie|send|configure[rsz]?|setup|installe|update|mets? [aà] jour|supprime|delete|efface|nettoie|clean|r[eé]pare|fix|corrige)\b/i;

// Explicit explanation/question markers dominate action verbs: "explique le
// build" is a question about the build, not a request to build.
const EXPLANATION_REQUEST_PATTERN = /\b(explique|explain|pourquoi|why|comment|how|c'est quoi|qu'est[- ]ce)\b/i;

export function classifyAgentInput(input, session) {
  const lower = String(input ?? '').toLowerCase();
  const hasActiveRun = session?.agentProjection?.status === 'running'
    || sessionActivities(session).some((activity) => !activity.terminal);
  if (/\b(valide tout|approve all|approve|approuve|valid[eé]|ok pour tout|go pour tout)\b/i.test(lower)) {
    return { kind: 'approve', confidence: 0.86, reason: 'approval_request', activeRun: hasActiveRun };
  }
  if (/\b(cancel|annule|stop|arr[eê]te|interromps|abort)\b/i.test(lower)) {
    return { kind: 'cancel', confidence: 0.86, reason: 'cancel_request', activeRun: hasActiveRun };
  }
  if (/\b(plus tard|later|ensuite|apr[eè]s ce run|enqueue|mets en file|met en file|futur|next run|future run)\b/i.test(lower)) {
    return { kind: 'enqueue_run', confidence: 0.8, reason: 'future_run_request', activeRun: hasActiveRun };
  }
  if (EXPLANATION_REQUEST_PATTERN.test(lower)) {
    return { kind: 'observe', confidence: 0.86, reason: 'explanation_request', activeRun: hasActiveRun };
  }
  // Observe markers only win when no action verb is present: "où en est le
  // run" is observe, "lance le run" is an action request.
  if (/\b(o[uù] en es[t-]|status|statut|progress|progression|run|job|queue|logs?|inspect|show|montre|affiche|donne|liste|list|quel(?:le)?s?|combien|config(?:uration)?|quoi de neuf)\b/i.test(lower)
    && !ACTION_REQUEST_PATTERN.test(lower)) {
    return { kind: 'observe', confidence: 0.86, reason: 'status_or_explanation_request', activeRun: hasActiveRun };
  }
  if (hasActiveRun && /\b(ajoute|add|change|modifie|modify|remplace|replace|retire|remove|skip|ignore|plan|step|t[aâ]che)\b/i.test(lower)) {
    return { kind: 'modify_run', confidence: 0.78, reason: 'active_run_change_request', activeRun: hasActiveRun };
  }
  if (hasActiveRun && /\b(lance|run|g[eé]n[eè]re|build|export|cr[eé]e|create|send|envoie|ingest|convert|importe|import)\b/i.test(lower)) {
    return { kind: 'ambiguous', confidence: 0.45, reason: 'active_run_action_is_ambiguous', activeRun: hasActiveRun };
  }
  if (ACTION_REQUEST_PATTERN.test(lower)) {
    return { kind: 'start_run', confidence: 0.8, reason: 'action_request', activeRun: hasActiveRun };
  }
  return { kind: 'converse', confidence: 0.62, reason: 'plain_conversation', activeRun: hasActiveRun };
}

function toolsForClassification(classification, writeTools) {
  if (classification.activeRun && ['converse', 'observe'].includes(classification.kind)) return [SHELL_READ_COMMAND_TOOL];
  return [SHELL_READ_COMMAND_TOOL, ...writeTools];
}

export function createAgentGraph(options = {}) {
  async function orchestratorNode(state) {
    const llm = state.session.llm ?? options.llm ?? null;

    if (!llm) {
      return { response: formatLlmUnavailableMessage('aucun client LLM configure'), pendingToolCalls: null, readyToStream: false };
    }

    const iterations = state.toolIterations ?? 0;
    if (iterations >= MAX_TOOL_ITERATIONS) {
      return {
        response: `[Donna] Tool-use cap reached after ${iterations} iterations.`,
        pendingToolCalls: null,
        readyToStream: false,
      };
    }

    if (iterations > 0) {
      state.session._onStep?.(`[${iterations}/${MAX_TOOL_ITERATIONS}] synthesizing…`);
    } else {
      state.session._onStep?.('Agent: planning next action…');
    }

    // Inside a runtime run the input IS the task to execute (the runtime
    // already accepted it as a run): the interactive control-message
    // classifier must not apply. Without this, agentProjection.status is
    // 'running' during every run, so any action verb ("lance l'ingestion")
    // matched the active-run 'ambiguous' branch and returned a canned
    // clarification instead of executing — the run ended silently.
    const runtimeExecution = Boolean(state.session._currentRunIdentity);
    const classification = iterations === 0
      ? (runtimeExecution
        ? { kind: 'execute_run', confidence: 1, reason: 'runtime_run_execution', activeRun: true }
        : classifyAgentInput(state.input, state.session))
      : (state.inputClassification ?? { kind: 'modify_run', confidence: 1, reason: 'tool_iteration' });
    if (iterations === 0) {
      state.session._onStep?.(`Agent: classified input as ${classification.kind}`);
      emitAgentEvent(state.session, 'control_message_received', 'agent_classifier', {
        input: state.input,
        classification,
      });
    }
    if (iterations === 0 && classification.kind === 'ambiguous') {
      return {
        response: 'Je peux répondre sur le run en cours, modifier ce run, mettre une nouvelle demande en file, approuver, ou annuler. Peux-tu préciser ce que tu veux faire ?',
        pendingToolCalls: null,
        readyToStream: false,
        inputClassification: classification,
      };
    }

    const writeTools = [
      SHELL_RUN_COMMAND_TOOL,
      SHELL_PROFILE_UPDATE_TOOL,
      WIKI_PLAN_SET_TOOL,
      WIKI_PLAN_DONE_TOOL,
      ...buildLlmTools(state.session.mcp),
    ];
    const tools = toolsForClassification(classification, writeTools);
    const system = buildAgentSystemPrompt(state);

    // On iteration 0: prior history is in state.messages, user input must be appended.
    // On subsequent iterations: user message was already stored in state.messages by the
    // iteration-0 return below, so use state.messages as-is.
    const conversationMessages = iterations === 0
      ? [...(state.messages ?? []), { role: 'user', content: state.input }]
      : (state.messages ?? []);

    try {
      const useStreamWithTools = typeof llm.streamWithTools === 'function';
      const result = useStreamWithTools
        ? await llm.streamWithTools({
            system,
            tools,
            messages: conversationMessages,
            onTextDelta: (delta) => {
              emitAgentEvent(state.session, 'assistant_delta', 'llm', { delta });
              state.session._onStream?.(delta);
            },
            signal: state.session._abortSignal,
          })
        : await llm.completeWithTools({
            system,
            tools,
            messages: conversationMessages,
            signal: state.session._abortSignal,
          });

      if (result.tool_calls?.length > 0) {
        state.session._onStreamReset?.();
        // Close the streaming conversation entry now: the text streamed so
        // far is this iteration's narration. Without this, the next
        // iteration's deltas append to the SAME entry with no separator and
        // the chat becomes one glued wall of text ("…de la config.Voyons…").
        // An empty finalize keeps the accumulated content and just drops the
        // streaming flag; it is a no-op when nothing was streamed.
        emitAgentEvent(state.session, 'assistant_message', 'llm', { content: '' });
        state.session._onStep?.(`[${iterations + 1}/${MAX_TOOL_ITERATIONS}] ${result.tool_calls.length} MCP action${result.tool_calls.length > 1 ? 's' : ''} queued…`);
        // On iteration 0 persist the user message too so it survives the loop.
        const newMessages = iterations === 0
          ? [{ role: 'user', content: state.input }, result.message]
          : [result.message];
        return {
          pendingToolCalls: result.tool_calls,
          messages: newMessages,
          toolIterations: iterations + 1,
          readyToStream: false,
          inputClassification: classification,
        };
      }

      if (useStreamWithTools) {
        emitAgentEvent(state.session, 'assistant_message', 'llm', { content: result.content ?? '' });
        // Text was streamed inline via session._onStream — no second LLM call needed.
        const newMessages = iterations === 0
          ? [{ role: 'user', content: state.input }, result.message]
          : [result.message];
        return {
          response: null,
          pendingToolCalls: null,
          readyToStream: false,
          streamedInline: true,
          messages: newMessages,
          inputClassification: classification,
        };
      }

      // Fallback path (streamWithTools unavailable): hand off to runLine for streaming.
      state.session._onStep?.('Agent: streaming final answer…');
      if (typeof llm.stream === 'function') {
        return {
          response: null,
          pendingToolCalls: null,
          readyToStream: true,
          streamContext: { system, messages: conversationMessages },
        };
      }
      emitAgentEvent(state.session, 'assistant_message', 'llm', { content: result.content ?? '' });
      return {
        response: result.content ?? '',
        pendingToolCalls: null,
        readyToStream: false,
      };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      const message = err instanceof Error ? err.message : String(err);
      return { response: formatLlmUnavailableMessage(message), pendingToolCalls: null, readyToStream: false };
    }
  }

  async function toolExecutorNode(state) {
    const toolCalls = state.pendingToolCalls ?? [];
    const toolResultMessages = [];

    for (const call of toolCalls) {
      const resolved = resolveToolCallName(state.session.mcp, call.function.name, INTERNAL_TOOL_SERVERS);
      const { server, tool } = resolved;
      const argsSummary = summarizeToolArguments(call.function.arguments);
      const isInternalWikiTool = server === 'wiki' && (tool === 'plan_set' || tool === 'plan_done');
      const serverLabel = server === 'shell' ? 'Shell' : isInternalWikiTool ? 'Plan' : 'MCP';
      const toolName = server ? `${server}.${tool}` : call.function.name;
      if (resolved.normalized) {
        // Keep normalizations visible: the defensive routing must not hide
        // prompt/skill regressions that reintroduce unqualified names.
        state.session._onStep?.(
          `tool name normalized: ${call.function.name} -> ${server}__${tool}`,
        );
      }
      state.session._onStep?.(
        `[${state.toolIterations}/${MAX_TOOL_ITERATIONS}] ${serverLabel} ${toolName}${argsSummary ? ` (${argsSummary})` : ''}`,
      );
      emitAgentEvent(state.session, 'tool_call_started', 'tool', {
        callId: call.id,
        name: toolName,
        args: call.function.arguments ?? '{}',
        summary: argsSummary || 'calling...',
      });
      // Immediate visible plan for any MCP call that doesn't yet have an _activity plan.
      let minimalPlanActive = false;
      if (!isInternalWikiTool && server !== 'shell' && !state.session.headlessPlan) {
        minimalPlanActive = true;
        emitAgentEvent(state.session, 'plan_set', 'tool', {
          steps: [{ step: 1, id: null, description: toolName, status: 'running', _activityKey: null }],
        });
      }
      let resultText;
      let ok = true;
      try {
        if (!server) {
          if (resolved.candidates.length > 1) {
            throw new Error(
              `Ambiguous unqualified tool name "${call.function.name}": several connected servers expose it. `
              + `Use the <server>__<tool> form: ${resolved.candidates.map((s) => `${s}__${tool}`).join(', ')}.`,
            );
          }
          throw new Error(
            `Unqualified tool call name "${call.function.name}". Tool calls must use the <server>__<tool> `
            + `naming convention (e.g. production__production_start_job); no connected server exposes a tool named "${tool}".`,
          );
        }
        let args = JSON.parse(call.function.arguments ?? '{}');
        if (server === 'production' && tool === 'production_start_job' && state.session.workspace && !args.callerLabel) {
          args = { ...args, callerLabel: `${state.session.workspace}/wiki-manager` };
        }
        const runId = state.session._currentRunIdentity?.runId ?? null;
        if (isInternalWikiTool) {
          resultText = handleWikiTool(state.session, tool, args);
        } else if (server === 'shell' && tool === 'run_command') {
          await awaitRunApproval(state.session, { runId, tool: toolName });
          resultText = await runShellCommandTool(state.session, args.command);
        } else if (server === 'shell' && tool === 'read_command') {
          resultText = await runShellReadCommandTool(state.session, args.command);
        } else if (server === 'shell' && tool === 'profile_update') {
          const result = await updateWorkspaceProfilePreference(state.session, args.preference);
          resultText = JSON.stringify(result, null, 2);
        } else if (server !== 'shell') {
          await awaitRunApproval(state.session, { runId, tool: toolName });
          await awaitToolApproval(state.session, {
            runId,
            server,
            tool,
            args,
            callId: call.id,
          });
          if (server === 'production' && tool === 'production_start_job' && productionLockBusy(state.session)) {
            const item = enqueueProductionJob(state.session, args, 'production lock busy');
            resultText = buildQueuedResult(state.session, item);
            if (minimalPlanActive) {
              minimalPlanActive = false;
              emitAgentEvent(state.session, 'plan_step_updated', 'tool', { step: 1, status: 'pending' });
            }
          } else {
            args = withActiveWorkspaceForExternalTool(state.session, server, tool, args);
            const result = await callMcpTool(state.session.mcp, server, tool, args, state.session._abortSignal);
            resultText = formatMcpToolResult(result);
          }
        }
        if (server === 'production') {
          let payload = parseJsonText(resultText);
          if (tool === 'production_start_job' && payload?.ok === false && payload?.error === 'workspace_busy') {
            const item = enqueueProductionJob(state.session, args, 'workspace_busy');
            resultText = buildQueuedResult(state.session, item, payload.activeJobId ?? null);
            payload = parseJsonText(resultText);
            if (minimalPlanActive) {
              minimalPlanActive = false;
              emitAgentEvent(state.session, 'plan_step_updated', 'tool', { step: 1, status: 'pending' });
            }
          }
          const progressLabel = formatProductionProgress(payload);
          if (progressLabel) state.session._onStep?.(progressLabel);
          const activity = extractActivity(payload, { server, tool });
          if (activity) {
            emitAgentEvent(state.session, 'activity_upserted', 'tool', { activity });
          } else {
            rememberProductionProgress(state.session, payload, progressLabel);
          }
        } else if (!isInternalWikiTool && server !== 'shell') {
          const payload = parseJsonText(resultText);
          const activity = extractActivity(payload, { server, tool });
          if (activity) emitAgentEvent(state.session, 'activity_upserted', 'tool', { activity });
          const activityLabel = formatActivitySummary(server, tool, resultText);
          if (activityLabel) state.session._onStep?.(activityLabel);
        }
        // Minimal plan was not replaced by a real _activity plan — mark done.
        if (minimalPlanActive && state.session.headlessPlan?.[0]?._activityKey === null) {
          emitAgentEvent(state.session, 'plan_step_updated', 'tool', { step: 1, status: 'done' });
        }
      } catch (err) {
        if (
          (err.name === 'AbortError' && state.session._abortSignal?.aborted) ||
          err.name === 'ApprovalError'
        ) throw err;
        ok = false;
        resultText = `Error [${toolName}]: ${err instanceof Error ? err.message : String(err)}`;
        if (minimalPlanActive && state.session.headlessPlan?.[0]?._activityKey === null) {
          emitAgentEvent(state.session, 'plan_step_updated', 'tool', { step: 1, status: 'failed' });
        }
      }
      // Bound the result at its two exit points only (LLM context + display).
      // The full resultText above was already used for payload parsing and
      // _activity extraction, which must never see a truncated document.
      const boundedResult = truncateToolResult(resultText);
      emitAgentEvent(state.session, 'tool_call_result', 'tool', {
        callId: call.id,
        name: toolName,
        ok,
        result: boundedResult,
        summary: ok ? 'done' : 'failed',
      });
      toolResultMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: boundedResult,
      });
    }

    return {
      messages: toolResultMessages,
      pendingToolCalls: null,
    };
  }

  function routeOrchestrator(state) {
    if (state.pendingToolCalls?.length > 0) return 'tool_executor';
    return END;
  }

  const compiled = new StateGraph(AgentState)
    .addNode('orchestrator', orchestratorNode)
    .addNode('tool_executor', toolExecutorNode)
    .addEdge(START, 'orchestrator')
    .addConditionalEdges('orchestrator', routeOrchestrator)
    .addEdge('tool_executor', 'orchestrator')
    .compile();

  // LangGraph's default recursionLimit is 25 super-steps. Each tool round
  // costs two of them (orchestrator + tool_executor), so runs died with
  // GRAPH_RECURSION_LIMIT around iteration 12 — far below the intended
  // MAX_TOOL_ITERATIONS budget — before finishing their work (observed as
  // `knowledge.update — error 0%` with no production job ever created).
  // Bake a limit matching the iteration budget into every invocation.
  const recursionLimit = MAX_TOOL_ITERATIONS * 2 + 10;
  return {
    invoke: (state, config = {}) => compiled.invoke(state, { recursionLimit, ...config }),
  };
}
