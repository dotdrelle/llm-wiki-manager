import {
  RUNTIME_PROTOCOL_VERSION,
  RuntimeProviderUnavailableError,
  normalizeRuntimeEvent,
} from './runtimeProvider.js';

/**
 * FakeRuntimeProvider — vérifie toute la plomberie du contrat sans introduire
 * de LLM (RFC § 26). Expose la capability `agent.echo` et simule
 * discover / execute / status / events / cancel / approve, avec des runs
 * indépendants.
 *
 * `requireApproval: true` simule le human-in-the-loop : après l'analyse, le
 * run émet `approval_required` et reste `waiting_approval` jusqu'à
 * `approve()`. C'est ce qui permet de tester le gate d'approbation du
 * dispatcher sans runtime réel.
 */
export function createFakeRuntimeProvider({
  runtime = 'fake',
  version = '0.0.1',
  capabilities = [{ name: 'agent.echo', operations: ['run'] }],
  available = true,
  autoCompleteMs = 0,
  requireApproval = false,
  proposal = null,
} = {}) {
  const runs = new Map();
  let sequence = 0;

  function nextRunId() {
    sequence += 1;
    return `${runtime}-${sequence}`;
  }

  function emit(run, event) {
    const normalized = normalizeRuntimeEvent({ ...event, runId: run.runId });
    run.events.push(normalized);
    for (const listener of run.listeners) listener(normalized);
  }

  function runFor(runId) {
    const run = runs.get(String(runId));
    if (!run) throw new RuntimeProviderUnavailableError(runtime, `unknown run "${runId}"`);
    return run;
  }

  function complete(run) {
    run.status = 'completed';
    run.timer = null;
    // Mirrors the gateway: a structural proposal rides the structured
    // `result.planExpansionRequest` field, which is what the manager's DAG
    // integration reads — never a prose-only message.
    run.result = {
      status: 'completed',
      content: `completed ${String(run.objective ?? '')}`,
      ...(proposal && typeof proposal === 'object' ? { planExpansionRequest: proposal } : {}),
    };
    emit(run, { type: 'message', content: run.result.content });
    emit(run, { type: 'run_completed' });
  }

  return {
    async describe() {
      return {
        runtime,
        version,
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        health: available ? 'available' : 'unavailable',
        capabilities: capabilities.map((capability) => ({ ...capability })),
      };
    },
    async discoverCapabilities() {
      if (!available) throw new RuntimeProviderUnavailableError(runtime, 'down');
      return capabilities.map((capability) => ({ ...capability }));
    },
    async execute(request = {}) {
      if (!available) throw new RuntimeProviderUnavailableError(runtime, 'down');
      const runId = nextRunId();
      const capabilityName = String(request.capability ?? '');
      const declared = (capabilities ?? []).find((capability) => capability?.name === capabilityName) ?? null;
      const operationName = String(request.operation ?? 'run');
      // The 'plan' operation is the dry-run: it proposes, never acts, so it
      // never pauses for approval — even on a mutating capability. Global
      // requireApproval stays a force for every operation.
      const mutating = requireApproval
        || ((Boolean(declared?.mutationClass) || declared?.defaultRequiresApproval === true)
          && operationName !== 'plan');
      const run = {
        runId,
        status: 'running',
        objective: String(request.objective ?? request.input ?? ''),
        events: [],
        listeners: new Set(),
        timer: null,
        awaitingApproval: false,
      };
      runs.set(runId, run);
      emit(run, { type: 'run_started' });
      emit(run, { type: 'tool_started', tool: 'echo' });
      emit(run, {
        type: 'tool_finished',
        tool: 'echo',
        resultSummary: `echoed "${run.objective}"`,
      });
      if (mutating) {
        run.status = 'waiting_approval';
        run.awaitingApproval = true;
        emit(run, {
          type: 'approval_required',
          approvalId: `${runId}-proposal`,
          reason: 'analysis complete before execution',
          proposal: {
            summary: `Analysis for "${run.objective}": read-only inspection, then the announced mutation.`,
            readTools: ['echo'],
            mutations: [{ kind: declared?.mutationClass ?? 'default', target: 'workspace', summary: run.objective }],
          },
        });
      } else {
        run.timer = setTimeout(() => complete(run), autoCompleteMs);
      }
      return { runId, status: run.status };
    },
    async status(runId) {
      const run = runFor(runId);
      return {
        runId: run.runId,
        status: run.status,
        ...(run.result ? { result: run.result } : {}),
      };
    },
    async cancel(runId) {
      const run = runFor(runId);
      if (run.timer) {
        clearTimeout(run.timer);
        run.timer = null;
      }
      run.status = 'cancelled';
      run.awaitingApproval = false;
      emit(run, { type: 'run_cancelled' });
    },
    async approve(runId, { approved = true, reason = null, scope = null } = {}) {
      const run = runFor(runId);
      if (!run.awaitingApproval) return;
      run.awaitingApproval = false;
      if (!approved) {
        run.status = 'cancelled';
        emit(run, { type: 'run_cancelled', ...(reason ? { error: reason } : {}) });
        return;
      }
      void scope;
      run.status = 'running';
      run.timer = setTimeout(() => complete(run), autoCompleteMs);
    },
    subscribe(runId, listener) {
      const run = runFor(runId);
      run.listeners.add(listener);
      // Rejoue les événements déjà émis avant la souscription : le listener
      // doit voir l'historique complet du run, pas seulement ce qui arrive
      // après son attachement (comportement fidèle aux flux d'événements).
      for (const event of [...run.events]) listener(event);
      return () => run.listeners.delete(listener);
    },
  };
}
