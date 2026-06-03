import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import {
  buildLlmTools,
  callMcpTool,
  formatMcpToolResult,
  formatMcpToolsForAgent,
  parseToolCallName,
} from '../core/mcp.js';
import { formatSkillsForAgent } from '../core/skills.js';
import { handleSlashCommand } from '../commands/slash.js';
import { formatActivitySummary } from '../core/activity.js';

const MAX_TOOL_ITERATIONS = 25;
const MAX_SPINNER_ARG_LENGTH = 96;
const AGENT_SLASH_COMMANDS = new Set([
  'help',
  'version',
  'workspaces',
  'new',
  'workspace',
  'use',
  'config',
  'status',
  'services',
  'skills',
  'show-skill',
  'run-skill',
  'skill',
]);

const SHELL_RUN_COMMAND_TOOL = {
  type: 'function',
  function: {
    name: 'shell__run_command',
    description: [
      'Run a deterministic wiki-manager slash command inside the current shell session.',
      'Allowed commands: /workspaces, /new <name> [path], /use <workspace>, /config, /status, /services, /skills, /show-skill <name>, /run-skill <name>.',
      'Do not use for arbitrary system shell commands, /mcp call, /wiki run, /start, /stop, /logs, or /exit.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: {
          type: 'string',
          description: 'Slash command to run, for example "/workspaces", "/new demo", or "/use juno".',
        },
      },
      required: ['command'],
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
  readyToStream: Annotation(),
  streamContext: Annotation(),
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

function parseJsonToolResult(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
    progress?.currentStep ?? job?.type,
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
  if (command === 'new' && parts.length < 2) {
    throw new Error('Usage: /new <name> [path].');
  }
  if (command === 'workspace' && parts[1] !== 'init') {
    throw new Error('Only /workspace init is available to the agent.');
  }
  if (command === 'skill' && !['show', 'run'].includes(parts[1] ?? 'show')) {
    throw new Error('Use /show-skill <name> or /run-skill <name>. Legacy /skill show|run is also accepted.');
  }
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

export function buildAgentSystemPrompt(state) {
  const workspace = state.session.workspace ?? 'no workspace selected';
  const wikirc = state.session.wikirc?.profile ?? 'no profile loaded';
  const language = state.session.language ?? 'en-US';
  const mcpTools = formatMcpToolsForAgent(state.session.mcp);
  const skills = formatSkillsForAgent(state.session);
  const customPrompt = state.session.systemPrompt ?? null;

  const agentContext = [
    'You are dot, the terminal orchestrator agent for llm-wiki-manager.',
    'The shell is agent-first: every input without a leading slash is routed to you.',
    'Commands starting with / are deterministic primitives. You may run a safe subset through shell__run_command.',
    `Reply language: ${language}.`,
    `Current workspace: ${workspace}.`,
    `Current wikirc profile: ${wikirc}.`,
    `Available primitives: ${commandList(state.session)}.`,
    'Connected MCP tools (use the server__tool naming convention for tool calls):',
    mcpTools,
    'Available skills:',
    skills,
    'You can call MCP tools directly using the provided tool functions.',
    'You can call shell__run_command for safe manager slash commands such as /workspaces, /new <name> [path], /use <workspace>, /config, /status, /services, /skills, /show-skill <name>, and /run-skill <name>.',
    'Skills are workflow instructions, not executable code. When a user asks to run a skill, inspect it, propose the concrete primitive/tool plan, and ask for confirmation before costly or mutating actions.',
    state.session.headless ? 'Headless mode is active: execute the requested skill or task using available safe primitives and MCP tools, do not ask for interactive confirmation unless the request is ambiguous or outside the loaded workspace.' : null,
    'For service actions, recommend /services, /start, /stop or /logs with the exact service name.',
    'Disambiguate export requests carefully.',
    'Confluence/CME/source export means exporting external Confluence sources into raw/untracked: use cme MCP tools (`cme_export_run`, then `cme_export_status`). Never use production `type=export` for Confluence source export.',
    'Wiki/deliverable/publication export means exporting generated deliverables from the wiki: use production MCP tools (`production_start_job` with `type:"export"` or pipeline steps). Require the deliverable path when exporting deliverables.',
    'For ingest/build/export/polish/pipeline workflows, use production MCP tools. Do not route these through direct /wiki shortcuts. To chain multiple sequential steps (e.g. build then polish), always use a single production_start_job call with type="pipeline" and steps=["build","polish"] — never start them as separate jobs: the first job is asynchronous and the second would run before it completes. Do not ask the user to confirm between steps; start the pipeline call directly.',
    'For diagnostics, use /wiki run doctor when the user asks for doctor. Use /new <name> [path] to create/configure a new workspace. Use /wiki for index, or /wiki run index through the explicit backup hatch. Use /wiki run init only for explicit current-workspace llm-wiki init.',
    'If an action requires tools or skills not available yet, explain the limitation and name the expected primitive.',
  ].join('\n');

  return customPrompt ? `${customPrompt}\n\n${agentContext}` : agentContext;
}

export function buildLimitedAgentResponse(state, reason = 'no workspace loaded with .wikirc.yaml') {
  const workspace = state.session.workspace ?? 'no workspace selected';
  const wikirc = state.session.wikirc?.profile ?? 'no profile loaded';
  const language = state.session.language ?? 'en-US';
  if (language.toLowerCase().startsWith('fr')) {
    return [
      `dot est active. Workspace courant: ${workspace}.`,
      `Profil wikirc courant: ${wikirc}.`,
      '',
      "Je suis deja la boucle principale du shell: les entrees sans `/` passent par ce graphe LangGraph.",
      `Connexion LLM: mode limite (${reason}).`,
      `Primitives disponibles maintenant: ${commandList(state.session)}.`,
      '',
      'Outils MCP connectes:',
      formatMcpToolsForAgent(state.session.mcp),
      '',
      'Mode limite: workspace, Docker Compose, appels MCP, echappatoire /wiki, decouverte skills et mode headless sont branches.',
      "Utilise `/help` pour voir les commandes deterministes disponibles.",
    ].join('\n');
  }
  return [
    `dot is active. Current workspace: ${workspace}.`,
    `Current wikirc profile: ${wikirc}.`,
    '',
    'I am already the shell main loop: inputs without `/` are routed through this LangGraph graph.',
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

export function createAgentGraph(options = {}) {
  async function orchestratorNode(state) {
    const llm = state.session.llm ?? options.llm ?? null;

    if (!llm) {
      return { response: buildLimitedAgentResponse(state), pendingToolCalls: null, readyToStream: false };
    }

    const iterations = state.toolIterations ?? 0;
    if (iterations >= MAX_TOOL_ITERATIONS) {
      return {
        response: `[dot] Tool-use cap reached after ${iterations} iterations.`,
        pendingToolCalls: null,
        readyToStream: false,
      };
    }

    if (iterations > 0) {
      state.session._onStep?.(`[${iterations}/${MAX_TOOL_ITERATIONS}] synthesizing…`);
    } else {
      state.session._onStep?.('Agent: planning next action…');
    }

    const tools = [SHELL_RUN_COMMAND_TOOL, ...buildLlmTools(state.session.mcp)];
    const system = buildAgentSystemPrompt(state);

    // On iteration 0: prior history is in state.messages, user input must be appended.
    // On subsequent iterations: user message was already stored in state.messages by the
    // iteration-0 return below, so use state.messages as-is.
    const conversationMessages = iterations === 0
      ? [...(state.messages ?? []), { role: 'user', content: state.input }]
      : (state.messages ?? []);

    try {
      const result = await llm.completeWithTools({
        system,
        tools,
        messages: conversationMessages,
        signal: state.session._abortSignal,
      });

      if (result.tool_calls?.length > 0) {
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
        };
      }

      if (iterations > 0) {
        if (typeof llm.stream === 'function') {
          state.session._onStep?.('Agent: streaming final answer…');
          return {
            response: null,
            pendingToolCalls: null,
            readyToStream: true,
            streamContext: { system, messages: conversationMessages },
          };
        }

        return {
          response: result.content ?? '',
          pendingToolCalls: null,
          readyToStream: false,
        };
      }

      // LLM chose text — hand off to runLine for streaming
      state.session._onStep?.('Agent: streaming final answer…');
      return {
        response: null,
        pendingToolCalls: null,
        readyToStream: true,
        streamContext: { system, messages: conversationMessages },
      };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      const message = err instanceof Error ? err.message : String(err);
      return { response: buildLimitedAgentResponse(state, `LLM indisponible: ${message}`), pendingToolCalls: null, readyToStream: false };
    }
  }

  async function toolExecutorNode(state) {
    const toolCalls = state.pendingToolCalls ?? [];
    const toolResultMessages = [];

    for (const call of toolCalls) {
      const { server, tool } = parseToolCallName(call.function.name);
      const argsSummary = summarizeToolArguments(call.function.arguments);
      state.session._onStep?.(
        `[${state.toolIterations}/${MAX_TOOL_ITERATIONS}] ${server === 'shell' ? 'Shell' : 'MCP'} ${server}.${tool}${argsSummary ? ` (${argsSummary})` : ''}`,
      );
      let resultText;
      try {
        const args = JSON.parse(call.function.arguments ?? '{}');
        if (server === 'shell' && tool === 'run_command') {
          resultText = await runShellCommandTool(state.session, args.command);
        } else {
          const result = await callMcpTool(state.session.mcp, server, tool, args, state.session._abortSignal);
          resultText = formatMcpToolResult(result);
        }
        if (server === 'production') {
          const payload = parseJsonToolResult(resultText);
          const progressLabel = formatProductionProgress(payload);
          if (progressLabel) state.session._onStep?.(progressLabel);
          rememberProductionProgress(state.session, payload, progressLabel);
        } else {
          const activityLabel = formatActivitySummary(server, tool, resultText);
          if (activityLabel) state.session._onStep?.(activityLabel);
        }
      } catch (err) {
        if (err.name === 'AbortError' && state.session._abortSignal?.aborted) throw err;
        resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      toolResultMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: resultText,
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

  return new StateGraph(AgentState)
    .addNode('orchestrator', orchestratorNode)
    .addNode('tool_executor', toolExecutorNode)
    .addEdge(START, 'orchestrator')
    .addConditionalEdges('orchestrator', routeOrchestrator)
    .addEdge('tool_executor', 'orchestrator')
    .compile();
}
