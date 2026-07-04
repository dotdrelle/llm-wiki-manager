import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { normalizePlanPatch, rebasePlanPatch } from '../core/planPatch.js';
import { validateContractInDev } from '../contracts/schemas.js';
import { runtimeTokenFromEnv } from './auth.js';

export function startRuntimeServer({
  host = '0.0.0.0',
  port = 7788,
  token = runtimeTokenFromEnv(),
  store,
  session = null,
  getContext,
  run,
  cancel,
  resume,
  approve,
  configProfiles,
  useConfigProfile,
} = {}) {
  const clients = new Set();
  const defaultContext = { workspace: null, session, running: false, currentAbortController: null, currentRunId: null };
  const resolvedGetContext = getContext ?? (() => defaultContext);

  function publish(event) {
    const payload = `event: agent_event\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      if (client.workspace && event.workspace !== client.workspace) continue;
      client.response.write(payload);
    }
  }

  const server = createServer(async (request, response) => {
    try {
      if (!isAuthorized(request, token)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }

      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (request.method === 'GET' && url.pathname === '/health') {
        const workspace = workspaceFromUrl(url);
        const context = workspace ? await resolveContext({ workspace }) : null;
        sendJson(response, 200, {
          ok: true,
          status: context?.running ? 'running' : 'idle',
          workspace: context?.workspace ?? workspace ?? null,
          dbPath: store.dbPath,
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/state') {
        const workspace = workspaceFromUrl(url);
        const context = workspace ? await resolveContext({ workspace }) : null;
        sendJson(response, 200, runtimeState(context, store, { workspace, session }));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/events') {
        const workspace = workspaceFromUrl(url);
        sendJson(response, 200, { events: store.listEvents({ workspace }) });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/control') {
        const workspace = workspaceFromUrl(url);
        const context = await resolveContext({ workspace });
        sendJson(response, 200, controlStatus(context, store));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/control') {
        const { body, context } = await resolveBodyContext(request, url);
        const action = String(body.action ?? 'status').trim().toLowerCase();
        if (action === 'status') {
          validateContractInDev('controlMessage', { ...body, action });
          sendJson(response, 200, controlStatus(context, store));
          return;
        }
        if (action === 'explain') {
          validateContractInDev('controlMessage', { ...body, action });
          const status = controlStatus(context, store);
          sendJson(response, 200, { ...status, explanation: explainControlState(status) });
          return;
        }
        if (action === 'message') {
          const input = String(body.input ?? body.message ?? body.prompt ?? body.request ?? '').trim();
          if (!input) {
            sendJson(response, 400, { error: 'Missing input.' });
            return;
          }
          validateContractInDev('controlMessage', { ...body, action, input });
          const result = handleControlMessage(context, store, input, {
            intent: body.intent,
            startNextControlRequest,
          });
          sendJson(response, result.statusCode, result.body);
          return;
        }
        if (action === 'approve_patch') {
          const patchId = readRequiredPatchId(body, response);
          if (!patchId) return;
          validateContractInDev('controlMessage', { ...body, action, patchId });
          const result = approvePlanPatch(context, store, patchId);
          sendJson(response, result.statusCode, result.body);
          return;
        }
        if (action === 'reject_patch') {
          const patchId = readRequiredPatchId(body, response);
          if (!patchId) return;
          const reason = String(body.reason ?? 'rejected_by_user');
          validateContractInDev('controlMessage', { ...body, action, patchId, reason });
          const result = rejectPlanPatch(context, store, patchId, reason);
          sendJson(response, result.statusCode, result.body);
          return;
        }
        if (action === 'enqueue') {
          const input = String(body.input ?? body.prompt ?? body.request ?? '').trim();
          if (!input) {
            sendJson(response, 400, { error: 'Missing input.' });
            return;
          }
          validateContractInDev('controlMessage', { ...body, action, input });
          const item = enqueueControlRequest(context, input);
          void startNextControlRequest(context);
          sendJson(response, 202, {
            accepted: true,
            item,
            ...controlStatus(context, store),
          });
          return;
        }
        sendJson(response, 400, { error: 'Unsupported control action.' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/config/profiles') {
        if (typeof configProfiles !== 'function') {
          sendJson(response, 501, { error: 'Config profiles are not supported.' });
          return;
        }
        const workspace = workspaceFromUrl(url);
        const context = await resolveContext({ workspace });
        const result = await configProfiles(context);
        sendJson(response, 200, result);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/config/use') {
        if (typeof useConfigProfile !== 'function') {
          sendJson(response, 501, { error: 'Config profile switching is not supported.' });
          return;
        }
        const { body, context } = await resolveBodyContext(request, url);
        if (context.running) {
          sendJson(response, 409, { error: 'Cannot switch config while a runtime run is active.' });
          return;
        }
        const profile = String(body.profile ?? '').trim();
        if (!profile) {
          sendJson(response, 400, { error: 'Missing profile.' });
          return;
        }
        const result = await useConfigProfile(context, profile);
        sendJson(response, 200, result);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/events/stream') {
        const workspace = workspaceFromUrl(url);
        const context = workspace ? await resolveContext({ workspace }) : null;
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.write(`event: state\ndata: ${JSON.stringify(runtimeState(context, store, { workspace, session }))}\n\n`);
        const client = { response, workspace };
        clients.add(client);
        request.on('close', () => clients.delete(client));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/run') {
        const { body, context } = await resolveBodyContext(request, url);
        if (context.running) {
          sendJson(response, 409, { error: 'A runtime run is already active.' });
          return;
        }
        try {
          const input = String(body.input ?? body.prompt ?? '').trim();
          if (!input) {
            sendJson(response, 400, { error: 'Missing input.' });
            return;
          }
          validateContractInDev('runRequest', { ...body, input });
          const accepted = startRuntimeRun(context, body);
          sendJson(response, 202, accepted);
        } catch (err) {
          context.running = false;
          context.currentAbortController = null;
          throw err;
        }
        return;
      }
      if (request.method === 'POST' && url.pathname === '/cancel') {
        const workspace = workspaceFromUrl(url);
        const context = await resolveContext({ workspace });
        if (!context.running || !context.currentAbortController) {
          sendJson(response, 200, { cancelled: false, reason: 'no active run' });
          return;
        }
        context.currentAbortController.abort();
        await cancel?.(context);
        sendJson(response, 202, { cancelled: true, workspace: context.workspace ?? workspace ?? null });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/resume') {
        const workspace = workspaceFromUrl(url);
        const result = await resume?.({ workspace });
        sendJson(response, 202, result ?? { resumed: false, workspace: workspace ?? null });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/approve') {
        const body = await readJson(request);
        const workspace = workspaceFromBody(body) ?? workspaceFromUrl(url);
        const result = await approve?.({
          workspace,
          runId: url.searchParams.get('runId') ?? body.runId ?? null,
          itemId: url.searchParams.get('itemId') ?? body.itemId ?? null,
          approvalId: url.searchParams.get('approvalId') ?? body.approvalId ?? null,
        });
        sendJson(response, result?.approved ? 202 : 404, result ?? { approved: false });
        return;
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(response, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      resolve({
        host,
        port: typeof address === 'object' && address ? address.port : port,
        publish,
        drainControl: (context) => startNextControlRequest(context),
        close: () => new Promise((closeResolve, closeReject) => {
          for (const client of clients) client.response.end();
          clients.clear();
          server.close((err) => (err ? closeReject(err) : closeResolve()));
        }),
      });
    });
  });

  async function resolveContext({ workspace = null } = {}) {
    return resolvedGetContext(workspace);
  }

  // Shared by POST handlers that take a JSON body carrying an optional
  // `workspace` field: read the body, resolve the target workspace (body
  // wins over the `?workspace=` query param), then resolve its context.
  async function resolveBodyContext(request, url) {
    const body = await readJson(request);
    const workspace = workspaceFromBody(body) ?? workspaceFromUrl(url);
    const context = await resolveContext({ workspace });
    return { body, workspace, context };
  }

  function startRuntimeRun(context, body, { controlItemId = null } = {}) {
    const runId = randomUUID();
    const runWorkspace = context.workspace ?? body.workspace ?? null;
    context.running = true;
    context.currentAbortController = new AbortController();
    context.currentRunId = runId;
    context.currentRunWorkspace = runWorkspace;
    const runBody = { ...body, workspace: runWorkspace, runId };
    if (controlItemId) {
      dispatchAgentEvent(context.session, createAgentEvent('control_started', {
        origin: 'runtime',
        runId,
        workspace: runWorkspace,
        payload: { id: controlItemId, runId },
      }));
    }
    const runPromise = run(context, runBody, { signal: context.currentAbortController.signal, runId });
    runPromise
      .catch((err) => {
        context.session?._onRuntimeError?.(err);
      })
      .finally(() => {
        context.running = false;
        context.currentAbortController = null;
        context.currentRunId = null;
        context.currentRunWorkspace = null;
        void startNextControlRequest(context);
      });
    return { accepted: true, runId, workspace: runWorkspace };
  }

  function startNextControlRequest(context) {
    if (!context?.session || context.running) return false;
    const item = controlQueueFor(context.session).find((entry) => entry.status === 'queued');
    if (!item) return false;
    startRuntimeRun(context, {
      input: item.input,
      workspace: item.workspace ?? context.workspace ?? null,
    }, { controlItemId: item.id });
    return true;
  }
}

function workspaceFromUrl(url) {
  const workspace = url.searchParams.get('workspace');
  return workspace ? workspace.trim() || null : null;
}

function workspaceFromBody(body) {
  const workspace = body?.workspace;
  return workspace == null ? null : String(workspace).trim() || null;
}

function controlStatus(context, store) {
  const workspace = context?.workspace ?? context?.session?.workspace ?? null;
  const state = runtimeState(context, store, { workspace });
  return {
    ok: true,
    ...state,
    workspace: state.workspace ?? workspace,
    running: Boolean(context?.running),
    controlQueue: controlQueueFor(context?.session),
  };
}

function runtimeState(context, store, { workspace = null, session = null } = {}) {
  const state = store.getState(context?.session ?? session ?? null, { workspace });
  return {
    ...state,
    status: context?.running ? 'running' : state.status ?? 'idle',
    running: Boolean(context?.running),
    runId: context?.currentRunId ?? state.runId ?? null,
    workspace: context?.currentRunWorkspace ?? context?.workspace ?? state.workspace ?? workspace ?? null,
  };
}

function explainControlState(status) {
  const plan = Array.isArray(status.plan) ? status.plan : [];
  if (status.running) {
    const runningStep = plan.find((step) => step.status === 'running');
    return runningStep
      ? `Runtime run is active. Current step: ${runningStep.description ?? runningStep.label ?? runningStep.step}.`
      : 'Runtime run is active. No current plan step is available yet.';
  }
  const pendingApproval = status.approvals.find((approval) => approval.status === 'pending_approval');
  if (pendingApproval) {
    return `Runtime is waiting for approval: ${pendingApproval.reason ?? pendingApproval.id}.`;
  }
  const queued = status.controlQueue.filter((item) => item.status === 'queued');
  if (queued.length > 0) {
    return `${queued.length} control request${queued.length === 1 ? '' : 's'} queued. They are not applied to the active plan automatically.`;
  }
  if (plan.some((step) => step.status === 'pending')) {
    return 'Runtime is idle with pending plan steps visible from the last run.';
  }
  return 'Runtime is idle.';
}

function controlQueueFor(session) {
  return Array.isArray(session?.controlQueue) ? session.controlQueue : [];
}

function readOnlyControlResponse(kind, classification, status, explanation, { accepted = true, extra = {} } = {}) {
  return {
    statusCode: 200,
    body: { accepted, kind, classification, ...status, explanation, ...extra },
  };
}

function handleControlMessage(context, store, input, { intent = null, startNextControlRequest = () => false } = {}) {
  const status = controlStatus(context, store);
  const classification = classifyControlMessage(input, status, intent);
  if (classification.kind === 'observe') {
    return readOnlyControlResponse('observe', classification, status, explainControlState(status));
  }
  if (classification.kind === 'mutate') {
    const proposal = storeControlProposal(context, input, classification, status);
    return {
      statusCode: 202,
      body: {
        accepted: true,
        kind: 'mutate',
        classification,
        proposal,
        ...controlStatus(context, store),
        explanation: 'Plan patch proposed. Approve it explicitly to apply it to the active plan.',
      },
    };
  }
  if (classification.kind === 'enqueue') {
    const item = enqueueControlRequest(context, input);
    // Unlike `mutate`, this may synchronously start a queued run (see
    // startNextControlRequest), which can change running/plan/status — a full
    // controlStatus() recompute is required here, not just controlQueue.
    void startNextControlRequest(context);
    return {
      statusCode: 202,
      body: {
        accepted: true,
        kind: 'enqueue',
        classification,
        item,
        ...controlStatus(context, store),
      },
    };
  }
  if (classification.kind === 'ambiguous') {
    return readOnlyControlResponse('ambiguous', classification, status, 'The runtime cannot safely classify this message.', {
      accepted: false,
      extra: {
        choices: [
          { action: 'message', intent: 'observe', label: 'Ask about this run' },
          { action: 'message', intent: 'mutate', label: 'Propose a change to this run' },
          { action: 'enqueue', intent: 'enqueue', label: 'Queue as a future run' },
        ],
      },
    });
  }
  return readOnlyControlResponse('converse', classification, status, status.running
    ? 'Runtime run is still active. This message was treated as conversation and did not create a queued run.'
    : 'Runtime is idle. This message was treated as conversation and did not create a run.');
}

function enqueueControlRequest(context, input) {
  const now = new Date().toISOString();
  const item = {
    id: `control-${randomUUID()}`,
    workspace: context?.workspace ?? context?.session?.workspace ?? null,
    type: 'run_request',
    input,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  };
  dispatchAgentEvent(context.session, createAgentEvent('control_enqueued', {
    origin: 'runtime',
    workspace: item.workspace,
    payload: item,
  }));
  return item;
}

function storeControlProposal(context, input, classification, status) {
  const now = new Date().toISOString();
  const patch = buildPlanPatchFromInput(input, status);
  const proposal = {
    id: `proposal-${randomUUID()}`,
    workspace: context?.workspace ?? context?.session?.workspace ?? null,
    type: 'active_plan_mutation',
    input,
    status: 'proposed',
    reason: classification.reason,
    patch,
    createdAt: now,
    updatedAt: now,
  };
  dispatchAgentEvent(context.session, createAgentEvent('control_message_received', {
    origin: 'runtime',
    runId: context.currentRunId ?? status.runId ?? null,
    workspace: proposal.workspace,
    payload: { input, intent: 'mutate', classification },
  }));
  dispatchAgentEvent(context.session, createAgentEvent('plan_patch_proposed', {
    origin: 'runtime',
    runId: context.currentRunId ?? status.runId ?? null,
    workspace: proposal.workspace,
    payload: {
      id: proposal.id,
      input,
      patch,
    },
  }));
  return proposal;
}

function buildPlanPatchFromInput(input, status) {
  const plan = Array.isArray(status.plan) ? status.plan : [];
  const doneIds = plan.filter((step) => step.status === 'done').map((step) => String(step.id ?? step.step));
  const active = plan.find((step) => step.status === 'running')
    ?? plan.find((step) => step.status === 'pending')
    ?? plan.at(-1);
  const dependsOn = active ? [String(active.id ?? active.step)] : doneIds.slice(-1);
  const description = String(input).replace(/\s+/g, ' ').trim();
  return normalizePlanPatch({
    targetRunId: status.runId ?? null,
    basePlanRevision: status.planRevision ?? 0,
    reason: 'control_mutate',
    operations: [{
      op: 'add_task',
      task: {
        id: `task-${randomUUID().slice(0, 8)}`,
        description,
        dependsOn: dependsOn.filter(Boolean),
        executorQuery: { capability: description },
      },
    }],
  });
}

function approvePlanPatch(context, store, patchId) {
  const status = controlStatus(context, store);
  const proposal = status.planPatches.find((patch) => patch.id === patchId);
  if (!proposal) {
    return { statusCode: 404, body: { accepted: false, error: 'Plan patch proposal not found.' } };
  }
  if (proposal.status === 'applied' || proposal.status === 'rejected') {
    // Idempotency guard: re-running applyPlanPatch here would hit
    // duplicate_task_id for an already-applied add_task patch, and the
    // plan_patch_applied reducer would then overwrite status back to
    // 'rejected' even though the original application is still in effect.
    return {
      statusCode: 409,
      body: { accepted: false, error: `Plan patch already ${proposal.status}.`, patchId, status: proposal.status },
    };
  }
  const currentRevision = status.planRevision ?? 0;
  let patch = proposal.patch;
  if (!patch) {
    return { statusCode: 400, body: { accepted: false, error: 'Plan patch proposal has no patch.' } };
  }
  if (patch.basePlanRevision !== currentRevision) {
    patch = rebasePlanPatch(patch, { currentRevision });
    dispatchAgentEvent(context.session, createAgentEvent('plan_patch_rebased', {
      origin: 'runtime',
      runId: context.currentRunId ?? status.runId ?? null,
      workspace: status.workspace ?? context.workspace ?? null,
      payload: { patchId, patch },
    }));
  }
  dispatchAgentEvent(context.session, createAgentEvent('plan_patch_approved', {
    origin: 'runtime',
    runId: context.currentRunId ?? status.runId ?? null,
    workspace: status.workspace ?? context.workspace ?? null,
    payload: { patchId },
  }));
  dispatchAgentEvent(context.session, createAgentEvent('plan_patch_applied', {
    origin: 'runtime',
    runId: context.currentRunId ?? status.runId ?? null,
    workspace: status.workspace ?? context.workspace ?? null,
    payload: { patchId, patch },
  }));
  return {
    statusCode: 202,
    body: {
      accepted: true,
      kind: 'approve_patch',
      patchId,
      ...controlStatus(context, store),
    },
  };
}

function rejectPlanPatch(context, store, patchId, reason) {
  const status = controlStatus(context, store);
  const proposal = status.planPatches.find((patch) => patch.id === patchId);
  if (!proposal) {
    return { statusCode: 404, body: { accepted: false, error: 'Plan patch proposal not found.' } };
  }
  if (proposal.status === 'applied' || proposal.status === 'rejected') {
    return {
      statusCode: 409,
      body: { accepted: false, error: `Plan patch already ${proposal.status}.`, patchId, status: proposal.status },
    };
  }
  dispatchAgentEvent(context.session, createAgentEvent('plan_patch_rejected', {
    origin: 'runtime',
    runId: context.currentRunId ?? status.runId ?? null,
    workspace: status.workspace ?? context.workspace ?? null,
    payload: { patchId, reason },
  }));
  return {
    statusCode: 200,
    body: { accepted: true, kind: 'reject_patch', patchId, ...controlStatus(context, store) },
  };
}

// Interim classifier for control §4.2 of the plan directeur: the plan expects
// an LLM-backed classification eventually ("la classification LLM se
// trompera" — the plan's own fallback-UX rule presupposes an LLM). This is a
// synchronous keyword/regex stand-in with the same {kind, confidence, reason}
// contract, so swapping in an LLM call later shouldn't require touching
// handleControlMessage.
function classifyControlMessage(input, status, forcedIntent = null) {
  // Caller (the /control message route) already trims and rejects empty input.
  const lower = String(input ?? '').toLowerCase();
  const intent = forcedIntent ? String(forcedIntent).toLowerCase() : null;
  if (['observe', 'converse', 'mutate', 'enqueue'].includes(intent)) {
    return { kind: intent, confidence: 1, reason: 'explicit_intent' };
  }
  if (/\b(o[uù] en est|status|statut|progress|progression|build|run|job|queue|file|logs?|explique|explain|inspect|show|montre|quoi de neuf)\b/i.test(lower)) {
    return { kind: 'observe', confidence: 0.86, reason: 'status_or_explanation_request' };
  }
  if (status.running && /\b(ajoute|add|change|modifie|modify|remplace|replace|retire|remove|skip|ignore|apr[eè]s|before|after|chaque|each|plan|step|t[aâ]che)\b/i.test(lower)) {
    return { kind: 'mutate', confidence: 0.78, reason: 'active_run_change_request' };
  }
  if (/\b(plus tard|later|ensuite|apr[eè]s ce run|apr[eè]s|enqueue|queue|mets en file|met en file|futur|next run|future run)\b/i.test(lower)) {
    return { kind: 'enqueue', confidence: 0.8, reason: 'future_run_request' };
  }
  if (status.running && /\b(lance|run|g[eé]n[eè]re|build|export|cr[eé]e|create|send|envoie|ingest|convert|importe|import)\b/i.test(lower)) {
    return { kind: 'ambiguous', confidence: 0.45, reason: 'active_run_action_is_ambiguous' };
  }
  return { kind: 'converse', confidence: 0.62, reason: 'plain_conversation' };
}

function isAuthorized(request, token) {
  if (!token) return true;
  const authorization = request.headers.authorization ?? '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (constantTimeEqual(bearer, token)) return true;
  return constantTimeEqual(headerValue(request.headers['x-runtime-token']), token);
}

function headerValue(value) {
  if (Array.isArray(value)) return value[0] ?? '';
  return typeof value === 'string' ? value : '';
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left), 'utf8');
  const rightBuffer = Buffer.from(String(right), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(`${JSON.stringify(value)}\n`);
}

function readRequiredPatchId(body, response) {
  const patchId = String(body.patchId ?? body.id ?? '').trim();
  if (!patchId) {
    sendJson(response, 400, { error: 'Missing patchId.' });
    return null;
  }
  return patchId;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('Request body too large.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    request.on('error', reject);
  });
}
