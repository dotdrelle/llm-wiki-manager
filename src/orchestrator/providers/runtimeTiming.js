// Timing defaults for the external runtime and Maintenance recovery. They are
// separate cadences by design: a probe bounds one HTTP request, registry
// discovery refreshes runtime status, and Maintenance runs workspace cycles.
export const DEFAULT_RUNTIME_PROBE_TIMEOUT_MS = 30_000;
export const DEFAULT_RUNTIME_DISCOVERY_INTERVAL_MS = 60_000;
export const DEFAULT_MAINTENANCE_SCAN_INTERVAL_MS = 900_000;
const MAX_MAINTENANCE_GATEWAY_RETRY_MS = 300_000;
export const MIN_MAINTENANCE_SCAN_INTERVAL_MS = 30_000;

export function maintenanceGatewayRetryDelay(attempt, scanIntervalMs, probeTimeoutMs = DEFAULT_RUNTIME_PROBE_TIMEOUT_MS) {
  const configuredInterval = Number(scanIntervalMs);
  const interval = Number.isFinite(configuredInterval) && configuredInterval > 0
    ? configuredInterval
    : DEFAULT_MAINTENANCE_SCAN_INTERVAL_MS;
  const configuredTimeout = Number(probeTimeoutMs);
  const probeTimeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_RUNTIME_PROBE_TIMEOUT_MS;
  // Backoff starts at one probe timeout, doubles to five minutes, and never
  // waits longer than the normal scan cadence (with one probe timeout as the
  // floor so a deliberately short scan interval or a custom probe timeout
  // cannot create a hot loop or retry before a slow probe could finish).
  const ceiling = Math.max(
    probeTimeout,
    Math.min(MAX_MAINTENANCE_GATEWAY_RETRY_MS, interval),
  );
  const exponent = Math.min(4, Math.max(0, Math.floor(Number(attempt) || 0)));
  return Math.min(probeTimeout * (2 ** exponent), ceiling);
}
