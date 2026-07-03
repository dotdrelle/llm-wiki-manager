import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
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
  const defaultContext = { workspace: null, session, running: false, currentAbortController: null };
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
        sendJson(response, 200, store.getState(context?.session ?? session, { workspace }));
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
          sendJson(response, 200, controlStatus(context, store));
          return;
        }
        if (action === 'explain') {
          const status = controlStatus(context, store);
          sendJson(response, 200, { ...status, explanation: explainControlState(status) });
          return;
        }
        if (action === 'enqueue') {
          const input = String(body.input ?? body.prompt ?? body.request ?? '').trim();
          if (!input) {
            sendJson(response, 400, { error: 'Missing input.' });
            return;
          }
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
        response.write(`event: state\ndata: ${JSON.stringify(store.getState(context?.session ?? session, { workspace }))}\n\n`);
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
  const state = store.getState(context?.session ?? null, { workspace });
  return {
    ok: true,
    workspace,
    status: context?.running ? 'running' : state.status ?? 'idle',
    running: Boolean(context?.running),
    plan: Array.isArray(state.plan) ? state.plan : [],
    queue: Array.isArray(state.queue) ? state.queue : [],
    controlQueue: controlQueueFor(context?.session),
    approvals: Array.isArray(state.approvals) ? state.approvals : [],
    summary: state.summary ?? null,
  };
}

function explainControlState(status) {
  if (status.running) {
    const runningStep = status.plan.find((step) => step.status === 'running');
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
  if (status.plan.some((step) => step.status === 'pending')) {
    return 'Runtime is idle with pending plan steps visible from the last run.';
  }
  return 'Runtime is idle.';
}

function controlQueueFor(session) {
  return Array.isArray(session?.controlQueue) ? session.controlQueue : [];
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
