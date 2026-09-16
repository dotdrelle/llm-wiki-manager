/*
 * Deep clone via a JSON round-trip; `null`/`undefined` pass through.
 *
 * Three modules had grown their own byte-identical copy (agentEvents,
 * agentRegistry, planValidator). One implementation, imported.
 */
export function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
