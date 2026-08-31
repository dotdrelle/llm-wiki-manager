import { normalizeActivity, parseJsonText } from '../core/activity.js';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { callMcpTool, formatMcpToolResult } from '../core/mcp.js';
import { loadWorkspaceProfile } from '../core/profile.js';
import { mapRuntimeEvent } from '../core/runtimeEventAdapter.js';
import { emitRuntimeLog, pollActivitiesOnce } from '../runtime/supervisor.js';
import { APPROVAL_DEFAULT_CLASS, approvalCovered } from './approvalPolicy.js';
import { isSuccessful, isTerminal } from './taskStatuses.js';


export function createDispatcher({
  session = null,
  callTool = callMcpTool,
  pollIntervalMs = 2500,
} = {}) {
  return {
    execute(task, assignment, options = {}) {
      return execute(task, assignment, {
        session,
        callTool,
        pollIntervalMs,
        ...options,
      });
    },
  };
}

export async function execute(task, assignment, {
  session,
  callTool = callMcpTool,
  signal = null,
  runId = null,
  attempt = null,
  timeoutMs = null,
  pollBusy = new Set(),
  pollIntervalMs = 2500,
} = {}) {
  if (isExternalRuntimeAssignment(assignment)) {
    return executeExternalRuntime(task, assignment, {
      session,
      signal,
      runId,
      attempt,
      timeoutMs,
      pollIntervalMs,
    });
  }
  if (!session) throw new Error('dispatcher.execute requires session.');
  if (!assignment?.serverName) throw new Error(`No MCP server found for agent ${assignment?.agentInstanceId ?? '(unknown)'}.`);
  const serverName = assignment.serverName;
  const executeTool = toolNameFor(session, serverName, 'agent_execute');
  const statusTool = toolNameFor(session, serverName, 'agent_status');
  const cancelTool = toolNameFor(session, serverName, 'agent_cancel');
  const taskTimeoutMs = resolvedTimeoutMs(assignment, timeoutMs);
  const deadline = Date.now() + taskTimeoutMs;
  let jobId = null;
  let lastStatus = null;

  try {
    emitRuntimeLog(session, taskLogPayload('agent_execute', task, assignment, {
      runId,
      attempt,
      detail: executeTool,
    }));
    const accepted = parseToolPayload(await callTool(
      session.mcp,
      serverName,
      executeTool,
      executeRequest(task, session, runId),
      signal,
    ));
    if (accepted?.accepted === false || accepted?.ok === false) {
      return rejectedTaskResult(task, assignment, accepted, attempt);
    }
    jobId = String(accepted.jobId ?? '');
    if (!jobId) throw new Error('agent_execute did not return jobId.');
    emitRuntimeLog(session, taskLogPayload('job.accepted', task, assignment, {
      runId,
      attempt,
      jobId,
      agentId: accepted.agentId ?? null,
      detail: accepted.status ?? 'accepted',
    }));
    dispatchAgentEvent(session, createAgentEvent('task.started', {
      origin: 'dispatcher',
      runId,
      taskId: String(task.id ?? task.step),
      payload: {
        runId,
        taskId: String(task.id ?? task.step),
        attemptId: attempt?.attemptId ?? null,
        agentInstanceId: assignment.agentInstanceId,
        jobId,
        startedAt: new Date().toISOString(),
      },
    }));
    dispatchTaskActivity(session, task, assignment, jobId, statusTool, runId);

    while (true) {
      throwIfAborted(signal);
      if (Date.now() > deadline) {
        throw new Error(`Task timed out after ${taskTimeoutMs}ms.`);
      }
      await pollActivitiesOnce(session, {
        pollBusy,
        signal,
        callTool: async (mcp, pollServer, pollTool, args, pollSignal) => {
          const result = await callTool(mcp, pollServer, pollTool, args, pollSignal);
          if (pollServer === serverName && pollTool === statusTool && String(args?.jobId ?? '') === jobId) {
            lastStatus = parseToolPayload(result);
          }
          return result;
        },
      });
      if (!lastStatus) {
        emitRuntimeLog(session, taskLogPayload('agent_status', task, assignment, {
          runId,
          attempt,
          jobId,
          detail: statusTool,
        }));
        lastStatus = parseToolPayload(await callTool(session.mcp, serverName, statusTool, { jobId }, signal));
      }
      if (isTerminal(lastStatus?.status ?? lastStatus?.result?.status)) {
        emitRuntimeLog(session, taskLogPayload('task.result_returned', task, assignment, {
          runId,
          attempt,
          jobId,
          status: lastStatus?.result?.status ?? lastStatus?.status,
          outputs: lastStatus?.result?.outputRefs ?? [],
          error: normalizeTaskError(lastStatus?.result?.error)?.code ?? null,
          detail: 'terminal status',
        }));
        return taskResultFromStatus(task, assignment, jobId, lastStatus, attempt);
      }
      await delay(pollIntervalMs, signal);
      emitRuntimeLog(session, taskLogPayload('agent_status', task, assignment, {
        runId,
        attempt,
        jobId,
        detail: statusTool,
      }));
      lastStatus = parseToolPayload(await callTool(session.mcp, serverName, statusTool, { jobId }, signal));
      if (isTerminal(lastStatus?.status ?? lastStatus?.result?.status)) {
        emitRuntimeLog(session, taskLogPayload('task.result_returned', task, assignment, {
          runId,
          attempt,
          jobId,
          status: lastStatus?.result?.status ?? lastStatus?.status,
          outputs: lastStatus?.result?.outputRefs ?? [],
          error: normalizeTaskError(lastStatus?.result?.error)?.code ?? null,
          detail: 'terminal status',
        }));
        return taskResultFromStatus(task, assignment, jobId, lastStatus, attempt);
      }
    }
  } catch (error) {
    if (isAbortError(error) && jobId) {
      await callTool(session.mcp, serverName, cancelTool, { jobId }, null).catch(() => null);
    }
    throw error;
  } finally {
    emitRuntimeLog(session, taskLogPayload('lock.released', task, assignment, {
      runId,
      attempt,
      jobId,
      detail: attempt?.locks?.join(',') || 'no locks',
    }));
    attempt?.release?.();
  }
}

function isExternalRuntimeAssignment(assignment) {
  return assignment?.providerKind === 'external-runtime'
    && typeof assignment?.runtimeProvider?.execute === 'function';
}

// A proposal without mutations still waits for a human grant: the request is
// treated as the default approval class, covered by a run-scope grant like
// any other. Every announced class must be covered — the "global" approval is
// bounded by the proposal.
function pendingApprovalCovered(classes, approvals, context) {
  const list = Array.isArray(classes) && classes.length > 0
    ? classes
    : [APPROVAL_DEFAULT_CLASS];
  return list.every((approvalClass) => approvalCovered(
    {
      // Without an id, grantCoversTask's task/tool-scope match (which keys
      // off task.id/localId/taskId) can never succeed, so a per-task
      // `/approve item <id>` grant silently fails to cover this task and only
      // a run-scope "approve all" can ever unblock it.
      id: context?.taskId ?? null,
      taskId: context?.taskId ?? null,
      groupId: context?.groupId ?? null,
      requiresApproval: true,
      approvalClass: String(approvalClass),
    },
    approvals,
    context,
  ));
}

async function executeExternalRuntime(task, assignment, {
  session,
  signal = null,
  runId = null,
  attempt = null,
  timeoutMs = null,
  pollIntervalMs = 2500,
} = {}) {
  if (!session) throw new Error('dispatcher.execute requires session.');
  const runtimeProvider = assignment.runtimeProvider;
  const taskId = String(task.id ?? task.step);
  const taskTimeoutMs = resolvedTimeoutMs(assignment, timeoutMs);
  let deadline = Date.now() + taskTimeoutMs;
  let runtimeRunId = null;
  let unsubscribe = null;
  let pendingApproval = null;
  try {
    emitRuntimeLog(session, taskLogPayload('runtime.execute', task, assignment, {
      runId,
      attempt,
      detail: 'external-runtime',
    }));
    const mcpPool = activeProfileMcp(session);
    if (!mcpPool) {
      // A degradation must announce itself. The runtime's whole value is its
      // eyes: dispatched without the workspace wiki MCP, the Deep Agent
      // improvises with its built-in backend (it ran `ls /` on the gateway
      // container and answered "the workspace is empty" — a plausible,
      // confident, entirely wrong answer). Say it in the journal, keep the
      // run (the objective may still be answerable from the model alone),
      // but never let blindness pass silently.
      emitRuntimeLog(session, taskLogPayload('runtime.blind', task, assignment, {
        runId,
        attempt,
        detail: 'no workspace wiki MCP pool — the endpoint is down or declares no read tools; the runtime will run without its eyes',
      }));
    }
    const accepted = await runtimeProvider.execute({
      objective: task.label ?? task.description ?? taskId,
      operation: task.operation ?? null,
      capability: task.requiredCapability ?? null,
      arguments: task.arguments && typeof task.arguments === 'object' ? task.arguments : {},
      workspace: workspaceRequest(session),
      model: activeProfileModel(session),
      language: session?.language ?? session?.wikircConfig?.language ?? null,
      mcp: mcpPool,
      systemPrompt: activeRuntimeSystemPrompt(session, task, assignment),
    });
    runtimeRunId = String(accepted?.runId ?? '');
    if (!runtimeRunId) throw new Error('runtime.execute did not return runId.');
    emitRuntimeLog(session, taskLogPayload('runtime.accepted', task, assignment, {
      runId,
      attempt,
      jobId: runtimeRunId,
      detail: String(accepted?.status ?? 'running'),
    }));
    dispatchAgentEvent(session, createAgentEvent('task.started', {
      origin: 'dispatcher',
      runId,
      taskId,
      payload: {
        runId,
        taskId,
        attemptId: attempt?.attemptId ?? null,
        agentInstanceId: assignment.agentInstanceId,
        jobId: runtimeRunId,
        startedAt: new Date().toISOString(),
      },
    }));
    dispatchExternalRuntimeActivity(session, task, assignment, runtimeRunId, 'running', runId);
    if (typeof runtimeProvider.subscribe === 'function') {
      unsubscribe = runtimeProvider.subscribe(runtimeRunId, (event) => {
        for (const mapped of mapRuntimeEvent(event)) {
          dispatchAgentEvent(session, createAgentEvent(mapped.type, {
            origin: 'runtime_provider',
            runId,
            taskId,
            payload: mapped.payload,
          }));
          if (mapped.type === 'approval.requested') {
            pendingApproval = {
              approvalId: mapped.payload?.approvalId ?? null,
              approvalClasses: Array.isArray(mapped.payload?.approvalClasses)
                ? mapped.payload.approvalClasses
                : [],
            };
            const summary = String(mapped.payload?.proposal?.summary ?? mapped.payload?.reason ?? '').trim();
            dispatchAgentEvent(session, createAgentEvent('assistant_message', {
              origin: 'runtime_provider',
              runId,
              payload: {
                content: [
                  '⏸ Approval required before execution:',
                  ...(summary ? [`  ${summary}`] : []),
                  'Type /approve (or click "Approve") to proceed, "cancel" to abandon.',
                ].filter(Boolean).join('\n'),
              },
            }));
          }
        }
      });
    }
    let approvalWaitStartedAt = null;
    while (true) {
      throwIfAborted(signal);
      // While a proposal waits for a human decision, the task timeout does
      // not tick — the human decides, not the clock (the scheduler applies
      // the same rule to its approval waits). The elapsed wait is credited
      // back onto the deadline once the gate clears (below), rather than
      // merely skipped from this check, so a late approval does not
      // immediately expire the task on the very next iteration.
      if (!pendingApproval && Date.now() > deadline) {
        await runtimeProvider.cancel(runtimeRunId).catch(() => null);
        throw new Error(`Task timed out after ${taskTimeoutMs}ms.`);
      }
      if (pendingApproval) {
        approvalWaitStartedAt ??= Date.now();
        const approvalBeingChecked = pendingApproval;
        const approvals = session.agentProjection?.approvals ?? session.approvals ?? [];
        const covered = pendingApprovalCovered(approvalBeingChecked.approvalClasses, approvals, {
          runId,
          taskId,
          groupId: task.groupId ?? null,
          workspaceId: session.workspace ?? null,
          planRevision: session.planRevision ?? session.agentProjection?.planRevision ?? null,
        });
        if (covered && typeof runtimeProvider.approve === 'function') {
          emitRuntimeLog(session, taskLogPayload('runtime.approval_granted', task, assignment, {
            runId,
            attempt,
            jobId: runtimeRunId,
            detail: 'unblocking runtime HITL',
          }));
          await runtimeProvider.approve(runtimeRunId, { approved: true, scope: approvalBeingChecked.approvalClasses });
          // Only clear the approval just resolved: the runtime's event stream
          // may have raised a second, unrelated one while the approve() round
          // trip above was in flight.
          if (pendingApproval === approvalBeingChecked) {
            pendingApproval = null;
            deadline += Date.now() - approvalWaitStartedAt;
            approvalWaitStartedAt = null;
          }
        } else {
          await delay(pollIntervalMs, signal);
          continue;
        }
      }
      const lastStatus = await runtimeProvider.status(runtimeRunId);
      if (isTerminal(lastStatus?.status)) {
        const refusedParams = Array.isArray(lastStatus?.result?.refusedParams)
          ? lastStatus.result.refusedParams
          : [];
        if (refusedParams.length > 0) {
          emitRuntimeLog(session, taskLogPayload('runtime.params_refused', task, assignment, {
            runId,
            attempt,
            jobId: runtimeRunId,
            detail: `model refused sampling parameters (${refusedParams.join(', ')}) — remove them from the workspace .wikirc (llm.<key>) so they are no longer sent`,
          }));
        }
        emitRuntimeLog(session, taskLogPayload('runtime.result_returned', task, assignment, {
          runId,
          attempt,
          jobId: runtimeRunId,
          status: lastStatus.status,
          detail: 'terminal status',
        }));
        dispatchExternalRuntimeActivity(session, task, assignment, runtimeRunId, lastStatus.status, runId);
        return taskResultFromStatus(task, assignment, runtimeRunId, lastStatus, attempt);
      }
      await delay(pollIntervalMs, signal);
    }
  } catch (error) {
    if (isAbortError(error) && runtimeRunId) {
      await runtimeProvider.cancel(runtimeRunId).catch(() => null);
    }
    throw error;
  } finally {
    unsubscribe?.();
    emitRuntimeLog(session, taskLogPayload('lock.released', task, assignment, {
      runId,
      attempt,
      jobId: runtimeRunId,
      detail: attempt?.locks?.join(',') || 'no locks',
    }));
    attempt?.release?.();
  }
}

function dispatchExternalRuntimeActivity(session, task, assignment, runtimeRunId, status, runId) {
  const activity = normalizeActivity({
    id: runtimeRunId,
    source: assignment.runtimeId ?? 'external-runtime',
    kind: task.operation ?? task.requiredCapability ?? 'task',
    label: task.label ?? task.description ?? String(task.id ?? task.step),
    status,
    progress: { percent: isTerminal(status) ? 100 : 0, stepId: String(task.id ?? task.step) },
    outputRefs: [],
  });
  dispatchAgentEvent(session, createAgentEvent('activity_upserted', {
    origin: 'dispatcher',
    runId,
    taskId: String(task.id ?? task.step),
    payload: { activity },
  }));
}

function executeRequest(task, session, runId) {
  return {
    taskId: String(task.id ?? task.step),
    ...(runId ? { runId: String(runId) } : {}),
    ...(task.requiredCapability ? { capability: String(task.requiredCapability) } : {}),
    idempotencyKey: task.idempotencyKey ?? undefined,
    operation: task.operation,
    workspace: workspaceRequest(session),
    arguments: {
      ...(task.arguments && typeof task.arguments === 'object' ? task.arguments : {}),
      // The production agent's confirmation guard
      // (PRODUCTION_REQUIRE_CONFIRMATION=true) has one contract: "only an
      // approved task may run a mutating operation — Donna passes
      // confirm=true after the run-scope approval". The scheduler never
      // dispatches a requiresApproval task before coverage
      // (dependencyResolver.readyTasks), so reaching dispatch IS the
      // approval. Without this, an operator who enables the guard sees every
      // mutating production job fail with "requires confirm=true" — the
      // first E2E ingest plan dispatched by the deep agent's
      // planExpansionRequest failed exactly that way, 19 tasks in one batch.
      ...(task.requiresApproval === true ? { confirm: true } : {}),
    },
    constraints: {
      requireApprovalForMutations: task.requiresApproval === true,
    },
  };
}

function workspaceRequest(session) {
  const workspace = session.workspace ?? session._currentRunIdentity?.workspace;
  if (workspace && typeof workspace === 'object' && !Array.isArray(workspace)) return { ...workspace };
  return { name: String(workspace ?? 'workspace') };
}

// The model travels WITH the run: the runtime is workspace-agnostic and must
// follow the active profile — default or `/config use` — without a config
// sync. Numeric LLM parameters declared by the profile (temperature, …) ride
// along too: nothing is hardcoded here, the workspace config is the source.
function activeProfileModel(session) {
  const llm = session?.wikircConfig?.llm ?? {};
  const model = {
    ...(llm.baseUrl ? { baseUrl: String(llm.baseUrl) } : {}),
    ...(llm.model ? { model: String(llm.model) } : {}),
    ...(llm.apiKey ? { apiKey: String(llm.apiKey) } : {}),
  };
  for (const key of ['temperature', 'maxTokens', 'topP', 'seed']) {
    const value = Number(llm[key]);
    if (Number.isFinite(value)) model[key] = value;
  }
  return Object.keys(model).length > 0 ? model : null;
}

// The read-only wiki MCP tools the runtime is allowed to see. An explicit
// allow-list, not a denylist: the runtime has eyes (read tools) and a mouth
// (gated side-effects through the DAG), never hands on the workspace. A denylist
// keyed on "write_page|add_source|…" already silently let build_context_write
// and template_write through, and would leak any future wiki_delete_page /
// wiki_move_page / wiki_rename the moment it is added upstream.
const READ_ONLY_WIKI_TOOLS = new Set([
  'help_list', 'help_read', 'help_search',
  'profile_read', 'template_read',
  'wiki_collect_context', 'wiki_list_ingested_sources', 'wiki_list_pages',
  'wiki_outline', 'wiki_read_deliverable', 'wiki_read_ingested_source',
  'wiki_read_page', 'wiki_read_pages', 'wiki_search_context',
  'wiki_workspace_status',
]);

// An arbitrary external connector's tool names cannot be enumerated ahead of
// time the way READ_ONLY_WIKI_TOOLS can, so this stays a denylist — but a
// word-boundary one. The old test was a raw substring match
// (/write|send|create|update|add|remove/), which dropped safe reads whose name
// merely contained a mutating verb (`list_recent_updates`, `get_created_at`,
// `search_addresses`) and missed side-effecting tools that use another verb
// (`crawl_site`, `post_message`, `run_report`, `publish_draft`). The real
// guardrails against "hands on the workspace" are elsewhere —
// EXCLUDED_EXTERNAL_SERVERS covers every workspace-writing agent, and a
// per-tool `requireApproval` entry drops the whole server — this filter only
// keeps an obviously-mutating tool of an otherwise-safe connector out of the
// runtime's eyes.
const EXTERNAL_MUTATING_VERB = /(?:^|[_-])(?:write|send|post|create|delete|destroy|remove|drop|modify|edit|update|patch|put|upload|publish|submit|execute|run|crawl|trigger|cancel|approve|move|rename|set|add|insert|append|archive)(?:[_-]|$)/i;

function isReadOnlyExternalTool(toolName) {
  const base = toolName.includes('__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName;
  return !EXTERNAL_MUTATING_VERB.test(base);
}

// The runtime's EYES, per run: the active workspace's wiki MCP (read tools
// only) PLUS the declared external MCP endpoints that are safe to hand over
// (connected, no approval-gated tools, not a workspace-mutating server) —
// typically web search (exa). The allow-list here is the authority: nothing
// else reaches the runtime.
export function activeProfileMcp(session) {
  const blocks = [];
  const wiki = session?.mcp?.wiki;
  if (wiki?.url && wiki.status === 'connected') {
    const tools = (wiki.tools ?? [])
      .map((tool) => String(tool.name ?? ''))
      .filter((name) => {
        if (!name) return false;
        const base = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
        return READ_ONLY_WIKI_TOOLS.has(base);
      });
    if (tools.length > 0) {
      // Same credential contract as the manager's own MCP client (mcp.js
      // `authorization: Bearer ${endpoint.token}`): the wiki detail carries
      // `token`, not `headers` — without it the gateway's MCP connection is
      // rejected by the workspace MCP server ("invalid or missing bearer token")
      // and the Deep Agent runs blind.
      const headers = {
        ...(wiki.headers && typeof wiki.headers === 'object' ? wiki.headers : {}),
        ...(wiki.token ? { Authorization: `Bearer ${wiki.token}` } : {}),
      };
      blocks.push({
        name: 'wiki',
        url: String(wiki.url),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        tools,
      });
    }
  }
  // External connectors ride along ONLY when the operator declared them safe
  // for the runtime's eyes. A connector added from the serve panel lands here
  // too — without this, exa was offered in chat but the agentic path
  // delegated to the gateway and the Deep Agent answered it had no web tools.
  const EXCLUDED_EXTERNAL_SERVERS = new Set(['cme', 'documents', 'connectors', 'production']);
  for (const [name, entry] of Object.entries(session?.mcp ?? {})) {
    if (!entry?.external || entry.status !== 'connected') continue;
    if (EXCLUDED_EXTERNAL_SERVERS.has(name)) continue;
    if (Array.isArray(entry.requireApproval) && entry.requireApproval.length > 0) continue;
    const tools = (entry.tools ?? [])
      .map((tool) => String(tool.name ?? ''))
      .filter((toolName) => toolName && isReadOnlyExternalTool(toolName));
    if (tools.length === 0) continue;
    blocks.push({
      name,
      url: String(entry.url),
      ...(entry.headers && typeof entry.headers === 'object' ? { headers: entry.headers } : {}),
      tools,
    });
  }
  return blocks.length > 0 ? blocks : null;
}

// The Deep Agent's system prompt, built per run from the same ingredients
// Donna uses: role, the ONE capability being executed (with its declared
// description), the eyes/bouche/mains boundary, the workspace profile and the
// reply language. Without it, the runtime falls back to deepagents' generic
// assistant prompt — which is exactly the "upload your project" hallucination.
function activeRuntimeSystemPrompt(session, task, assignment) {
  const capability = assignment?.capability ?? null;
  const description = String(capability?.description ?? '').trim();
  const language = session?.language ?? session?.wikircConfig?.language ?? null;
  const profile = loadWorkspaceProfile(session?.workspacePath);
  return [
    'You are the agentic analysis engine of a knowledge workspace (wikiLLM), executed behind the manager Donna.',
    `Execute exactly ONE capability: ${task?.requiredCapability ?? 'unknown'}${description ? ` — ${description}` : ''}.`,
    `Operation: ${task?.operation ?? 'run'}.`,
    'Boundary: you have READ tools only (the workspace wiki). You never modify the workspace — structural changes are proposals you return in your final answer (a planExpansionRequest), the manager integrates them under human approval. Side-effects on the outside world are gated by approval.',
    'Ground every claim in what the read tools return. Never invent pages, names, facts, jobs or results.',
    'Tool discipline: discover real page paths with the list/search tools BEFORE reading. Never guess a path — a read refused for "path not allowed" means the path was invented, so list/search first, then read exactly what exists.',
    ...(language ? [`Reply in the workspace language: ${language}.`] : []),
    ...(profile ? [`Workspace preferences — apply them to every reply:\n${profile}`] : []),
  ].join('\n');
}

function dispatchTaskActivity(session, task, assignment, jobId, statusTool, runId) {
  const activity = normalizeActivity({
    id: jobId,
    source: assignment.serverName,
    kind: task.operation ?? task.requiredCapability ?? 'task',
    label: task.label ?? task.description ?? String(task.id ?? task.step),
    status: 'queued',
    progress: { percent: 0, stepId: String(task.id ?? task.step) },
    poll: {
      server: assignment.serverName,
      tool: statusTool,
      args: { jobId },
      intervalMs: 1000,
    },
    outputRefs: [],
  });
  dispatchAgentEvent(session, createAgentEvent('activity_upserted', {
    origin: 'dispatcher',
    runId,
    taskId: String(task.id ?? task.step),
    payload: { activity },
  }));
}

function taskResultFromStatus(task, assignment, jobId, statusPayload, attempt = null) {
  const result = statusPayload?.result ?? {};
  const resultStatus = String(result.status ?? statusPayload?.status ?? '').toLowerCase();
  const ok = isSuccessful(resultStatus);
  return {
    ok,
    taskId: String(task.id ?? task.step),
    attemptId: statusPayload?.attemptId ?? attempt?.attemptId ?? null,
    jobId,
    agentInstanceId: assignment.agentInstanceId,
    status: result.status ?? statusPayload?.status,
    outputRefs: Array.isArray(result.outputRefs) ? result.outputRefs : [],
    metrics: result.metrics ?? {},
    // The gateway reports its failure at the TOP level of the status payload
    // ({ runId, status, error }), not inside `result`. Reading only
    // `result.error` dropped the only actionable sentence ("no model…") and
    // left Donna to invent a cause.
    error: normalizeTaskError(result.error ?? statusPayload.error),
    // Agent -> DAG (RFC § 30/31/41): a result may request the execution of a
    // deterministic capability. Propagated here so resultAggregator.maybeExpandPlan
    // picks it up and routes it through the manager's own resolution + approval
    // — never a direct scheduler call by the runtime.
    ...(result.planExpansionRequest ? { planExpansionRequest: result.planExpansionRequest } : {}),
    rawStatus: statusPayload,
  };
}

// An agent may report a terminal failure either as an object ({code, message})
// or as a bare reason string — the contract mandates neither, and the
// executor-only agents report the latter. Consumers (runner logs, the UIs)
// only ever read `.code`/`.message`, so an unnormalized string silently
// became `null` and every failure surfaced as a bare "failed" with no reason.
// Normalize once, here, so the shape is uniform for every downstream reader.
export function normalizeTaskError(rawError, { fallbackCode = null, fallbackMessage = null } = {}) {
  if (rawError && typeof rawError === 'object') {
    const code = String(rawError.code ?? rawError.message ?? fallbackCode ?? 'failed');
    return {
      code,
      message: String(rawError.message ?? rawError.code ?? fallbackMessage ?? code),
      retryable: rawError.retryable === true
        || transientError(rawError.code)
        || transientError(rawError.message),
    };
  }
  if (rawError === null || rawError === undefined || String(rawError).trim() === '') {
    if (!fallbackCode) return null;
    return {
      code: String(fallbackCode),
      message: String(fallbackMessage ?? fallbackCode),
      retryable: transientError(fallbackCode),
    };
  }
  // The agent gave a real reason. `fallbackMessage` describes only WHERE the
  // failure was observed ("agent_execute rejected task"), so letting it win
  // here replaced the one actionable sentence we have with a generic one —
  // and Donna, left with nothing to explain, invented a cause. The fallback
  // is a last resort, never an override.
  const code = String(rawError);
  return {
    code,
    message: code,
    retryable: transientError(code),
  };
}

function rejectedTaskResult(task, assignment, payload, attempt = null) {
  const error = normalizeTaskError(payload?.error, {
    fallbackCode: 'execution_rejected',
    fallbackMessage: payload?.message ?? 'agent_execute rejected task',
  });
  return {
    ok: false,
    taskId: String(task.id ?? task.step),
    attemptId: attempt?.attemptId ?? null,
    jobId: payload?.activeJobId ?? null,
    agentInstanceId: assignment.agentInstanceId,
    status: 'failed',
    outputRefs: [],
    metrics: {},
    error,
    rawStatus: payload,
  };
}

function transientError(value) {
  return /(?:429|timeout|temporar|throttl|rate.?limit|quota|busy|unavailable)/i.test(String(value ?? ''));
}

function toolNameFor(session, serverName, baseName) {
  const tools = session.mcp?.[serverName]?.tools ?? [];
  const names = tools.map((tool) => String(tool.name ?? '')).filter(Boolean);
  return names.find((name) => name === baseName)
    ?? names.find((name) => name === `${serverName}__${baseName}`)
    ?? names.find((name) => name.endsWith(`__${baseName}`))
    ?? baseName;
}

function parseToolPayload(result) {
  if (result && typeof result === 'object' && !Array.isArray(result) && !Array.isArray(result.content)) return result;
  return parseJsonText(formatMcpToolResult(result)) ?? {};
}

function resolvedTimeoutMs(assignment, timeoutMs) {
  const agentLimit = Number(assignment?.agent?.description?.limits?.maxTaskDurationMs ?? assignment?.description?.limits?.maxTaskDurationMs);
  if (Number.isFinite(agentLimit) && agentLimit > 0) return agentLimit;
  const runtimeLimit = Number(timeoutMs);
  return Number.isFinite(runtimeLimit) && runtimeLimit > 0 ? runtimeLimit : 600_000;
}

function taskLogPayload(event, task, assignment, {
  runId = null,
  attempt = null,
  jobId = null,
  agentId = null,
  status = null,
  outputs = null,
  error = null,
  detail = null,
} = {}) {
  return {
    event,
    runId,
    planRevision: task?.planRevision ?? null,
    groupId: task?.groupId ?? null,
    taskId: String(task?.id ?? task?.step),
    attemptId: attempt?.attemptId ?? null,
    agentType: assignment?.agent?.description?.agentType ?? assignment?.description?.agentType ?? null,
    agentInstanceId: assignment?.agentInstanceId ?? null,
    agentId: agentId ?? assignment?.agentId ?? null,
    jobId,
    capability: task?.requiredCapability ?? assignment?.capability ?? null,
    operation: task?.operation ?? assignment?.operation ?? null,
    status,
    outputs,
    error,
    detail,
  };
}


function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function abortError() {
  const error = new Error('Runtime run cancelled.');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}
