import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
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
        const body = await readJson(request);
        const workspace = workspaceFromBody(body) ?? workspaceFromUrl(url);
        const context = await resolveContext({ workspace });
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
          const runId = randomUUID();
          const runWorkspace = context.workspace ?? workspace ?? null;
          context.running = true;
          context.currentAbortController = new AbortController();
          const runBody = { ...body, workspace: runWorkspace, runId };
          const runPromise = run(context, runBody, { signal: context.currentAbortController.signal, runId });
          runPromise
            .catch((err) => {
              context.session?._onRuntimeError?.(err);
            })
            .finally(() => {
              context.running = false;
              context.currentAbortController = null;
            });
          sendJson(response, 202, { accepted: true, runId, workspace: runWorkspace });
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
}

function workspaceFromUrl(url) {
  const workspace = url.searchParams.get('workspace');
  return workspace ? workspace.trim() || null : null;
}

function workspaceFromBody(body) {
  const workspace = body?.workspace;
  return workspace == null ? null : String(workspace).trim() || null;
}

function isAuthorized(request, token) {
  if (!token) return true;
  const authorization = request.headers.authorization ?? '';
  if (authorization === `Bearer ${token}`) return true;
  return request.headers['x-runtime-token'] === token;
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
