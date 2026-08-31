import { assertContract } from '../../contracts/schemas.js';

/**
 * External Agent Runtime Provider — contrat.
 *
 * Le point d'abstraction qui laisse Wiki Manager router une tâche agentique
 * vers un moteur externe (Deep Agents, autre) SANS le transformer en couche
 * d'orchestration. Le contrat est volontairement plus petit que le moteur
 * interne : il ne reproduit ni Control Queue, ni scheduler, ni DAG, ni
 * politique d'approbation complète, ni objective resolver — ces responsabilités
 * restent dans Wiki Manager (voir RFC § 8).
 *
 * Un provider implémente :
 *
 *   describe(): Promise<RuntimeDescription>
 *       { runtime, version, protocolVersion, health, capabilities? }
 *
 *   discoverCapabilities(): Promise<Capability[]>
 *       [{ name: 'agent.review', operations: ['run'] }, ...]
 *
 *   execute(request: RuntimeExecuteRequest): Promise<RuntimeRun>
 *       { runId, status: 'running' } — ne bloque pas.
 *
 *   status(runId: string): Promise<RuntimeStatus>
 *       { runId, status } — status parmi les états terminaux du moteur.
 *
 *   cancel(runId: string): Promise<void>
 *
 *   subscribe(runId: string, listener: RuntimeEventListener): Unsubscribe
 *       le listener reçoit des RuntimeEvent ; `Unsubscribe` est une fonction.
 *
 *   approve(runId: string, { approved, scope?, reason? }): Promise<void>
 *       Réponse au human-in-the-loop du runtime. CE N'EST PAS un mécanisme
 *       d'approbation : son seul appelant est le dispatcher, et uniquement
 *       après qu'un grant humain couvre la demande (`approvalCovered`).
 *       Jamais exposé en tool ni en endpoint — le projet a déjà retiré un
 *       self-approval tool, ce serait le réintroduire.
 *
 * Le mot « provider » est ici distinct des `providers` du `CapabilityRegistry`
 * (qui sont des instances d'agents MCP). Un RuntimeProvider n'est PAS un agent
 * MCP : c'est un backend d'exécution externe découvert séparément.
 */

export const RUNTIME_PROTOCOL_VERSION = '1';

export const RUNTIME_EVENT_TYPES = [
  'run_created',
  'run_started',
  'agent_thinking',
  'tool_started',
  'tool_finished',
  'subagent_started',
  'subagent_finished',
  'message',
  'approval_required',
  'run_completed',
  'run_failed',
  'run_cancelled',
];

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
