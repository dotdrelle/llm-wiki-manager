const MIN_MCP_TIMEOUT_MS = 1000;
const MAX_MCP_TIMEOUT_MS = 120_000;

export function resolveMcpToolTimeout(endpoint, serverName, toolName, override) {
  const configured = override ?? endpoint.timeoutMs;
  const timeoutMs = Number(configured);
  if (configured != null && Number.isFinite(timeoutMs) && timeoutMs >= MIN_MCP_TIMEOUT_MS && timeoutMs <= MAX_MCP_TIMEOUT_MS) return timeoutMs;
  if (serverName === 'documents' && toolName === 'documents_convert_to_markdown') return 600_000;
  if (serverName === 'cme' && toolName === 'cme_confluence_search') return 20_000;
  return 8000;
}

export function createMcpRequestTimeout(timeoutMs, signal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  return {
    timeoutMs,
    signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    didTimeout: () => timedOut,
    clear: () => clearTimeout(timer),
  };
}
