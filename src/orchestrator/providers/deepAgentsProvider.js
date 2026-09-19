import {
  RUNTIME_PROTOCOL_VERSION,
  RuntimeProviderUnavailableError,
  normalizeRuntimeEvent,
} from './runtimeProvider.js';

// The gateway closes the stream when one of these arrives; the client stops
// reconnecting on it too, so a finished run never leaves a retry loop behind.
const TERMINAL_RUNTIME_EVENT_TYPES = new Set(['run_completed', 'run_failed', 'run_cancelled']);

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

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
  streamRetries = Number(process.env.WIKI_MANAGER_RUNTIME_STREAM_RETRIES ?? 5),
  streamBackoffMs = Number(process.env.WIKI_MANAGER_RUNTIME_STREAM_BACKOFF_MS ?? 250),
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

  const provider = {
    // Filled by discoverCapabilities: what the gateway served vs what the
    // config declares. `null` until the first discovery.
    lastDiscovery: null,
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
    // The gateway is ALWAYS asked what it serves. The static config (the
    // manager's agent-runtimes.json entry) carries the richer metadata the
    // resolver routes on — mutationClass, aliases, aliasOperations — but it is
    // a declaration, not an observation: a gateway that lost its /config
    // mount degrades to its built-in default and the manager, trusting the
    // config alone, kept listing eight capabilities it could not govern.
    // Only the capabilities BOTH declare are offered; the difference is
    // exposed as `lastDiscovery` so /status and the runtime log can say why a
    // configured capability is missing.
    async discoverCapabilities() {
      const list = await httpJson('/capabilities');
      const served = (Array.isArray(list) ? list : [])
        .filter((item) => item && typeof item === 'object' && typeof item.name === 'string' && item.name.trim());
      const servedNames = served.map((item) => item.name);
      if (!Array.isArray(capabilities)) {
        provider.lastDiscovery = { served: servedNames, configured: null, missing: [], extra: [] };
        return served;
      }
      const configuredNames = capabilities.map((item) => String(item?.name ?? ''));
      const offered = capabilities.filter((item) => servedNames.includes(String(item?.name ?? '')));
      provider.lastDiscovery = {
        served: servedNames,
        configured: configuredNames,
        missing: configuredNames.filter((name) => !servedNames.includes(name)),
        extra: servedNames.filter((name) => !configuredNames.includes(name)),
      };
      return offered;
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
          // The body is rebuilt field by field here, so a value the dispatcher
          // adds only at the runtime layer would be dropped in transit. The
          // memory scope decides which past conversation the run resumes: it
          // has to be named in this list to exist at all.
          memoryScope: request.memoryScope ?? null,
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
    // A broken stream must not mean "silence forever", and a naive reconnect
    // must not replay what was already seen. `cursor` is the last `sequence`
    // delivered, `epoch` the gateway instance that produced it; both travel
    // back on the next connection. Bounded retries then announce the give-up:
    // a dead subscription that never says so is the defect this closes.
    subscribe(runId, listener) {
      const controller = new AbortController();
      const target = `${base}/runs/${encodeURIComponent(String(runId))}/events`;
      let cursor = null;
      let epoch = null;
      let attempts = 0;
      let stopped = false;

      const emit = (event) => {
        try {
          listener(normalizeRuntimeEvent(event));
        } catch {
          // The contract refused the frame: journal it instead of vanishing.
          try {
            listener(normalizeRuntimeEvent({
              type: 'degraded',
              capability: 'stream',
              cause: 'an out-of-contract frame arrived from the runtime',
              fallback: 'the frame was skipped',
            }));
          } catch { /* nothing left to report with */ }
        }
      };
      const announce = (cause, fallback) => emit({ type: 'degraded', capability: 'stream', cause, fallback });

      void (async () => {
        while (!stopped && attempts < streamRetries) {
          attempts += 1;
          try {
            const query = new URLSearchParams();
            if (cursor != null) query.set('after', String(cursor));
            if (epoch) query.set('epoch', epoch);
            const suffix = query.toString();
            const response = await fetchImpl(suffix ? `${target}?${suffix}` : target, {
              headers: { accept: 'text/event-stream', ...headers },
              signal: controller.signal,
            });
            if (response.status === 404) {
              announce(`run ${runId} is not known to the runtime`, 'it was purged or never existed; no replay is possible');
              return;
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            // The budget resets on PROGRESS, not on a mere HTTP 200: a gateway
            // that accepts a connection and immediately closes it (or replays
            // only what was already seen) would otherwise reset the budget
            // forever and reconnect in a loop that never gives up.
            let progressed = false;
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
                const data = block
                  .split('\n')
                  .filter((line) => line.startsWith('data: '))
                  .map((line) => line.slice(6))
                  .join('');
                if (!data) continue;
                let parsed;
                try {
                  parsed = JSON.parse(data);
                } catch {
                  announce('a malformed frame arrived from the runtime', 'the frame was skipped');
                  continue;
                }
                if (parsed?.type === 'stream_epoch') {
                  const next = String(parsed.epoch ?? '');
                  if (epoch && next && next !== epoch) {
                    announce('the runtime restarted (stream epoch changed)', 'reconnect from a fresh subscription; no events were replayed');
                    return;
                  }
                  epoch = next || epoch;
                  continue;
                }
                if (Number.isFinite(Number(parsed?.sequence))) {
                  const sequence = Number(parsed.sequence);
                  if (sequence > (cursor ?? -1)) progressed = true;
                  cursor = Math.max(cursor ?? 0, sequence);
                }
                emit(parsed);
                if (TERMINAL_RUNTIME_EVENT_TYPES.has(String(parsed?.type))) return;
              }
            }
            if (progressed) attempts = 0;
            // The stream ended without a terminal event: reconnect from the cursor.
          } catch (error) {
            if (controller.signal.aborted || stopped) return;
            if (attempts >= streamRetries) {
              announce(
                'gave up reconnecting to the runtime stream',
                `after ${attempts} attempt(s): ${error instanceof Error ? error.message : String(error)}`,
              );
              return;
            }
          }
          if (stopped || controller.signal.aborted) return;
          if (attempts >= streamRetries) break;
          await sleep(streamBackoffMs * 2 ** (attempts - 1), controller.signal);
        }
        // The loop can also end because the budget ran out on a stream that
        // kept closing cleanly — that is a give-up too, and it must be said.
        if (!stopped && !controller.signal.aborted) {
          announce('gave up reconnecting to the runtime stream', `after ${attempts} attempt(s) without progress`);
        }
      })();

      return () => {
        stopped = true;
        controller.abort();
      };
    },
  };
  return provider;
}
