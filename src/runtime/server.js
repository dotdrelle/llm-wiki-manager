import { createServer } from 'node:http';
import { runtimeTokenFromEnv } from './auth.js';

export function startRuntimeServer({
  host = '0.0.0.0',
  port = 7788,
  token = runtimeTokenFromEnv(),
  store,
  session,
  run,
  cancel,
} = {}) {
  const clients = new Set();
  let running = false;
  let currentAbortController = null;

  function publish(event) {
    const payload = `event: agent_event\ndata: ${JSON.stringify(event)}\n\n`;
    for (const response of clients) {
      response.write(payload);
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
        sendJson(response, 200, { ok: true, status: running ? 'running' : 'idle', dbPath: store.dbPath });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/state') {
        sendJson(response, 200, store.getState(session));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/events') {
        sendJson(response, 200, { events: store.listEvents() });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/events/stream') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.write(`event: state\ndata: ${JSON.stringify(store.getState(session))}\n\n`);
        clients.add(response);
        request.on('close', () => clients.delete(response));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/run') {
        if (running) {
          sendJson(response, 409, { error: 'A runtime run is already active.' });
          return;
        }
        running = true;
        currentAbortController = new AbortController();
        try {
          const body = await readJson(request);
          const input = String(body.input ?? body.prompt ?? '').trim();
          if (!input) {
            running = false;
            currentAbortController = null;
            sendJson(response, 400, { error: 'Missing input.' });
            return;
          }
          run(body, { signal: currentAbortController.signal })
            .catch((err) => {
              session._onRuntimeError?.(err);
            })
            .finally(() => {
              running = false;
              currentAbortController = null;
            });
          sendJson(response, 202, { accepted: true });
        } catch (err) {
          running = false;
          currentAbortController = null;
          throw err;
        }
        return;
      }
      if (request.method === 'POST' && url.pathname === '/cancel') {
        if (!running || !currentAbortController) {
          sendJson(response, 200, { cancelled: false, reason: 'no active run' });
          return;
        }
        currentAbortController.abort();
        await cancel?.();
        sendJson(response, 202, { cancelled: true });
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
          for (const response of clients) response.end();
          clients.clear();
          server.close((err) => (err ? closeReject(err) : closeResolve()));
        }),
      });
    });
  });
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
