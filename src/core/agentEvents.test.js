import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationEventSequences, createAgentEvent, dispatchAgentEvent, reduceAgentEvents } from './agentEvents.js';

function sequenced(events) {
  return events.map((event, index) => ({ ...event, sequence: index + 1 }));
}

test('conversationEventSequences maps every entry back to the event that produced it', () => {
  const events = sequenced([
    createAgentEvent('user_message', { origin: 'user', payload: { content: 'first question' } }),
    createAgentEvent('assistant_message', { origin: 'runtime', payload: { content: 'first answer' } }),
    createAgentEvent('plan_set', { origin: 'tool', payload: { steps: ['do something'] } }),
    createAgentEvent('user_message', { origin: 'user', payload: { content: 'second question' } }),
    createAgentEvent('assistant_message', { origin: 'runtime', payload: { content: 'second answer' } }),
  ]);

  const projection = reduceAgentEvents(events);
  const sequences = conversationEventSequences(events);

  // One sequence per conversation entry, and the mapping is derived by the same
  // applyEvent the projection uses, so it cannot drift from what is displayed.
  assert.equal(sequences.length, projection.conversation.length);
  assert.deepEqual(sequences, [1, 2, 4, 5]);
  // Redo on "second question" (index 2) truncates after sequence 4: the plan
  // event at 3 predates it and survives, the answer at 5 does not.
  assert.equal(sequences[2], 4);
});

test('a streamed reply keeps the sequence of the delta that created it', () => {
  const events = sequenced([
    createAgentEvent('user_message', { origin: 'user', payload: { content: 'question' } }),
    createAgentEvent('assistant_delta', { origin: 'runtime', payload: { delta: 'par' } }),
    createAgentEvent('assistant_delta', { origin: 'runtime', payload: { delta: 'tial' } }),
  ]);

  // Deltas mutate the last entry in place instead of appending; the entry must
  // not be re-stamped with every later delta or a redo would truncate too late.
  assert.deepEqual(conversationEventSequences(events), [1, 2]);
});

test('an independent queued skill invocation never inherits the active run identity', () => {
  const session = {
    workspace: 'docs',
    _currentRunIdentity: { runId: 'unrelated-run', turnId: 'unrelated-turn', workspace: 'docs' },
  };
  const event = dispatchAgentEvent(session, createAgentEvent('user_message', {
    origin: 'user',
    payload: { content: '/wiki-build overview', independent: true },
  }));
  assert.equal(event.runId, null);
  assert.equal(event.turnId, null);
  assert.equal(event.workspace, 'docs');
});

test('reduceAgentEvents: run_started clears stale plan', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('activity_upserted', {
      origin: 'tool',
      payload: {
        activity: {
          key: 'production:old',
          id: 'old',
          source: 'production',
          label: 'Old job',
          status: 'running',
        },
      },
    }),
    createAgentEvent('plan_set', {
      origin: 'tool',
      payload: { steps: ['Old action'] },
    }),
    createAgentEvent('run_started', { origin: 'runtime' }),
  ]);
  assert.equal(projection.plan, null);
  assert.equal(projection.activities.length, 0);
  assert.equal(projection.status, 'running');
});

test('reduceAgentEvents: interactive (user) run_started clears state but is not a running run', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('plan_set', { origin: 'tool', payload: { steps: ['Old action'] } }),
    createAgentEvent('run_started', { origin: 'user' }),
  ]);
  // An interactive turn clears stale plan/activities but must NOT mark the
  // projection 'running' — otherwise the graph classifies activeRun=true and
  // hides Donna's MCP read tools.
  assert.equal(projection.plan, null);
  assert.notEqual(projection.status, 'running');
});

test('reduceAgentEvents: tracks manual plan and step updates', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('plan_set', {
      origin: 'tool',
      payload: { steps: ['Export CME', 'Build deliverable'] },
    }),
    createAgentEvent('plan_step_updated', {
      origin: 'tool',
      payload: { step: 1, status: 'done' },
    }),
  ]);
  assert.equal(projection.plan.length, 2);
  assert.equal(projection.plan[0].status, 'done');
  assert.equal(projection.plan[1].status, 'pending');
});

test('reduceAgentEvents: activity with plan creates visible plan and progress', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('activity_upserted', {
      origin: 'tool',
      payload: {
        activity: {
          key: 'production:job-1',
          id: 'job-1',
          source: 'production',
          label: 'Pipeline',
          status: 'running',
          plan: { steps: [{ id: 'build', label: 'Build' }, { id: 'polish', label: 'Polish' }] },
          progress: { stepId: 'build' },
        },
      },
    }),
  ]);
  assert.equal(projection.activities.length, 1);
  assert.equal(projection.plan.length, 2);
  assert.equal(projection.plan[0].description, 'Build');
  assert.equal(projection.plan[0].status, 'running');
  assert.equal(projection.plan[1].status, 'pending');
});

test('reduceAgentEvents: activity attaches to orchestrator plan without replacing it', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('plan_set', {
      origin: 'tool',
      payload: { steps: [{ description: 'cme.cme_export_run', status: 'running', _activityKey: null }] },
    }),
    createAgentEvent('activity_upserted', {
      origin: 'tool',
      payload: {
        activity: {
          key: 'cme:export-1',
          id: 'export-1',
          source: 'cme',
          label: 'CME export',
          status: 'running',
        },
      },
    }),
  ]);
  assert.equal(projection.plan.length, 1);
  assert.equal(projection.plan[0].description, 'cme.cme_export_run');
  assert.equal(projection.plan[0].owner, 'orchestrator');
  assert.equal(projection.plan[0].activityKey, 'cme:export-1');
  assert.equal(projection.plan[0].ownerActivityKey, 'cme:export-1');
});

test('reduceAgentEvents: run activity creates activity-owned plan when no explicit plan exists', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('run_started', { origin: 'runtime' }),
    createAgentEvent('activity_upserted', {
      origin: 'tool',
      payload: {
        activity: {
          key: 'production:build-1',
          id: 'build-1',
          source: 'production',
          label: 'Production build',
          status: 'running',
        },
      },
    }),
  ]);

  assert.equal(projection.plan.length, 1);
  assert.equal(projection.plan[0].description, 'Production build');
  assert.equal(projection.plan[0].status, 'running');
  assert.equal(projection.plan[0].owner, 'activity');
});

test('reduceAgentEvents: run_done finalizes running and pending plan steps', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('plan_set', {
      origin: 'tool',
      payload: { steps: ['Analyze', 'Execute'] },
    }),
    createAgentEvent('run_done', { origin: 'runtime' }),
  ]);

  assert.deepEqual(projection.plan.map((step) => step.status), ['done', 'done']);
  assert.equal(projection.status, 'done');
});

test('dispatchAgentEvent: run_done finalizes session plan', () => {
  const session = {};
  dispatchAgentEvent(session, createAgentEvent('plan_set', {
    origin: 'tool',
    payload: { steps: ['Analyze', 'Execute'] },
  }));
  dispatchAgentEvent(session, createAgentEvent('run_done', { origin: 'runtime' }));

  assert.deepEqual(session.headlessPlan.map((step) => step.status), ['done', 'done']);
  assert.equal(session.agentProjection.status, 'done');
});

test('reduceAgentEvents: run_evaluated exposes evaluator verdict', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('run_started', { origin: 'runtime', runId: 'run-1' }),
    createAgentEvent('run_evaluated', {
      origin: 'runtime',
      runId: 'run-1',
      payload: {
        ok: false,
        reason: 'Missing export.',
        suggestedAction: 'Run export step.',
      },
    }),
  ]);

  assert.deepEqual(projection.evaluation, {
    ok: false,
    reason: 'Missing export.',
    suggestedAction: 'Run export step.',
    runId: 'run-1',
  });
  assert.equal(projection.status, 'running');
});

test('reduceAgentEvents: run_replanned records replan trace', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('run_started', { origin: 'runtime', runId: 'run-1' }),
    createAgentEvent('run_replanned', {
      origin: 'runtime',
      runId: 'run-1',
      payload: {
        reason: 'Export file missing.',
        plan: ['Run export again'],
        replansLeft: 1,
      },
    }),
  ]);

  assert.deepEqual(projection.replans, [{
    reason: 'Export file missing.',
    plan: ['Run export again'],
    replansLeft: 1,
    runId: 'run-1',
  }]);
});

test('reduceAgentEvents: approvals move from pending to approved', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('run_pending_approval', {
      origin: 'runtime',
      runId: 'run-1',
      payload: {
        approvalId: 'approval-1',
        runId: 'run-1',
        reason: 'Approve plan.',
        plan: ['Build'],
      },
    }),
    createAgentEvent('run_approved', {
      origin: 'runtime',
      runId: 'run-1',
      payload: {
        approvalId: 'approval-1',
        runId: 'run-1',
      },
    }),
  ]);

  assert.equal(projection.approvals.length, 1);
  assert.equal(projection.approvals[0].status, 'approved');
  assert.equal(projection.approvals[0].scope, 'run');
  assert.deepEqual(projection.approvals[0].plan, ['Build']);
});

test('reduceAgentEvents: cancelling a run clears its pending approval projection', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('approval.requested', {
      origin: 'runtime',
      runId: 'run-cancelled',
      payload: { approvalId: 'approval-cancelled', scope: 'run', runId: 'run-cancelled' },
    }),
    createAgentEvent('approval.requested', {
      origin: 'runtime',
      runId: 'run-other',
      payload: { approvalId: 'approval-other', scope: 'run', runId: 'run-other' },
    }),
    createAgentEvent('run_cancelled', {
      origin: 'runtime',
      runId: 'run-cancelled',
      payload: { runId: 'run-cancelled' },
    }),
  ]);

  assert.equal(projection.approvals.find((item) => item.runId === 'run-cancelled')?.status, 'cancelled');
  assert.equal(projection.approvals.find((item) => item.runId === 'run-other')?.status, 'pending_approval');
});

test('reduceAgentEvents: bounded approval grant covers matching pending requests only', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('approval.requested', {
      origin: 'orchestrator',
      runId: 'run-1',
      workspace: 'docs',
      taskId: 'run-1:a',
      payload: {
        id: 'approval-a',
        scope: 'task',
        runId: 'run-1',
        workspaceId: 'docs',
        planRevision: 2,
        taskId: 'run-1:a',
        approvalClasses: ['workspace-write'],
      },
    }),
    createAgentEvent('approval.requested', {
      origin: 'orchestrator',
      runId: 'run-1',
      workspace: 'docs',
      taskId: 'run-1:b',
      payload: {
        id: 'approval-b',
        scope: 'task',
        runId: 'run-1',
        workspaceId: 'docs',
        planRevision: 2,
        taskId: 'run-1:b',
        approvalClasses: ['publish'],
      },
    }),
    createAgentEvent('approval.granted', {
      origin: 'runtime',
      runId: 'run-1',
      workspace: 'docs',
      payload: {
        id: 'grant-1',
        scope: 'run',
        runId: 'run-1',
        workspaceId: 'docs',
        planRevision: 2,
        approvalClasses: ['workspace-write'],
      },
    }),
  ]);

  const byId = Object.fromEntries(projection.approvals.map((approval) => [approval.id, approval]));
  assert.equal(byId['approval-a'].status, 'approved');
  assert.equal(byId['approval-b'].status, 'pending_approval');
  assert.equal(byId['grant-1'].status, 'approved');
});

test('reduceAgentEvents: control queue is event sourced and follows run status', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('control_enqueued', {
      origin: 'runtime',
      workspace: 'docs',
      payload: {
        id: 'control-1',
        workspace: 'docs',
        input: 'Run after current task',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    }),
    createAgentEvent('control_enqueued', {
      origin: 'runtime',
      workspace: 'docs',
      payload: {
        id: 'control-2',
        workspace: 'docs',
        input: 'Never run',
        createdAt: '2026-01-01T00:00:01.000Z',
      },
    }),
    createAgentEvent('control_started', {
      origin: 'runtime',
      runId: 'run-control-1',
      workspace: 'docs',
      payload: { id: 'control-1', runId: 'run-control-1' },
    }),
    createAgentEvent('run_done', {
      origin: 'runtime',
      runId: 'run-control-1',
      workspace: 'docs',
    }),
    createAgentEvent('control_cancelled', {
      origin: 'runtime',
      workspace: 'docs',
      payload: { id: 'control-2' },
    }),
  ]);

  assert.equal(projection.controlQueue.length, 2);
  assert.equal(projection.controlQueue[0].id, 'control-1');
  assert.equal(projection.controlQueue[0].status, 'done');
  assert.equal(projection.controlQueue[0].runId, 'run-control-1');
  assert.equal(projection.controlQueue[1].id, 'control-2');
  assert.equal(projection.controlQueue[1].status, 'cancelled');
});

test('reduceAgentEvents: run_started prunes terminal control items and fully terminal chains', () => {
  const ts = '2026-01-01T00:00:00.000Z';
  const enqueue = (id, extra = {}) => createAgentEvent('control_enqueued', {
    origin: 'runtime',
    workspace: 'docs',
    payload: { id, workspace: 'docs', input: 'objective', createdAt: ts, ...extra },
  });
  const projection = reduceAgentEvents([
    // Fully terminal chain (done + skipped): becomes history, pruned.
    enqueue('chain-old-1', { chainId: 'chain-old', chainSequence: 1 }),
    enqueue('chain-old-2', { chainId: 'chain-old', chainSequence: 2 }),
    createAgentEvent('control_started', { origin: 'runtime', runId: 'run-old-1', workspace: 'docs', payload: { id: 'chain-old-1', runId: 'run-old-1' } }),
    createAgentEvent('run_done', { origin: 'runtime', runId: 'run-old-1', workspace: 'docs' }),
    createAgentEvent('control_skipped', { origin: 'runtime', workspace: 'docs', payload: { id: 'chain-old-2', reason: 'required_predecessor_failed' } }),
    // Standalone terminal item: pruned.
    enqueue('standalone-old'),
    createAgentEvent('control_cancelled', { origin: 'runtime', workspace: 'docs', payload: { id: 'standalone-old' } }),
    // Active chain (done + queued): must survive the prune.
    enqueue('chain-active-1', { chainId: 'chain-active', chainSequence: 1 }),
    enqueue('chain-active-2', { chainId: 'chain-active', chainSequence: 2 }),
    createAgentEvent('control_started', { origin: 'runtime', runId: 'run-active-1', workspace: 'docs', payload: { id: 'chain-active-1', runId: 'run-active-1' } }),
    createAgentEvent('run_done', { origin: 'runtime', runId: 'run-active-1', workspace: 'docs' }),
    // A new run starts: terminal relics are history, the active chain is not.
    createAgentEvent('run_started', { origin: 'runtime', runId: 'run-new', workspace: 'docs' }),
  ]);

  assert.deepEqual(projection.controlQueue.map((item) => item.id), ['chain-active-1', 'chain-active-2']);
});

test('reduceAgentEvents: control_enqueued preserves a structured capabilityPlan across replay', () => {
  const capabilityPlan = {
    capability: 'workspace.restore',
    operation: 'restore',
    arguments: { run: 'abc123' },
    requireApproval: true,
  };
  const projection = reduceAgentEvents([
    createAgentEvent('control_enqueued', {
      origin: 'runtime',
      workspace: 'docs',
      payload: {
        id: 'control-restore',
        workspace: 'docs',
        input: 'restore',
        createdAt: '2026-01-01T00:00:00.000Z',
        capabilityPlan,
      },
    }),
    createAgentEvent('control_started', {
      origin: 'runtime',
      runId: 'run-control-restore',
      workspace: 'docs',
      payload: { id: 'control-restore', runId: 'run-control-restore' },
    }),
  ]);

  const item = projection.controlQueue.find((entry) => entry.id === 'control-restore');
  assert.deepEqual(item.capabilityPlan, capabilityPlan);
  assert.equal(item.status, 'running');
});

test('reduceAgentEvents: chain metadata survives replay and control_skipped is terminal', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('control_enqueued', { payload: {
      id: 'chain-step-2', input: 'ingest', chainId: 'chain-1', chainSequence: 1,
      skillName: 'wiki-sync', optional: false, continueOnFailure: false,
    } }),
    createAgentEvent('control_skipped', { payload: { id: 'chain-step-2', reason: 'chain_cancelled' } }),
  ]);
  assert.equal(projection.controlQueue[0].chainId, 'chain-1');
  assert.equal(projection.controlQueue[0].chainSequence, 1);
  assert.equal(projection.controlQueue[0].skillName, 'wiki-sync');
  assert.equal(projection.controlQueue[0].status, 'skipped');
  assert.equal(projection.controlQueue[0].skipReason, 'chain_cancelled');
});

test('reduceAgentEvents: activity-owned plan is used when no orchestrator plan exists', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('activity_upserted', {
      origin: 'tool',
      payload: {
        activity: {
          key: 'production:job-1',
          id: 'job-1',
          source: 'production',
          label: 'Production build',
          status: 'running',
        },
      },
    }),
  ]);

  assert.equal(projection.plan.length, 1);
  assert.equal(projection.plan[0].description, 'Production build');
  assert.equal(projection.plan[0].owner, 'activity');
  assert.equal(projection.plan[0].ownerActivityKey, 'production:job-1');
});

test('dispatchAgentEvent: writes compatibility projections to session', () => {
  const session = {};
  dispatchAgentEvent(session, createAgentEvent('plan_set', {
    origin: 'tool',
    payload: { steps: ['Check status'] },
  }));
  assert.equal(session.agentEvents.length, 1);
  assert.equal(session.headlessPlan.length, 1);
  assert.equal(session.headlessPlan[0].description, 'Check status');
  assert.deepEqual(session.activities, {});
});

test('dispatchAgentEvent: assistant deltas do not rewrite session plan or activities', () => {
  let planUpdates = 0;
  const session = { _onPlanUpdate: () => { planUpdates += 1; } };
  dispatchAgentEvent(session, createAgentEvent('activity_upserted', {
    origin: 'tool',
    payload: {
      activity: {
        key: 'cme:export-1',
        id: 'export-1',
        source: 'cme',
        label: 'CME export',
        status: 'running',
      },
    },
  }));
  const activitiesRef = session.activities;
  const planRef = session.headlessPlan;
  const updatesAfterActivity = planUpdates;

  dispatchAgentEvent(session, createAgentEvent('assistant_delta', {
    origin: 'llm',
    payload: { delta: 'bonjour' },
  }));

  assert.strictEqual(session.activities, activitiesRef);
  assert.strictEqual(session.headlessPlan, planRef);
  assert.equal(planUpdates, updatesAfterActivity);
  assert.equal(session.agentProjection.conversation.at(-1).content, 'bonjour');
});

test('reduceAgentEvents: plan patches are proposed, approved and applied with revisions', () => {
  // plan_set bumps planRevision (it wholesale-replaces the plan), so a patch
  // proposed after it must target that new revision (1), not 0.
  const patch = {
    targetRunId: 'run-patch',
    basePlanRevision: 1,
    operations: [{ op: 'add_task', task: { id: 'task-b', description: 'B', dependsOn: ['task-a'] } }],
  };
  const projection = reduceAgentEvents([
    createAgentEvent('run_started', { origin: 'runtime', runId: 'run-patch' }),
    createAgentEvent('plan_set', {
      origin: 'tool',
      runId: 'run-patch',
      payload: { steps: [{ id: 'task-a', description: 'A', status: 'done' }] },
    }),
    createAgentEvent('plan_patch_proposed', {
      origin: 'runtime',
      runId: 'run-patch',
      payload: { id: 'patch-1', patch },
    }),
    createAgentEvent('plan_patch_approved', {
      origin: 'runtime',
      runId: 'run-patch',
      payload: { patchId: 'patch-1' },
    }),
    createAgentEvent('plan_patch_applied', {
      origin: 'runtime',
      runId: 'run-patch',
      payload: { patchId: 'patch-1', patch },
    }),
  ]);

  assert.equal(projection.planRevision, 2);
  assert.deepEqual(projection.plan.map((step) => step.id), ['task-a', 'task-b']);
  assert.equal(projection.plan[1].status, 'pending');
  assert.equal(projection.planPatches[0].status, 'applied');
});

test('streamed narration split across tool iterations yields separate conversation entries', () => {
  // graph.js finalizes the streaming entry (assistant_message content:'')
  // before each tool batch so per-iteration narrations do not glue together
  // into one wall of text.
  const session = {};
  dispatchAgentEvent(session, createAgentEvent('assistant_delta', { origin: 'llm', payload: { delta: 'Analyse des jobs récents.' } }));
  dispatchAgentEvent(session, createAgentEvent('assistant_message', { origin: 'llm', payload: { content: '' } }));
  dispatchAgentEvent(session, createAgentEvent('assistant_delta', { origin: 'llm', payload: { delta: 'Voyons les logs.' } }));
  dispatchAgentEvent(session, createAgentEvent('assistant_message', { origin: 'llm', payload: { content: 'Voyons les logs.' } }));

  const conversation = session.agentProjection.conversation;
  assert.equal(conversation.length, 2);
  assert.equal(conversation[0].content, 'Analyse des jobs récents.');
  assert.equal(conversation[0].streaming ?? false, false);
  assert.equal(conversation[1].content, 'Voyons les logs.');
});

test('empty assistant_message finalize is a no-op without a streaming entry', () => {
  const session = {};
  dispatchAgentEvent(session, createAgentEvent('assistant_message', { origin: 'llm', payload: { content: 'Réponse finale.' } }));
  dispatchAgentEvent(session, createAgentEvent('assistant_message', { origin: 'llm', payload: { content: '' } }));
  assert.equal(session.agentProjection.conversation.length, 1);
});

test('run_error cancels pending plan steps and active activities (no ghosts at relaunch)', () => {
  const session = {};
  dispatchAgentEvent(session, createAgentEvent('plan_set', {
    origin: 'runtime',
    payload: { steps: [
      { id: 'a', description: 'Ingest a.md', status: 'pending', requiredCapability: 'knowledge.update', operation: 'ingest_plan' },
      { id: 'b', description: 'Ingest b.md', status: 'done' },
    ] },
  }));
  dispatchAgentEvent(session, createAgentEvent('activity_upserted', {
    origin: 'runtime_poll',
    payload: { activity: { key: 'production:j1', id: 'j1', label: 'Ingest', status: 'running', terminal: false } },
  }));
  dispatchAgentEvent(session, createAgentEvent('run_error', {
    origin: 'runtime',
    payload: { message: 'Plan is stalled: no_ready_plan_task' },
  }));

  const plan = session.agentProjection.plan;
  assert.equal(plan.find((step) => step.id === 'a').status, 'cancelled');
  assert.equal(plan.find((step) => step.id === 'b').status, 'done', 'completed work stays done');
  const activity = session.agentProjection.activities.find((item) => item.id === 'j1');
  assert.equal(activity.status, 'cancelled');
  assert.equal(activity.terminal, true);
});

/*
 La cascade de statuts se terminait par `else step.status = 'done'` : un statut
 non énuméré était projeté en succès. Le runner marquait une tâche `skipped`
 faute de dépendance, la projection la déclarait faite, et le résumé comptait
 une réussite qui n'avait jamais eu lieu — le pire des défauts, celui qui
 transforme une inconnue en bonne nouvelle.
*/
test('reduceAgentEvents: un statut de plan inconnu ne devient pas un succès', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('plan_set', { origin: 'tool', payload: { steps: ['Ingest a', 'Ingest b'] } }),
    createAgentEvent('plan_step_updated', {
      origin: 'runtime',
      payload: { step: 1, status: 'skipped', reason: 'dependency_failed:convert' },
    }),
    createAgentEvent('plan_step_updated', {
      origin: 'runtime',
      payload: { step: 2, status: 'brouette' },
    }),
  ]);

  assert.equal(projection.plan[0].status, 'skipped');
  assert.equal(projection.plan[0].error?.code, 'dependency_failed');
  assert.match(projection.plan[0].error.message, /convert/);
  // Un statut incompréhensible laisse l'étape où elle était et se signale :
  // on ne sait pas ce qui s'est passé, le dire vaut mieux que d'inventer.
  assert.equal(projection.plan[1].status, 'pending');
  assert.equal(projection.logs.some((line) => /unknown status "brouette"/.test(line)), true);
});

test('reduceAgentEvents: les alias de statut tombent sur le canonique', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('plan_set', { origin: 'tool', payload: { steps: ['A', 'B', 'C'] } }),
    createAgentEvent('plan_step_updated', { origin: 'runtime', payload: { step: 1, status: 'succeeded' } }),
    createAgentEvent('plan_step_updated', { origin: 'runtime', payload: { step: 2, status: 'error' } }),
    // Contrat historique : un événement de fin sans statut vaut « terminé ».
    createAgentEvent('plan_step_updated', { origin: 'runtime', payload: { step: 3 } }),
  ]);

  assert.equal(projection.plan[0].status, 'done');
  assert.equal(projection.plan[1].status, 'failed');
  assert.equal(projection.plan[2].status, 'done');
  assert.equal(projection.logs.some((line) => /unknown status/.test(line)), false);
});

// La bulle « Request received · Donna is preparing… » n'est retirée côté serve
// que lorsqu'un message assistant NON VIDE arrive. Un tour sans réponse ne
// publiait rien : le point d'attente tournait jusqu'au rechargement de la page.
test('a discarded stream is emptied, never popped', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('user_message', { origin: 'user', payload: { content: 'question' } }),
    createAgentEvent('assistant_delta', { origin: 'runtime', payload: { delta: 'Je vais regarder…' } }),
    createAgentEvent('assistant_delta_reset', { origin: 'runtime', payload: {} }),
  ]);

  // La réconciliation de serve suppose une conversation en ajout seul : dépiler
  // la ferait passer sous le nombre d'éléments déjà rendus, laissant à l'écran
  // le texte qu'on voulait effacer et décalant tous les messages suivants.
  assert.equal(projection.conversation.length, 2);
  assert.deepEqual(projection.conversation[1], { role: 'assistant', content: '', streaming: true });
});

test('a stream resumed after a discard carries only the final text', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('user_message', { origin: 'user', payload: { content: 'question' } }),
    createAgentEvent('assistant_delta', { origin: 'runtime', payload: { delta: 'Je vais regarder…' } }),
    createAgentEvent('assistant_delta_reset', { origin: 'runtime', payload: {} }),
    createAgentEvent('assistant_delta', { origin: 'runtime', payload: { delta: '12 ' } }),
    createAgentEvent('assistant_delta', { origin: 'runtime', payload: { delta: 'pages.' } }),
    createAgentEvent('assistant_message', { origin: 'runtime', payload: { content: '12 pages.' } }),
  ]);

  assert.equal(projection.conversation.length, 2);
  assert.equal(projection.conversation[1].content, '12 pages.');
  assert.equal(projection.conversation[1].streaming, undefined, 'le message doit être figé');
});

test('run_error names the failure so the essential journal cannot filter it out', () => {
  // La liste de mots-clés du journal serve (failed, error, done, approval…)
  // rejetait un message qui n'en contient aucun — « No agent provides
  // capability workspace.restore. » — et le panneau affichait « No essential
  // run event yet » au-dessus d'un run mort avec sa raison déjà connue.
  const state = reduceAgentEvents([
    createAgentEvent('run_error', {
      origin: 'runtime',
      runId: 'run-1',
      payload: { message: 'No agent provides capability workspace.restore.' },
    }),
  ]);

  assert.equal(state.status, 'error');
  const line = state.logs.at(-1);
  assert.match(line, /^\d{2}:\d{2}:\d{2} Run failed: /);
  assert.match(line, /workspace\.restore/);
  // Le mot qui rend l'entrée « essentielle » pour le journal serve.
  assert.match(line, /failed/i);
});
