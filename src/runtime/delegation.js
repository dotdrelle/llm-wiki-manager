/**
 * Intégration d'une délégation préparée dans un run.
 *
 * Ce code n'existait qu'en un point : le handler `/run`, qui recevait une
 * délégation préparée par `/delegate` et la posait comme plan d'un run NEUF.
 * D'où le blocage : un run conversationnel déjà actif appelait `/delegate`
 * pour déléguer sa propre décision, et l'endpoint refusait — à juste titre de
 * son point de vue — parce qu'un run tournait déjà. Le run refusait sa propre
 * délégation.
 *
 * Déléguer n'est pas démarrer un second run : c'est faire passer le run en
 * cours de la décision à l'exécution. La boucle sait déjà le faire — elle
 * repasse au planificateur parallèle dès qu'un plan validé apparaît
 * (`parallelHandoff`) — il ne lui manquait qu'un moyen d'intégrer le fragment
 * sans sortir par le réseau. C'est ce que fait cette fonction, appelée aussi
 * bien par `/run` (nouveau run) que depuis l'intérieur d'un run (délégation
 * interne), avec le même résultat et la même identité de run.
 */
import { integrate } from '../orchestrator/planIntegrator.js';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { emitRuntimeLog } from './supervisor.js';

/**
 * Une délégation n'est auto-approuvée que sur opt-in explicite : par défaut le
 * run attend une décision humaine, et la fenêtre `pending_approval` doit être
 * visible assez longtemps pour qu'une UI la rende.
 */
export function resolvePreparedDelegationApproval({
  autoApprove = false,
  approvalManager = null,
  runId,
} = {}) {
  if (autoApprove !== true || typeof approvalManager?.approve !== 'function') {
    return { approved: false, awaitingApproval: true };
  }
  const result = approvalManager.approve({ scope: 'run', runId });
  return { approved: true, awaitingApproval: false, result };
}

/**
 * Le run porte-t-il déjà un plan validé par un agent ?
 *
 * Une tâche structurée se reconnaît à son couple capacité/opération : c'est ce
 * qui la distingue d'une étape de plan conversationnelle, qui n'est qu'une
 * phrase. Le critère est celui de `shouldUseParallelScheduler`, à dessein —
 * ce qui déclenche la bascule et ce qui interdit une seconde délégation
 * doivent désigner le même objet.
 */
export function hasStructuredPlan(session) {
  return (session?.headlessPlan ?? []).some((task) => task?.requiredCapability && task?.operation);
}

export function integratePreparedDelegation({
  session,
  store = null,
  runId,
  prepared,
  registry,
  approvalManager = null,
  autoApprove = false,
}) {
  if (!prepared?.fragment) throw new Error('Delegation carries no validated fragment.');
  const integrated = integrate(runId, prepared.fragment, {
    registry,
    session,
    store,
    workspace: session.workspace ?? null,
    enforceApprovalCoverage: true,
  });
  if (!integrated.ok) {
    throw new Error(`Delegated plan integration failed: ${(integrated.errors ?? [])
      .map((error) => error.message ?? error.code ?? String(error))
      .join('; ')}`);
  }
  emitRuntimeLog(
    session,
    `delegation: ${prepared.fragment.tasks.length} validated task(s) integrated from ${prepared.provider?.serverName ?? 'agent'}.agent_plan (${prepared.capability}/${prepared.operation})`,
  );
  /*
   Marqueur de bascule.

   La boucle conversationnelle ne pouvait pas deviner qu'un plan structuré
   venait d'apparaître : elle ne regardait que les tâches PRÊTES, et un plan
   intégralement en attente d'approbation n'en compte aucune. Elle concluait
   donc « plus rien à faire », l'évaluateur jugeait le plan incomplet, le
   replanificateur relançait une délégation — et cinq tâches devenaient dix,
   puis quinze. Le drapeau dit ce que ni le nombre de tâches prêtes ni le
   statut ne pouvaient dire : une décision vient d'être prise, la suite n'est
   plus conversationnelle.
  */
  session._structuredPlanIntegrated = true;
  const approval = resolvePreparedDelegationApproval({ autoApprove, approvalManager, runId });
  emitRuntimeLog(
    session,
    approval.approved
      ? `approval: run ${runId} auto-approved (autoApprove opt-in)`
      : `approval: run ${runId} awaiting explicit approval before mutations (/approve or « valide tout »)`,
  );
  return { integrated, approval };
}

/**
 * Délégation depuis l'INTÉRIEUR du run courant.
 *
 * Rend un résumé destiné au modèle qui a appelé l'outil. Le `runId` rendu est
 * celui du run en cours, jamais un nouveau : c'est la garantie qu'on n'a pas
 * démarré un second run par la bande, et c'est ce que vérifient les tests.
 */
export async function delegateWithinRun(session, objective, {
  prepare,
  registry,
  store = null,
  approvalManager = null,
  autoApprove = false,
}) {
  const runId = session?._currentRunIdentity?.runId ?? null;
  if (!runId) throw new Error('No active run identity: in-run delegation requires a running run.');
  /*
   Un run n'a qu'un plan.

   Garde-fou défensif : si la boucle rappelle l'outil alors qu'un plan
   structuré est déjà en place, intégrer un second fragment dupliquerait le
   travail au lieu de le remplacer — c'est très exactement ce qu'on a observé,
   cinq tâches devenues trente-cinq. Le refus est explicite plutôt que
   silencieux : le modèle doit lire qu'il redemande une chose déjà faite.
  */
  if (hasStructuredPlan(session)) {
    throw new Error('This run already carries a validated plan: it is executing, not deciding.');
  }
  const prepared = await prepare({ session, objective });
  const { approval } = integratePreparedDelegation({
    session,
    store,
    runId,
    prepared,
    registry,
    approvalManager,
    autoApprove,
  });
  // Le plan validé est en place : la boucle du run le verra au tour suivant et
  // basculera d'elle-même sur le planificateur parallèle (parallelHandoff).
  dispatchAgentEvent(session, createAgentEvent('runtime_log', {
    origin: 'runtime',
    runId,
    payload: { message: `delegation: run ${runId} switched from decision to execution` },
  }));
  return {
    delegated: true,
    runId,
    awaitingApproval: approval.awaitingApproval === true,
    summary: prepared.summary ?? {
      agent: prepared.provider?.serverName ?? null,
      capability: prepared.capability ?? null,
      operation: prepared.operation ?? null,
      tasks: prepared.fragment.tasks.length,
    },
  };
}
