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
import { capabilityRegistryForSession } from '../orchestrator/capabilityRegistry.js';
import { fetchRuntimeState, postRuntimeApprove, postRuntimeCancel, postRuntimeControl, postRuntimeDelegate, postRuntimeKill } from '../runtime/client.js';

const MAX_TOOL_ITERATIONS = 80;
const MAX_SPINNER_ARG_LENGTH = 96;
const MAX_PROFILE_CHARS = 4000;

// Pseudo-servers handled directly by the tool executor (not present in
// session.mcp). Listed so unqualified names like "plan_set" resolve the same
// way as MCP tools in resolveToolCallName.
const INTERNAL_TOOL_SERVERS = {
  wiki: ['plan_set', 'plan_done'],
  shell: ['run_command', 'read_command', 'profile_update'],
  runtime: ['kill', 'cancel', 'status', 'approve', 'enqueue', 'delegate'],
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
  'queue',
  'openui',
]);

const SHELL_RUN_COMMAND_TOOL = {
  type: 'function',
  function: {
    name: 'shell__run_command',
    description: [
      'Run a deterministic wiki-manager slash command inside the current shell session.',
      'Allowed commands: /workspace list, /workspace init <name> [path], /use <workspace>, /config, /status, /services, /skills, /skills show <name>, /skills run <name>, /upload <path>, /upload convert <id|pending>.',
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
      'Allowed commands: /help, /version, /config, /config list, /config status, /status, /services, /skills, /skills list, /skills show <name>, /queue.',
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

// Runtime control tools: Donna interprets the user's intent ("supprime le
// job et la queue", "arrête tout", "où en est le run") and ACTS through
// these, instead of a hardcoded regex classifier answering with canned text.
const RUNTIME_KILL_TOOL = {
  type: 'function',
  function: {
    name: 'runtime__kill',
    description: 'Hard-stop the workspace runtime: abort the active run, cancel its agent jobs, mark persisted runs interrupted and purge the control queue. Use when the user asks to remove/kill/clean the current run, its jobs or the queue.',
    parameters: { type: 'object', additionalProperties: false, properties: { runId: { type: 'string', description: 'Optional specific run id; omit to kill everything active in the workspace.' } } },
  },
};

const RUNTIME_CANCEL_TOOL = {
  type: 'function',
  function: {
    name: 'runtime__cancel',
    description: 'Soft-cancel the active runtime run (graceful abort, no queue purge). Use for "annule le run" when the user does not ask to clean everything.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
};

const RUNTIME_STATUS_TOOL = {
  type: 'function',
  function: {
    name: 'runtime__status',
    description: 'Read the runtime state: active run, plan steps, queue items, approvals. Use to answer questions about what is currently running or queued.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
};

const RUNTIME_APPROVE_TOOL = {
  type: 'function',
  function: {
    name: 'runtime__approve',
    description: 'Grant the pending approval of the active runtime run (mutating tasks wait on it). Use when the user consents in ANY phrasing: "vas-y", "ok pour l\'export", "approuve", "valide". Confirm what was approved.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
};

const RUNTIME_ENQUEUE_TOOL = {
  type: 'function',
  function: {
    name: 'runtime__enqueue',
    description: 'Queue a request to run AFTER the currently active runtime run finishes. Use when the user asks for a new action while a run is active and wants it done afterwards.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { input: { type: 'string', description: 'The request to execute after the current run, phrased as a complete instruction.' } },
      required: ['input'],
    },
  },
};

const RUNTIME_DELEGATE_TOOL = {
  type: 'function',
  function: {
    name: 'runtime__delegate',
    description: 'Delegate the user objective to the runtime. Pass the objective in natural language without choosing a capability, operation, agent, plan, file list, or implementation. The runtime resolves the agent, obtains and validates the real plan before accepting the run.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        objective: { type: 'string', description: 'The complete user objective, preserving scope and constraints but containing no invented technical identifiers.' },
      },
      required: ['objective'],
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
                  operation: { type: ['string', 'null'], description: 'Operation for the capability provider (e.g. ingest_plan, build).' },
                  arguments: { type: 'object', description: 'Arguments passed to the provider agent_execute for this step.' },
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
  allowedToolNames: Annotation(),
  inputClassification: Annotation(),
  readyToStream: Annotation(),
  streamContext: Annotation(),
  streamedInline: Annotation(),
  retryWithoutTool: Annotation({ default: () => false }),
  invalidResponseRetries: Annotation({ default: () => 0 }),
  invalidToolCallRetries: Annotation({ default: () => 0 }),
  forceDelegation: Annotation({ default: () => false }),
});

function invalidToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.filter((call) => {
    if (!call?.id || !call?.function?.name) return true;
    try {
      const args = JSON.parse(call.function.arguments || '{}');
      return !args || typeof args !== 'object' || Array.isArray(args);
    } catch {
      return true;
    }
  });
}

export function normalizeToolArgumentsFromSchema(args, parameters) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const schema = parameters && typeof parameters === 'object' ? parameters : {};
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === 'string') : [];
  const missing = required.filter((key) => args[key] === undefined);
  const unknown = Object.keys(args).filter((key) => properties[key] === undefined);
  if (missing.length !== 1 || unknown.length !== 1) return args;
  const target = missing[0];
  const source = unknown[0];
  if (!schemaValueMatches(args[source], properties[target])) return args;
  const normalized = { ...args, [target]: args[source] };
  delete normalized[source];
  return normalized;
}

function schemaValueMatches(value, propertySchema) {
  const types = Array.isArray(propertySchema?.type) ? propertySchema.type : [propertySchema?.type];
  if (types.includes(undefined) || types.includes(null)) return true;
  return types.some((type) => {
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'null') return value === null;
    return typeof value === type;
  });
}

function toolDefinitionForCall(session, callName) {
  const internal = [
    SHELL_RUN_COMMAND_TOOL,
    SHELL_READ_COMMAND_TOOL,
    SHELL_PROFILE_UPDATE_TOOL,
    RUNTIME_STATUS_TOOL,
    RUNTIME_CANCEL_TOOL,
    RUNTIME_KILL_TOOL,
    RUNTIME_APPROVE_TOOL,
    RUNTIME_ENQUEUE_TOOL,
    RUNTIME_DELEGATE_TOOL,
    WIKI_PLAN_SET_TOOL,
    WIKI_PLAN_DONE_TOOL,
  ];
  return [...internal, ...buildLlmTools(session?.mcp)]
    .find((item) => item?.function?.name === callName) ?? null;
}

function commandList(session) {
  return session.commands
    .filter((command) => AGENT_SLASH_COMMANDS.has(command))
    .map((command) => `/${command}`)
    .join(', ');
}

export function invalidSuggestedSlashCommands(content, session) {
  const allowed = new Set((session?.commands ?? []).filter((command) => AGENT_SLASH_COMMANDS.has(command)));
  const candidates = new Set();
  for (const line of String(content ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    const standalone = trimmed.match(/^\/([a-z][\w-]*)\b/i);
    if (standalone) candidates.add(standalone[1].toLowerCase());
    for (const match of line.matchAll(/`\/([a-z][\w-]*)\b/gi)) candidates.add(match[1].toLowerCase());
  }
  return [...candidates].filter((command) => !allowed.has(command)).sort();
}

export function invalidUserFacingToolNames(content, session) {
  const text = String(content ?? '');
  const connected = buildLlmTools(session?.mcp)
    .map((item) => item?.function?.name)
    .filter(Boolean)
    .filter((name) => text.includes(name));
  const syntactic = [...text.matchAll(/\b[a-z][a-z0-9_-]*__[a-z][a-z0-9_-]*\b/gi)].map((match) => match[0]);
  return [...new Set([...connected, ...syntactic])].sort();
}

async function classifyRequestedAction(llm, input, signal) {
  try {
    const result = await llm.completeWithTools({
      system: [
        'Classify whether the user explicitly requests a real state-changing action now.',
        'Actions include starting, stopping, importing, ingesting, building, exporting, configuring, writing, deleting, or sending.',
        'Questions, explanations, status questions, greetings, and hypothetical discussions are not actions.',
        'Return JSON only: {"action":true} or {"action":false}.',
      ].join('\n'),
      tools: [],
      messages: [{ role: 'user', content: String(input ?? '') }],
      signal,
    });
    const text = String(result?.content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(text)?.action === true;
  } catch {
    return false;
  }
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
    (command === 'skills' && ['', 'list', 'show'].includes(subcommand));
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
  const registry = capabilityRegistryForSession(session);
  const snapshot = typeof registry.snapshot === 'function' ? registry.snapshot() : registry;
  return [...new Set(Object.keys(snapshot ?? {}).map((key) => {
    const index = key.lastIndexOf('@');
    return index > 0 ? key.slice(0, index) : key;
  }))].sort();
}

// Deterministic fragment→plan mapping, shared by the agent_plan tool bridge
// and the /ingest-style direct capability runs: the parallel path must not
// depend on an LLM copying fields correctly.
export function planStepsFromFragment(payload) {
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  return tasks.map((task, index) => normalizeDeclaredPlanStep({
    id: task.id,
    description: task.label ?? task.id ?? `Task ${index + 1}`,
    requiredCapability: task.requiredCapability ?? payload.capability ?? null,
    operation: task.operation ?? null,
    arguments: task.arguments ?? {},
    dependsOn: task.dependsOn ?? [],
    outputRefs: (task.expectedOutputRefs ?? []).map((ref) => (ref && typeof ref === 'object' ? String(ref.ref ?? '') : String(ref))).filter(Boolean),
    groupId: task.groupId ?? null,
    dependsOnGroup: task.dependsOnGroup ?? null,
    parallelizable: task.parallelizable,
    barrier: task.barrier,
    locks: task.locks,
    requiresApproval: task.requiresApproval,
    approvalClass: task.approvalClass,
    approvalSummary: task.approvalSummary,
    idempotencyKey: task.idempotencyKey,
    progressWeight: task.progressWeight,
    recommendedConcurrency: task.recommendedConcurrency,
  }, index));
}

async function handleRuntimeControlTool(session, tool, args = {}) {
  const url = session.runtime?.url ?? null;
  if (!url) return 'Runtime not connected: no runtime URL available in this session.';
  const workspace = session.workspace ?? null;
  try {
    if (tool === 'kill') {
      const result = await postRuntimeKill({ url, workspace, runId: args.runId ?? null });
      return `Runtime killed: ${result.runs ?? 0} run(s) interrupted, ${result.tasks ?? 0} task(s) cancelled, ${result.queued ?? 0} queued control request(s) purged.`;
    }
    if (tool === 'cancel') {
      const result = await postRuntimeCancel({ url, workspace });
      return result.cancelled ? 'Runtime run cancellation requested.' : `No active run to cancel${result.reason ? ` (${result.reason})` : ''}.`;
    }
    if (tool === 'approve') {
      const state = await fetchRuntimeState({ url, workspace });
      const pending = (Array.isArray(state?.approvals) ? state.approvals : [])
        .filter((approval) => approval.status === 'pending_approval');
      const runId = state?.runId
        ?? state?.runs?.find((run) => ['running', 'pending_approval'].includes(run.status))?.id
        ?? null;
      if (!runId || pending.length === 0) return 'No pending approval found.';
      const approvalClasses = [...new Set(pending.flatMap((approval) => {
        const value = approval.approvalClasses ?? approval.approvalClass ?? [];
        return Array.isArray(value) ? value : [value];
      }).map(String).filter(Boolean))];
      const result = await postRuntimeApprove({
        url,
        workspace,
        runId,
        scope: 'run',
        planRevision: state?.planRevision ?? null,
        approvalClasses: approvalClasses.length > 0 ? approvalClasses : ['default'],
      });
      return result?.approved ? 'Current validated plan approved.' : 'No pending approval found.';
    }
    if (tool === 'delegate') {
      const objective = String(args.objective ?? '').trim();
      if (!objective) return 'Delegation rejected: missing objective.';
      const result = await postRuntimeDelegate(objective, { url, workspace });
      return result?.runId
        ? `Action lancée (${String(result.runId).slice(0, 8)}) après validation du plan réel : ${result.delegation?.tasks ?? 0} tâche(s), ${result.delegation?.agent ?? 'agent résolu'}. Exécution en cours.`
        : `Délégation refusée : ${result?.error ?? JSON.stringify(result)}`;
    }
    if (tool === 'enqueue') {
      const result = await postRuntimeControl('message', { url, workspace, input: String(args.input ?? ''), intent: 'enqueue' });
      return String(result?.explanation ?? 'Request queued for after the current run.');
    }
    if (tool === 'status') {
      const state = await fetchRuntimeState({ url, workspace });
      const plan = Array.isArray(state?.plan) ? state.plan : [];
      const queue = Array.isArray(state?.queue) ? state.queue : [];
      const controlQueue = Array.isArray(state?.controlQueue) ? state.controlQueue : [];
      return JSON.stringify({
        status: state?.status ?? 'unknown',
        running: Boolean(state?.running),
        runId: state?.runId ?? null,
        plan: plan.map((step) => ({ id: step.id ?? step.step, description: step.description, status: step.status })),
        queue: queue.map((item) => ({ id: item.id, status: item.status, tool: item.tool ?? item.type ?? null })),
        controlQueue: controlQueue.filter((item) => item.status === 'queued').map((item) => ({ id: item.id, input: item.input })),
        pendingApprovals: (Array.isArray(state?.approvals) ? state.approvals : [])
          .filter((approval) => approval.status === 'pending_approval')
          .map((approval) => ({ id: approval.id, reason: approval.reason ?? null })),
      }, null, 2);
    }
    return `Unknown runtime tool: ${tool}`;
  } catch (err) {
    return `Runtime control error (${tool}): ${err instanceof Error ? err.message : String(err)}`;
  }
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
    // Execution fields the deterministic dispatcher consumes (agent_execute):
    // without them a capability step cannot actually run.
    ...(item.operation != null ? { operation: String(item.operation) } : {}),
    ...(item.arguments && typeof item.arguments === 'object' ? { arguments: item.arguments } : {}),
    ...(item.groupId != null ? { groupId: String(item.groupId) } : {}),
    ...(item.dependsOnGroup != null ? { dependsOnGroup: String(item.dependsOnGroup) } : {}),
    ...(item.parallelizable != null ? { parallelizable: Boolean(item.parallelizable) } : {}),
    ...(item.barrier ? { barrier: true } : {}),
    ...(item.locks ? { locks: item.locks } : {}),
    ...(item.requiresApproval != null ? { requiresApproval: Boolean(item.requiresApproval) } : {}),
    ...(item.approvalClass ? { approvalClass: String(item.approvalClass) } : {}),
    ...(item.approvalSummary ? { approvalSummary: String(item.approvalSummary) } : {}),
    ...(item.idempotencyKey ? { idempotencyKey: String(item.idempotencyKey) } : {}),
    ...(item.progressWeight != null ? { progressWeight: Number(item.progressWeight) } : {}),
    ...(item.recommendedConcurrency != null ? { recommendedConcurrency: Number(item.recommendedConcurrency) } : {}),
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
  // Advertise only the read-only tools Donna may call directly. Listing
  // mutating provider tools (e.g. production__production_start_job) here teaches
  // a capable model to invoke them directly and bypass runtime__delegate.
  const mcpTools = formatMcpToolsForAgent(state.session.mcp, {
    include: (qualifiedName) => !isOrchestrationBypassTool(qualifiedName),
  });
  const skills = formatSkillsForAgent(state.session);
  const customPrompt = state.session.systemPrompt ?? null;
  const workspaceProfile = loadWorkspaceProfile(state.session.workspacePath);

  const agentContext = [
    'You are Donna: first and foremost a warm, helpful assistant for the llm-wiki-manager team, who also happens to orchestrate the workspace behind the scenes. Orchestration is how you help — it is not your personality. Speak like an attentive human colleague: natural, friendly, plain-spoken. Never sound like a raw status dump or a machine reciting fields.',
    'The shell is agent-first: every input without a leading slash is routed to you.',
    'Default to a plain conversational reply with no tool call. Only call a tool, create a plan, or start a job when the user\'s message clearly requests an action (ingest, build, export, configure, run a skill, check a concrete status, etc.). Greetings, small talk, thanks, and general questions do not warrant starting a job or calling a tool — just answer in text.',
    'Commands starting with / are deterministic primitives. You may run a safe subset through shell__run_command.',
    `Reply language: ${language}.`,
    `Current workspace: ${workspace}.`,
    `Current wikirc profile: ${wikirc}.`,
    `Available primitives: ${commandList(state.session)}.`,
    'Only announce or call slash commands that appear exactly in Available primitives. Do not invent command names, subcommands, or arguments.',
    'Connected MCP tools you may call directly (server__tool naming convention) — reads AND single-step actions like configuring or adding a connector source, converting a document, sending, or searching. Only the heavy multi-step operations (ingest, build, export, polish, pipeline) go through runtime__delegate to get their parallel plan. Everything listed below is directly callable:',
    mcpTools,
    'Current local MCP job queue:',
    formatQueue(state.session),
    'Available skills:',
    skills,
    'In interactive agent mode you may call only the read-only tools and runtime control/delegation tools actually provided to you.',
    'When the user asks for an action that can be performed with connected MCP tools or safe primitives, do not answer with future intent such as "I will call...", "I am going to run...", or "launching..." unless you also call the tool in the same turn. Either call the tool now, ask for the exact missing required arguments, or explain the concrete blocker.',
    'Execution truthfulness: never invent a job id, status, percentage, duration, generated file, file content, URL, command, or tool result. An action is executed only when you call an available tool and receive its result. Examples and placeholders are forbidden in execution reports.',
    'After any completed action, give a short factual summary based only on the tool result: outcome and concrete outputs or references actually returned. Mention a viewing primitive only when it exists in Available primitives and is relevant. Never invent results, interpret generated content beyond what the tool returned, or fabricate a verification checklist.',
    'You are in AGENT mode, so you can actually act. You MAY close with ONE short, natural follow-up — a single sentence phrased as an offer, and only when it genuinely helps and is an action you can perform right here (delegate it or call a tool), e.g. "Want me to start ingesting these pages?" (phrased in the reply language). This is what makes you feel like an assistant rather than a readout. Only offer what you can truly do in agent mode — never an offer that would require another mode. Keep it to that one line: never produce a "Next steps"/"Prochaines étapes"/"À suivre" list, a checklist, an options menu, or commands for the user to type. If nothing useful naturally follows, simply stop after the answer — do not pad.',
    'When calling a tool, emit no preliminary narration. Call it directly; the PLAN and Activity panels show progress. After completion, keep the final response concise and proportional to the result.',
    'Write the way a thoughtful colleague speaks: warm, plain, and to the point. For a simple factual question, 1 to 3 sentences is the sweet spot. Stay synthetic and information-dense — use only the lines needed, and never exceed roughly 15 to 20 short lines even for a detailed answer. Never expose internal reasoning, repeated checks, tool-selection commentary, or a chronological diary. Prioritize the result, essential facts, concrete errors, and actual outputs — but say them in human language, not as a field dump.',
    'Only the heavy multi-step operations — ingest, build, export, polish, pipeline — are delegated via runtime__delegate (for their DAG and parallelism). Single-step actions — configuring or adding a connector source, converting a document, sending, searching — are called directly on the connected tool. Never call an agent orchestration-contract or plan tool directly.',
    'For any question about the current workspace inventory or what is waiting there, call wiki__wiki_workspace_status first and answer only from its result. This is the canonical read-only workspace state; do not reconstruct it from upload, connector, or production tools.',
    'Tool identifiers are private implementation details. Never print MCP tool names such as server__tool in a user-facing answer. Describe the human result instead.',
    'Internal data shapes are private too. Never quote raw JSON field names (e.g. pendingSources.files), internal directory paths (e.g. raw/untracked/), or config keys in a user-facing answer — translate them into plain language. Say "36 pages sources sont en attente d\'ingestion", not the field or path they came from.',
    'Never suggest a manual filesystem command or implementation workaround unless the user explicitly asks for manual instructions. For an action request, delegate the objective and let the specialized agent determine paths and operations from its live contract.',
    'Skills are documentation only in this stabilized version. Never execute a skill from conversation; delegate the user objective.',
    'For service actions, recommend only available service primitives from Available primitives, with the exact service name when the primitive supports one.',
    'Scope discipline: execute ONLY the action(s) the user explicitly requested. Never chain additional mutating operations (ingest, build, export, polish, delete, send…) that the user did not ask for — even when diagnostics or recommendations suggest them. Finish with the requested result and stop. Example: "applique les recommandations de config" means apply the config; it does NOT authorize launching the ingest those recommendations mention.',
    state.session.runtime?.url
      ? 'The runtime is connected and runtime__delegate is bound and available to you right now — it is a tool you call directly, not a slash command or a missing primitive. It is the ONLY way to execute an action (ingest, build, export, configure, send…). Never tell the user that delegation or the runtime is unavailable while it is connected; call runtime__delegate instead.'
      : 'No runtime is connected, so you cannot execute actions. State that plainly and name the runtime connection as the missing capability — do not invent a workaround.',
    'If the connector or service needed for a requested read or action is absent from the Connected MCP tools above (its service is not running — e.g. CME, documents, or production), say plainly that this service is not connected and name it as the missing capability. Never redirect a simple read (e.g. "give me the CME config") to an "agent action", never invent its result, and never propose a workaround. Only requests you can actually serve with a listed tool are answered with data.',
    'For any requested action, call runtime__delegate with the user objective only. Never choose a capability, operation, agent, plan, or implementation yourself. The runtime resolves the registry and validates the provider plan before accepting. Never call <provider>__agent_plan, <provider>__agent_execute, legacy production__production_start_job, wiki__plan_set, or wiki__plan_done from interactive chat.',
    'Do not ask the user which sources, files, connectors, or templates to use for an ingest, build, or export: the specialized agent discovers them from the workspace. When the objective is clear (e.g. "lance une ingestion"), delegate it as stated, without a clarifying question.',
    'Promise only what the resolved capability actually exposes in its declared contract (the input schema the specialized agent publishes for that capability). When the user requests an execution parameter — a batch or chunk size, a count "N at a time", concurrency, ordering, priority, or any tuning knob — apply it only if that parameter exists in the target capability\'s published input schema. Otherwise do not confirm or promise it: delegate the objective, and if the user explicitly asked for that parameter, say plainly in one line that you started the work but do not control that aspect (the runtime and the specialized agent decide it). Never state or imply a parameter was applied when the agent contract cannot enforce it.',
    'If runtime__delegate returns a blocker or no specialized provider is available, report only that concrete blocker concisely. Never replace the missing execution path with a suggested slash command, skill, MCP tool name, manual file move, administrator escalation, or alternative workflow unless the user explicitly asks for alternatives.',
    'For workspace inventory and page listings, use the connected wiki MCP read tools. Never invent or call a /wiki shell command through shell__run_command. Use /workspace init <name> [path] for low-level non-interactive workspace creation; in the interactive TUI, /new <name> opens the setup wizard.',
    'If an action requires tools or skills not available yet, explain the limitation and name the expected primitive.',
    workspaceProfile
      ? `Workspace profile (.wiki/profile.md) — durable user preferences, apply these to every reply (tone, tutoiement/vouvoiement, formatting, etc.):\n${workspaceProfile}`
      : null,
    'Runtime control: you have runtime__status, runtime__cancel, runtime__kill, runtime__approve and runtime__enqueue. When the user asks to stop, remove, clean or kill the current run, its jobs or the queue ("supprime le job et la queue", "arr\u00eate tout"), call runtime__kill (or runtime__cancel for a soft stop of just the run) and confirm what was stopped. For questions about what is running or queued, call runtime__status and answer from its data. When the user consents to a pending approval in any phrasing ("vas-y", "ok pour l\'export"), call runtime__approve. When the user asks for a NEW action while a run is active, do not execute it: propose runtime__enqueue (run it after) or, if they insist it replaces the current work, runtime__kill then the new action.',
    'Report every runtime control outcome exactly as the tool returned it \u2014 never embellish. If runtime__kill reports 0 run(s)/0 task(s)/0 purged, say there was nothing active to stop or purge; do NOT claim a run, plan, pending approval or queue item was removed. If runtime__status returns an error or could not be read, say the runtime state could not be retrieved and do not describe a state you never obtained. Never assert that something was cleaned, cancelled, approved or purged unless that specific tool result confirms it.',
    'Durable profile updates are actions in this stabilized version: delegate them instead of writing directly.',
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

function toolsForClassification(classification, writeTools, session = null) {
  const controlTools = session?.runtime?.url
    ? [RUNTIME_STATUS_TOOL, RUNTIME_CANCEL_TOOL, RUNTIME_KILL_TOOL, RUNTIME_APPROVE_TOOL, RUNTIME_ENQUEUE_TOOL]
    : [];
  // Provider discovery and validation belong to the runtime. Hiding
  // delegation while the shell snapshot is temporarily empty forced Donna
  // to invent commands instead of submitting the objective.
  const capabilityRunTools = session?.runtime?.url && !classification.activeRun
    ? [RUNTIME_DELEGATE_TOOL]
    : [];
  if (classification.activeRun) {
    // During an active run Donna gets read + profile + the runtime control
    // suite: she can answer, approve, enqueue for later, soft-cancel or
    // kill — but she must not fire new MCP jobs alongside the run (that is
    // what runtime__enqueue is for). No canned regex answers anywhere.
    return [SHELL_READ_COMMAND_TOOL, ...controlTools];
  }
  if (session?.runtime?.url) {
    // Offer every connected tool directly EXCEPT orchestration-bypass tools
    // and raw shell write/profile mutation. Reads, configuration, connector
    // setup — and any newly added MCP's tools — stay directly callable.
    const directTools = writeTools.filter((item) => {
      const name = item?.function?.name;
      if (!name || name === 'shell__run_command' || name === 'shell__profile_update') return false;
      return !isOrchestrationBypassTool(name);
    });
    return [SHELL_READ_COMMAND_TOOL, ...controlTools, ...capabilityRunTools, ...directTools];
  }
  return [SHELL_READ_COMMAND_TOOL, ...controlTools, ...capabilityRunTools, ...writeTools];
}

export function isDonnaReadTool(item) {
  const name = String(item?.function?.name ?? '');
  if (!name || name.startsWith('shell__') || name === 'wiki__plan_set' || name === 'wiki__plan_done') return false;
  if (item?.readOnly === true) return true;
  const tool = name.includes('__') ? name.slice(name.indexOf('__') + 2) : name;
  return tool === 'wiki_workspace_status'
    || tool === 'agent_describe'
    || tool === 'agent_status'
    || /(?:^|_)(?:status|list|search|read|get)$/.test(tool);
}

// Two-tier tool policy. Donna may call any connected MCP tool directly
// (reads AND plain writes: cme_setup, connector setup, document conversion,
// send, search, and anything a newly added MCP exposes) EXCEPT the small set
// that must go through the runtime's orchestration: the universal five-tool
// contract executors (agent_plan/agent_execute), the legacy job starter, and
// direct plan mutation. Heavy multi-step work (ingest/build/export via the
// production agent) is delegated for its DAG/parallelism; plain single-step
// tools are called directly. This is a blocklist, not a whitelist, so adding a
// new MCP never silently disables its tools.
function isOrchestrationBypassTool(name) {
  const full = String(name ?? '');
  if (!full) return true;
  if (full === 'wiki__plan_set' || full === 'wiki__plan_done') return true;
  const sep = full.indexOf('__');
  const tool = sep === -1 ? full : full.slice(sep + 2);
  return tool === 'agent_plan' || tool === 'agent_execute' || tool === 'production_start_job';
}

function isReadOnlyMcpCall(session, server, tool) {
  const descriptor = (session?.mcp?.[server]?.tools ?? [])
    .find((item) => String(item?.name ?? '') === tool || String(item?.name ?? '').endsWith(`__${tool}`));
  return isDonnaReadTool({
    function: { name: `${server}__${tool}` },
    readOnly: descriptor?.readOnly === true,
  });
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
        : {
            kind: 'agent_turn',
            confidence: 1,
            reason: 'agent_mode_llm_decision',
            activeRun: state.session?.agentProjection?.status === 'running'
              || sessionActivities(state.session).some((activity) => !activity.terminal),
          })
      : (state.inputClassification ?? { kind: 'modify_run', confidence: 1, reason: 'tool_iteration' });
    if (iterations === 0) {
      state.session._onStep?.(`Agent: classified input as ${classification.kind}`);
      emitAgentEvent(state.session, 'control_message_received', 'agent_classifier', {
        input: state.input,
        classification,
      });
    }

    const writeTools = [
      SHELL_RUN_COMMAND_TOOL,
      SHELL_PROFILE_UPDATE_TOOL,
      WIKI_PLAN_SET_TOOL,
      WIKI_PLAN_DONE_TOOL,
      ...buildLlmTools(state.session.mcp),
    ];
    const tools = toolsForClassification(classification, writeTools, state.session);
    const system = buildAgentSystemPrompt(state);

    // On iteration 0: prior history is in state.messages, user input must be appended.
    // On subsequent iterations: user message was already stored in state.messages by the
    // iteration-0 return below, so use state.messages as-is.
    const conversationMessages = iterations === 0
      ? [...(state.messages ?? []), { role: 'user', content: state.input }]
      : (state.messages ?? []);

    try {
      const useStreamWithTools = typeof llm.streamWithTools === 'function';
      const toolChoice = state.forceDelegation
        ? { type: 'function', function: { name: 'runtime__delegate' } }
        : 'auto';
      const result = useStreamWithTools
        ? await llm.streamWithTools({
            system,
            tools,
            messages: conversationMessages,
            toolChoice,
            // Buffer until validation. Invalid commands and malformed tool
            // calls must never flash hundreds of lines before disappearing.
            onTextDelta: () => {},
            signal: state.session._abortSignal,
          })
        : await llm.completeWithTools({
            system,
            tools,
            messages: conversationMessages,
            toolChoice,
            signal: state.session._abortSignal,
          });

      if (result.tool_calls?.length > 0) {
        state.session._onStreamReset?.();
        const malformed = invalidToolCalls(result.tool_calls);
        if (malformed.length > 0) {
          const retries = Number(state.invalidToolCallRetries ?? 0);
          if (retries < 2) {
            state.session._onStep?.('Agent: malformed tool call rejected; retrying…');
            return {
              pendingToolCalls: null,
              messages: [
                ...(iterations === 0 ? [{ role: 'user', content: state.input }] : []),
                {
                  role: 'user',
                  content: 'Your previous tool call was incomplete or contained invalid JSON arguments. Call the appropriate available tool again with one complete valid JSON object. Do not narrate or reproduce the broken call.',
                },
              ],
              toolIterations: iterations + 1,
              readyToStream: false,
              inputClassification: classification,
              invalidToolCallRetries: retries + 1,
            };
          }
          const failure = 'Action non exécutée : l’appel d’outil généré par le modèle était incomplet.';
          emitAgentEvent(state.session, 'assistant_message', 'agent_guard', { content: failure });
          return { response: failure, pendingToolCalls: null, readyToStream: false };
        }
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
          allowedToolNames: tools.map((item) => item?.function?.name).filter(Boolean),
          messages: newMessages,
          toolIterations: iterations + 1,
          readyToStream: false,
          inputClassification: classification,
          retryWithoutTool: false,
        };
      }

      if (runtimeExecution && iterations === 0 && !state.retryWithoutTool) {
        state.session._onStreamReset?.();
        state.session._onStep?.('Agent: action response rejected — no tool was called; retrying…');
        return {
          pendingToolCalls: null,
          messages: [
            { role: 'user', content: state.input },
            result.message ?? { role: 'assistant', content: result.content ?? '' },
            {
              role: 'user',
              content: 'Your previous response did not execute the requested action because it called no tool. Do not narrate or simulate execution. Call the appropriate available tool now. Never invent results.',
            },
          ],
          toolIterations: 1,
          readyToStream: false,
          inputClassification: classification,
          retryWithoutTool: true,
        };
      }

      const canDelegate = tools.some((item) => item?.function?.name === 'runtime__delegate');
      if (!runtimeExecution && iterations === 0 && canDelegate && !state.retryWithoutTool
        && await classifyRequestedAction(llm, state.input, state.session._abortSignal)) {
        state.session._onStreamReset?.();
        state.session._onStep?.('Agent: action response rejected — delegation required; retrying…');
        return {
          pendingToolCalls: null,
          messages: [
            { role: 'user', content: state.input },
            result.message ?? { role: 'assistant', content: result.content ?? '' },
            { role: 'user', content: 'This is an action request. Call runtime__delegate now with the original objective only. Do not provide instructions or narration.' },
          ],
          toolIterations: 1,
          readyToStream: false,
          inputClassification: classification,
          retryWithoutTool: true,
          forceDelegation: true,
        };
      }

      if (runtimeExecution && state.retryWithoutTool) {
        state.session._onStreamReset?.();
        const failure = 'Action non exécutée : Donna n’a appelé aucun outil disponible. Aucun job ni résultat n’a été créé.';
        emitAgentEvent(state.session, 'assistant_message', 'agent_guard', { content: failure });
        return {
          response: failure,
          pendingToolCalls: null,
          readyToStream: false,
          retryWithoutTool: false,
        };
      }

      const invalidCommands = invalidSuggestedSlashCommands(result.content, state.session);
      const leakedTools = invalidUserFacingToolNames(result.content, state.session);
      if (invalidCommands.length > 0 || leakedTools.length > 0) {
        state.session._onStreamReset?.();
        const retries = Number(state.invalidResponseRetries ?? 0);
        if (retries < 2) {
          const canDelegate = tools.some((item) => item?.function?.name === 'runtime__delegate');
          state.session._onStep?.('Agent: invalid user-facing implementation detail rejected; retrying…');
          return {
            pendingToolCalls: null,
            messages: [
              ...(iterations === 0 ? [{ role: 'user', content: state.input }] : []),
              result.message ?? { role: 'assistant', content: result.content ?? '' },
              {
                role: 'user',
                content: [
                  'Rewrite the answer for the end user without internal MCP tool identifiers or unsolicited shell commands.',
                  invalidCommands.length > 0 ? `Unavailable slash commands: /${invalidCommands.join(', /')}.` : null,
                  leakedTools.length > 0 ? 'Do not print tool names; use them internally if needed.' : null,
                  'If the user requested an action and runtime delegation is available, call runtime__delegate instead of giving manual instructions.',
                ].filter(Boolean).join(' '),
              },
            ],
            toolIterations: iterations + 1,
            readyToStream: false,
            inputClassification: classification,
            invalidResponseRetries: retries + 1,
            forceDelegation: canDelegate,
          };
        }
        const failure = 'Réponse rejetée : Donna a exposé une instruction interne ou une procédure manuelle incorrecte.';
        emitAgentEvent(state.session, 'assistant_message', 'agent_guard', { content: failure });
        return { response: failure, pendingToolCalls: null, readyToStream: false };
      }

      if (useStreamWithTools) {
        if (result.content) state.session._onStream?.(result.content);
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
      // Hard guardrail: only execute tools that were actually offered this turn
      // (read-only tools + runtime controls + delegate). A capable model that
      // spots a mutating provider tool in the prompt and calls it directly must
      // be refused and steered back to runtime__delegate — this is what keeps
      // the orchestration capability-driven regardless of model strength.
      // Only interactive turns are constrained. Inside a runtime run
      // (_currentRunIdentity set) the graph legitimately executes the
      // already-validated, already-approved delegated task via provider tools.
      const runtimeExecutionTurn = Boolean(state.session._currentRunIdentity);
      const allowedNames = !runtimeExecutionTurn && Array.isArray(state.allowedToolNames) ? state.allowedToolNames : null;
      const isInternalCall = server === 'shell' || server === 'runtime' || isInternalWikiTool;
      if (allowedNames && server && !isInternalCall && !allowedNames.includes(`${server}__${tool}`)) {
        const refusal = `${server}__${tool} is not available in interactive mode. Do not call provider tools directly. For any action or mutation, call runtime__delegate with the user objective; only read-only tools and runtime controls may be called directly.`;
        state.session._onStep?.(`tool call refused (not offered): ${server}__${tool}`);
        emitAgentEvent(state.session, 'tool_call_result', 'tool', {
          callId: call.id, name: toolName, ok: false, result: refusal, summary: 'refused',
        });
        toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: refusal });
        continue;
      }
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
      // A plan represents work, never observation. Read-only inventory/status
      // calls stay out of Plan even when Donna uses them to answer a question.
      let minimalPlanActive = false;
      if (!isInternalWikiTool && server !== 'shell' && server !== 'runtime'
        && !isReadOnlyMcpCall(state.session, server, tool) && !state.session.headlessPlan) {
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
        const definition = toolDefinitionForCall(state.session, call.function.name);
        args = normalizeToolArgumentsFromSchema(args, definition?.function?.parameters);
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
        } else if (server === 'runtime') {
          resultText = await handleRuntimeControlTool(state.session, tool, args);
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
        {
          const payload = parseJsonText(resultText);
          // agent_plan (any provider) returned a task-graph fragment: declare it as
          // the plan DETERMINISTICALLY. Asking the LLM to copy N tasks into
          // wiki__plan_set would lose fields (a small local model dropped
          // arguments/operations in testing) — the shell does the mapping.
          if (/(^|__)agent_plan$/.test(tool) && Array.isArray(payload?.tasks) && payload.tasks.length > 0) {
            const steps = planStepsFromFragment(payload);
            emitAgentEvent(state.session, 'plan_set', 'tool', { steps });
            state.session._onStep?.(`Plan: ${steps.length} task(s) declared from ${server} fragment`);
            resultText = `Task-graph fragment integrated as the current plan (${steps.length} task(s), groups: ${[...new Set(payload.tasks.map((task) => task.groupId).filter(Boolean))].join(', ') || 'none'}). The orchestrator will dispatch these tasks — do NOT call production tools for them yourself. Reply with a short summary and wait.`;
          }
          if (/(^|__)agent_plan$/.test(tool) && Array.isArray(payload?.tasks) && payload.tasks.length > 0) {
            minimalPlanActive = false;
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
      forceDelegation: false,
      invalidToolCallRetries: 0,
      invalidResponseRetries: 0,
    };
  }

  function routeOrchestrator(state) {
    if (state.pendingToolCalls?.length > 0) return 'tool_executor';
    if (state.retryWithoutTool) return 'orchestrator';
    if (state.invalidToolCallRetries > 0 && state.response == null && !state.streamedInline) return 'orchestrator';
    if (state.invalidResponseRetries > 0 && state.response == null && !state.streamedInline) return 'orchestrator';
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
