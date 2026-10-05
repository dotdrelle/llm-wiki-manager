import { assertContract } from '../../contracts/schemas.js';

/**
 * External Agent Runtime Provider — contract.
 *
 * The abstraction point that lets Wiki Manager route an agentic task to an
 * external engine (Deep Agents, another) WITHOUT turning it into an
 * orchestration layer. The contract is deliberately smaller than the internal
 * engine: it reproduces neither Control Queue, nor scheduler, nor DAG, nor
 * full approval policy, nor objective resolver — those responsibilities stay
 * in Wiki Manager (see RFC § 8).
 *
 * A provider implements:
 *
 *   describe(): Promise<RuntimeDescription>
 *       { runtime, version, protocolVersion, health, capabilities? }
 *
 *   discoverCapabilities(): Promise<Capability[]>
 *       [{ name: 'agent.review', operations: ['run'] }, ...]
 *
 *   execute(request: RuntimeExecuteRequest): Promise<RuntimeRun>
 *       { runId, status: 'running' } — does not block.
 *
 *   status(runId: string): Promise<RuntimeStatus>
 *       { runId, status } — status among the engine's terminal states.
 *
 *   cancel(runId: string): Promise<void>
 *
 *   subscribe(runId: string, listener: RuntimeEventListener): Unsubscribe
 *       the listener receives RuntimeEvents; `Unsubscribe` is a function.
 *
 *   approve(runId: string, { approved, scope?, reason? }): Promise<void>
 *       Answer to the runtime's human-in-the-loop. This is NOT an approval
 *       mechanism: its only caller is the dispatcher, and only after a human
 *       grant covers the request (`approvalCovered`). Never exposed as a tool
 *       or an endpoint — the project already removed a self-approval tool;
 *       this would reintroduce it.
 *
 * The word "provider" here is distinct from the `CapabilityRegistry`'s
 * `providers` (which are MCP agent instances). A RuntimeProvider is NOT an
 * MCP agent: it is an external execution backend discovered separately.
 */

export const RUNTIME_PROTOCOL_VERSION = '1';


export class RuntimeProviderUnavailableError extends Error {
  constructor(runtime, reason) {
    super(`Runtime provider unavailable: ${runtime} (${reason})`);
    this.name = 'RuntimeProviderUnavailableError';
    this.runtime = String(runtime ?? 'unknown');
    this.reason = String(reason ?? 'unknown');
  }
}

const CONTRACT_METHODS = [
  'describe',
  'discoverCapabilities',
  'execute',
  'status',
  'cancel',
  'subscribe',
  'approve',
];

export function assertRuntimeProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new RuntimeProviderUnavailableError('unknown', 'provider is not an object');
  }
  for (const method of CONTRACT_METHODS) {
    if (typeof provider[method] !== 'function') {
      throw new RuntimeProviderUnavailableError(
        provider.runtime ?? 'unknown',
        `missing method "${method}"`,
      );
    }
  }
  return provider;
}

export function assertRuntimeDescription(description) {
  return assertContract('runtimeDescription', description);
}

export function normalizeRuntimeEvent(event) {
  return assertContract('runtimeEvent', event);
}
