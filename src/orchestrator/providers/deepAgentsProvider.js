import {
  RUNTIME_PROTOCOL_VERSION,
  RuntimeProviderUnavailableError,
  normalizeRuntimeEvent,
} from './runtimeProvider.js';

/**
 * DeepAgentsProvider — client HTTP vers un runtime Deep Agents externe
 * (RFC § 11, option A). Implémente le contrat RuntimeProvider :
 *
 *   GET  {endpoint}/health             -> { ok, version? }       (describe)
 *   GET  {endpoint}/capabilities       -> [{ name, operations }] (discover)
 *   POST {endpoint}/runs               -> { runId, status }      (execute)
 *   GET  {endpoint}/runs/:id           -> { runId, status, result? } (status)
 *   POST {endpoint}/runs/:id/cancel    -> { ok }                 (cancel)
 *   GET  {endpoint}/runs/:id/events    -> SSE `data: {json}`     (subscribe)
 *
 * `fetchImpl` est injectable pour les tests ; par défaut `globalThis.fetch`
 * (Node 22 / Bun). Un runtime injoignable se manifeste par une `describe()`
 * qui retourne `health: 'unavailable'` (jamais une exception) : l'isolation de
 * panne du discovery s'appuie dessus.
 */
export function createDeepAgentsProvider({
  id = 'deepagents',
  endpoint = 'http://agent-runtime:7789',
  capabilities = null,
  fetchImpl = globalThis.fetch,
  headers = {},
  version = null,
  timeoutMs = 10_000,
} = {}) {
  const base = String(endpoint).replace(/\/+$/, '');

  async function httpJson(path, { method = 'GET', body = null, signal = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        ...(body !== null ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new RuntimeProviderUnavailableError(id, `HTTP ${response.status} on ${method} ${path}`);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof RuntimeProviderUnavailableError) throw error;
      throw new RuntimeProviderUnavailableError(id, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  return {
    async describe() {
      let health = 'available';
      let runtimeVersion = version ?? null;
      let lastError = null;
      try {
        const info = await httpJson('/health');
        runtimeVersion = info?.version ?? runtimeVersion;
        health = info?.ok === false ? 'unavailable' : 'available';
      } catch (error) {
        health = 'unavailable';
        lastError = error?.reason ?? (error instanceof Error ? error.message : String(error));
      }
      return {
        runtime: id,
        version: runtimeVersion ?? 'unknown',
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        health,
        ...(lastError ? { error: lastError } : {}),
      };
    },
    async discoverCapabilities() {
      if (Array.isArray(capabilities)) return capabilities;
      const list = await httpJson('/capabilities');
      return Array.isArray(list) ? list : [];
    },
    async execute(request = {}) {
      const accepted = await httpJson('/runs', {
        method: 'POST',
        body: {
          objective: request.objective ?? request.input ?? null,
          operation: request.operation ?? null,
          capability: request.capability ?? null,
          arguments: request.arguments ?? {},
          workspace: request.workspace ?? null,
          model: request.model ?? null,
          language: request.language ?? null,
          mcp: Array.isArray(request.mcp) ? request.mcp : [],
          systemPrompt: request.systemPrompt ?? null,
        },
      });
      const runId = String(accepted?.runId ?? '');
      if (!runId) throw new RuntimeProviderUnavailableError(id, 'execute did not return runId');
      return { runId, status: String(accepted?.status ?? 'running') };
    },
    async status(runId) {
      const state = await httpJson(`/runs/${encodeURIComponent(String(runId))}`);
      return {
        runId: String(state?.runId ?? runId),
        status: String(state?.status ?? 'running'),
        ...(state?.result ? { result: state.result } : {}),
        // The gateway reports its failure at the TOP level; dropping it here
        // swallowed the only actionable sentence ("Unable to infer model
        // provider…") and left the manager to invent a cause.
        ...(state?.error ? { error: state.error } : {}),
      };
    },
    async cancel(runId) {
      await httpJson(`/runs/${encodeURIComponent(String(runId))}/cancel`, { method: 'POST' });
    },
    async approve(runId, { approved = true, reason = null, scope = null } = {}) {
      await httpJson(`/runs/${encodeURIComponent(String(runId))}/approve`, {
        method: 'POST',
        body: {
          approved: approved === true,
          ...(reason ? { reason } : {}),
          ...(scope ? { scope } : {}),
        },
      });
    },
    subscribe(runId, listener) {
      const controller = new AbortController();
      const url = `${base}/runs/${encodeURIComponent(String(runId))}/events`;
      void (async () => {
        try {
          const response = await fetchImpl(url, {
            headers: { accept: 'text/event-stream', ...headers },
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split('\n\n');
            buffer = blocks.pop() ?? '';
            for (const block of blocks) {
              let data = '';
              for (const line of block.split('\n')) {
                if (line.startsWith('data: ')) data += line.slice(6);
              }
              if (!data) continue;
              try {
                listener(normalizeRuntimeEvent(JSON.parse(data)));
              } catch {
                // malformed or out-of-contract frame — skip
              }
            }
          }
        } catch {
          // stream ended or aborted — the unsubscribe path is a no-op
        }
      })();
      return () => controller.abort();
    },
  };
}
