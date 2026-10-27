import { isIP } from 'node:net';

/*
 Two checks in front of every runtime route, before the bearer gate.

 Host — DNS rebinding. A page on an attacker's domain can re-point that
 domain at 127.0.0.1 and talk to the runtime as same-origin; the request then
 carries the attacker's HOSTNAME in its Host header. An IP literal can never be
 the product of rebinding, so any IP is accepted (LAN access by address keeps
 working); a name must be one the runtime is known by: localhost,
 host.docker.internal (serve, the gateway and the connectors reach it there),
 the bind host when it is a name, and WIKI_MANAGER_RUNTIME_ALLOWED_HOSTS
 (comma-separated — the public name behind a reverse proxy, for instance).
 A refused name is answered 421 and logged once, so a misconfiguration reads
 as one instead of as a dead runtime.

 JSON — cross-site POSTs. The public routes before the bearer gate (login,
 logout, the maintenance bridge) accept only `application/json`: a form or a
 text/plain body is what a foreign page can send without a CORS preflight.
 The bearer-gated routes need no such rule — a cross-site request cannot carry
 the Authorization header — and some of their clients send no Content-Type.
 */

const BUILTIN_HOST_NAMES = ['localhost', 'host.docker.internal'];
const PUBLIC_JSON_ROUTES = new Set(['/login/verify', '/login/enrollment', '/logout', '/maintenance/bridge']);

function hostName(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']') > 0 ? raw.indexOf(']') : undefined);
  return raw.replace(/:\d+$/, '');
}

export function createHostGuard({ bindHost = '', allowedHosts = process.env.WIKI_MANAGER_RUNTIME_ALLOWED_HOSTS ?? '', warn = console.warn } = {}) {
  const allowed = new Set([
    ...BUILTIN_HOST_NAMES,
    ...String(allowedHosts).split(',').map(hostName).filter(Boolean),
  ]);
  const bind = hostName(bindHost);
  if (bind && !isIP(bind)) allowed.add(bind);
  const warned = new Set();
  return function hostAllowed(headerValue) {
    if (headerValue === undefined) return true; // HTTP/1.0 client; a browser always sends Host
    const name = hostName(headerValue);
    if (!name) return false;
    if (isIP(name) || allowed.has(name) || name.endsWith('.localhost')) return true;
    if (!warned.has(name)) {
      warned.add(name);
      warn(`runtime: refused a request for Host "${name}" — add it to WIKI_MANAGER_RUNTIME_ALLOWED_HOSTS if this name is legitimate`);
    }
    return false;
  };
}

export function publicRouteNeedsJson(method, pathname) {
  return method === 'POST' && PUBLIC_JSON_ROUTES.has(pathname);
}

export function isJsonRequest(headers) {
  return /^application\/json\b/i.test(String(headers?.['content-type'] ?? '').trim());
}

/*
 The single call server.js makes: answers 421/415 itself and returns true when
 the request stops here. One guard per bind host, created on first use.
 */
const guards = new Map();
export function refuseByRequestGuards(request, response, bindHost) {
  if (!guards.has(bindHost)) guards.set(bindHost, createHostGuard({ bindHost }));
  const refuse = (status, error) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(`${JSON.stringify({ error })}\n`);
    return true;
  };
  if (!guards.get(bindHost)(request.headers.host)) return refuse(421, 'Unexpected Host header');
  const pathname = String(request.url ?? '/').split('?')[0];
  if (publicRouteNeedsJson(request.method, pathname) && !isJsonRequest(request.headers)) {
    return refuse(415, 'Content-Type must be application/json');
  }
  return false;
}
