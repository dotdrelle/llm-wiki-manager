import assert from 'node:assert/strict';
import test from 'node:test';

import { delegateWithinRun, integratePreparedDelegation } from './delegation.js';
import { isTerminal } from '../orchestrator/taskStatuses.js';

function task(id) {
  return {
    id,
    label: `Task ${id}`,
    requiredCapability: 'knowledge.update',
    operation: 'ingest',
    arguments: { inputs: [`raw/untracked/${id}.md`] },
    groupId: 'ingest',
    dependsOn: [],
    parallelizable: true,
    inputRefs: [{ type: 'file', ref: `raw/untracked/${id}.md` }],
    expectedOutputRefs: [{ type: 'file', ref: `.wiki/ingest-plans/${id}.json` }],
    locks: ['workspace-write'],
    requiresApproval: true,
    idempotencyKey: `idem-${id}`,
    progressWeight: 1,
  };
}

function fragment(taskId = 'build-1') {
  return {
    contractVersion: '1',
    agentInstanceId: 'production-main',
    capability: 'knowledge.update',
    summary: { label: 'Update knowledge', initialSynthesis: ['Build.'], estimatedTasks: 1 },
    groups: [{ id: 'ingest', label: 'Ingest sources', recommendedConcurrency: 2, progressWeight: 1 }],
    tasks: [task(taskId)],
    expectedOutputs: [{ type: 'directory', ref: 'wiki' }],
  };
}

function preparedDelegation(taskId) {
  return {
    capability: 'knowledge.update',
    operation: 'ingest',
    provider: { serverName: 'production' },
    fragment: fragment(taskId),
    summary: { agent: 'production', capability: 'knowledge.update', operation: 'ingest', tasks: 1 },
  };
}

function runningSession(runId = 'run-conversational') {
  return {
    workspace: 'demo',
    activities: {},
    agentEvents: [],
    headlessPlan: null,
    _currentRunIdentity: { runId, workspace: 'demo' },
  };
}

// Le registre est un double minimal : la question posée ici n'est pas la
// validation du plan (couverte par planIntegrator.test.js) mais l'identité du
// run auquel la délégation appartient.
function registryDouble() {
  return {
    providersFor(capability) {
      if (capability !== 'knowledge.update') return [];
      return [{
        serverName: 'production',
        agentInstanceId: 'production-main',
        health: 'available',
        capability: {
          id: 'knowledge.update',
          version: '1',
          description: 'Knowledge update',
          inputSchema: {
            type: 'object',
            required: ['inputs'],
            additionalProperties: true,
            properties: { inputs: { type: 'array', items: { type: 'string' } } },
          },
          outputSchema: {},
          supportedOperations: ['ingest'],
          mutationClass: 'workspace',
          defaultRequiresApproval: true,
        },
        description: { contractVersion: '1' },
      }];
    },
    isCompatible: (contractVersion) => String(contractVersion) === '1',
  };
}

test('une demande de build délègue dans le run courant, sans en démarrer un second', async () => {
  /*
   Le run conversationnel se marquait actif AVANT que Donna appelle delegate.
   L'appel repartait alors vers POST /delegate, qui refusait par 409 : le run
   refusait sa propre délégation. Déléguer n'est pas démarrer un second run,
   c'est faire passer celui-ci de la décision à l'exécution.
  */
  const session = runningSession('run-fr-build');
  const started = [];

  const result = await delegateWithinRun(session, 'build the deliverables of the demo workspace', {
    prepare: async ({ objective }) => {
      assert.match(objective, /build the deliverables/);
      return preparedDelegation('build-fr');
    },
    registry: registryDouble(),
    startRun: (...args) => started.push(args),
  });

  assert.equal(result.delegated, true);
  // Identité unique : le runId rendu est celui du run en cours.
  assert.equal(result.runId, 'run-fr-build');
  assert.equal(result.summary.tasks, 1);
  // Aucun second run concurrent n'a été démarré par la bande.
  assert.deepEqual(started, []);
});

test('la délégation interne exige un run actif', async () => {
  // Hors run, il n'y a pas d'exécution à transformer : c'est un vrai démarrage
  // de run, et il doit passer par le chemin normal plutôt que par ici.
  const session = { workspace: 'demo', agentEvents: [] };

  await assert.rejects(
    () => delegateWithinRun(session, 'build the deliverables', {
      prepare: async () => preparedDelegation(),
      registry: registryDouble(),
    }),
    /in-run delegation requires a running run/,
  );
});

test('un fragment non intégrable est refusé explicitement, sans plan à moitié posé', async () => {
  const session = runningSession();

  await assert.rejects(
    () => delegateWithinRun(session, 'objectif', {
      prepare: async () => ({ ...preparedDelegation(), fragment: null }),
      registry: registryDouble(),
    }),
    /carries no validated fragment/,
  );
  assert.equal(session.headlessPlan, null);
});

test('l’approbation reste requise par défaut, et n’est levée que sur opt-in', () => {
  const approvals = [];
  const approvalManager = { approve: (request) => { approvals.push(request); return { ok: true }; } };
  const session = runningSession('run-approval');

  const waiting = integratePreparedDelegation({
    session,
    runId: 'run-approval',
    prepared: preparedDelegation('build-waiting'),
    registry: registryDouble(),
    approvalManager,
  });
  assert.equal(waiting.approval.awaitingApproval, true);
  assert.deepEqual(approvals, []);

  const auto = integratePreparedDelegation({
    session,
    runId: 'run-approval',
    prepared: preparedDelegation('build-auto'),
    registry: registryDouble(),
    approvalManager,
    autoApprove: true,
  });
  assert.equal(auto.approval.approved, true);
  assert.deepEqual(approvals, [{ scope: 'run', runId: 'run-approval' }]);
});

/*
 Test d'INTÉGRATION, pas de délégation isolée.

 Les tests unitaires de `delegateWithinRun` passaient tous pendant que le run
 dupliquait son plan à chaud : 5 tâches, puis 10, 15, 20, 35. Ils vérifiaient
 la délégation ; personne ne vérifiait ce que la boucle en faisait ensuite.

 Le parcours complet est donc rejoué ici : demande française → délégation →
 intégration → bascule → planificateur. Le seul chiffre qui compte est le
 dernier : toujours exactement cinq tâches.
*/
test('une demande française délègue une fois et bascule, sans jamais dupliquer le plan', async () => {
  const { runRuntimeAgenticWorkflow } = await import('./runner.js');
  const runId = 'run-fr-integration';
  const session = {
    workspace: 'demo',
    activities: {},
    agentEvents: [],
    headlessPlan: null,
    // Posée par executeRun avant l'appel au workflow, comme en production.
    _currentRunIdentity: { runId, workspace: 'demo' },
    llm: { async completeWithTools() { assert.fail('aucune évaluation ne doit avoir lieu ici'); } },
  };
  const fiveTasks = {
    ...fragment('build-a'),
    summary: { label: 'Update knowledge', initialSynthesis: ['Build.'], estimatedTasks: 5 },
    groups: [{ id: 'ingest', label: 'Ingest sources', recommendedConcurrency: 4, progressWeight: 5 }],
    tasks: ['a', 'b', 'c', 'd', 'e'].map((suffix) => ({ ...task(`build-${suffix}`), requiresApproval: false })),
  };

  let delegations = 0;
  let conversationalTurns = 0;
  const agent = {
    async invoke({ session: turnSession }) {
      conversationalTurns += 1;
      // Le tour conversationnel appelle l'outil de délégation, comme Donna.
      const result = await delegateWithinRun(turnSession, 'build the deliverables of the demo workspace', {
        prepare: async () => {
          delegations += 1;
          return { ...preparedDelegation(), fragment: fiveTasks };
        },
        registry: registryDouble(),
      });
      assert.equal(result.runId, runId);
      return { response: 'Action lancée.' };
    },
  };

  const jobs = new Map();
  const callTool = async (_mcp, _serverName, toolName, args) => {
    const text = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
    if (toolName === 'agent_execute') {
      const jobId = `job-${args.taskId}`;
      jobs.set(jobId, args.taskId);
      return text({ accepted: true, jobId, status: 'queued' });
    }
    if (toolName === 'agent_status') {
      return text({
        jobId: args.jobId,
        taskId: jobs.get(args.jobId),
        operation: 'ingest',
        status: 'done',
        progress: { percent: 100 },
        result: { status: 'succeeded', outputRefs: [], metrics: { durationMs: 1 } },
      });
    }
    if (toolName === 'agent_cancel') return text({ ok: true });
    throw new Error(`unexpected tool: ${toolName}`);
  };

  // Borne l'attente d'approbation comme en headless : un test ne doit jamais
  // pouvoir se figer sur une décision humaine qui ne viendra pas.
  session._approvalTimeoutMs = 200;
  await runRuntimeAgenticWorkflow(agent, session, 'build the deliverables of the demo workspace', {
    runId,
    timeoutMs: 2000,
    maxTurns: 4,
    maxReplans: 2,
    evaluate: false,
    callTool,
    dispatcherPollIntervalMs: 1,
  });

  // Une seule délégation, un seul tour conversationnel : la bascule a eu lieu
  // immédiatement après l'intégration.
  assert.equal(delegations, 1);
  assert.equal(conversationalTurns, 1);
  // Et surtout : cinq tâches, pas dix, pas trente-cinq.
  assert.equal(session.headlessPlan.length, 5);
  // Toutes sont passées par le planificateur : plus aucune n'attend. Le double
  // d'agent ne rejoue pas une exécution réelle — ce que ce test garantit est
  // qu'une seule décision a eu lieu et qu'aucune tâche n'a été dupliquée.
  assert.equal(session.headlessPlan.every((step) => isTerminal(step.status)), true);
  assert.deepEqual([...new Set(session.headlessPlan.map((step) => step.id))].length, 5);
});

test('un run qui porte déjà un plan validé refuse une seconde délégation', async () => {
  // Garde-fou défensif : c'est ce qui transforme une bascule ratée en erreur
  // lisible plutôt qu'en plan qui double à chaque tour.
  const session = runningSession('run-guard');
  session.headlessPlan = [task('build-a')];

  await assert.rejects(
    () => delegateWithinRun(session, 'build the deliverables', {
      prepare: async () => preparedDelegation(),
      registry: registryDouble(),
    }),
    /already carries a validated plan/,
  );
});
