import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentEvent, dispatchAgentEvent, reduceAgentEvents } from './agentEvents.js';

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
