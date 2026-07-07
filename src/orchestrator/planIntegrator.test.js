import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { openRuntimeStore } from '../runtime/store.js';
import { integrate } from './planIntegrator.js';

function registry() {
  return {
    providersFor(capability) {
      if (capability !== 'knowledge.update') return [];
      return [{
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
            properties: {
              inputs: { type: 'array', items: { type: 'string' } },
            },
          },
          outputSchema: {},
          supportedOperations: ['ingest'],
          mutationClass: 'workspace',
          defaultRequiresApproval: true,
        },
        description: { contractVersion: '1' },
      }];
    },
    isCompatible(contractVersion) {
      return String(contractVersion) === '1';
    },
  };
}

function fragment(tasks = [task('ingest-a')]) {
  return {
    contractVersion: '1',
    agentInstanceId: 'production-main',
    capability: 'knowledge.update',
    summary: {
      label: 'Update knowledge',
      initialSynthesis: ['Ingest sources.'],
      estimatedTasks: tasks.length,
    },
    groups: [{
      id: 'ingest',
      label: 'Ingest sources',
      recommendedConcurrency: 2,
      progressWeight: tasks.length,
    }],
    tasks,
    expectedOutputs: [{ type: 'directory', ref: 'wiki' }],
  };
}

function task(id, dependsOn = []) {
  return {
    id,
    label: `Task ${id}`,
    requiredCapability: 'knowledge.update',
    operation: 'ingest',
    arguments: { inputs: [`raw/untracked/${id}.md`] },
    groupId: 'ingest',
    dependsOn,
    parallelizable: true,
    inputRefs: [{ type: 'file', ref: `raw/untracked/${id}.md` }],
    expectedOutputRefs: [{ type: 'file', ref: `.wiki/ingest-plans/${id}.json` }],
    locks: ['workspace-write'],
    requiresApproval: true,
    idempotencyKey: `idem-${id}`,
    progressWeight: 1,
  };
}

function storeAndSession() {
  const store = openRuntimeStore({ stateDir: mkdtempSync(join(tmpdir(), 'wiki-manager-plan-integrator-')) });
  const session = { activities: {}, headlessPlan: null };
  return { store, session };
}

test('planIntegrator integrates an initial fragment, persists DAG tables and emits events', () => {
  const { store, session } = storeAndSession();
  const result = integrate('run-1', fragment(), {
    registry: registry(),
    session,
    store,
    workspace: 'docs',
    now: () => new Date('2026-07-07T10:00:00.000Z'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.planRevision, 1);
  assert.deepEqual(session.headlessPlan.map((item) => item.id), ['run-1:ingest-a']);
  assert.deepEqual(result.readyTasks.map((item) => item.id), ['run-1:ingest-a']);
  assert.deepEqual(session.agentEvents.map((event) => event.type), [
    'plan.received',
    'plan.validated',
    'task_group.created',
    'task.created',
    'plan.revision_changed',
  ]);
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get().name, 'tasks');
  assert.equal(store.listTasks({ runId: 'run-1' })[0].id, 'run-1:ingest-a');
  assert.equal(store.listTaskDependencies({ runId: 'run-1' }).length, 0);
  assert.equal(store.listPlanRevisions({ runId: 'run-1' })[0].revision, 1);
  store.close();
});

test('planIntegrator inserts before a task and rewires its dependencies', () => {
  const { store, session } = storeAndSession();
  integrate('run-2', fragment([task('a'), task('b', ['a'])]), { registry: registry(), session, store, workspace: 'docs' });

  const result = integrate('run-2', fragment([task('x')]), {
    registry: registry(),
    session,
    store,
    workspace: 'docs',
    insertBeforeTasks: ['run-2:b'],
  });

  assert.equal(result.ok, true);
  const plan = Object.fromEntries(session.headlessPlan.map((item) => [item.id, item]));
  assert.deepEqual(plan['run-2:x'].dependsOn, ['run-2:a']);
  assert.deepEqual(plan['run-2:b'].dependsOn, ['run-2:x']);
  assert.ok(store.listTaskDependencies({ runId: 'run-2' }).some((dep) => dep.taskId === 'run-2:b' && dep.dependsOnTaskId === 'run-2:x'));
  assert.equal(session.planRevision, 2);
  store.close();
});

test('planIntegrator inserts after a task and rewires existing dependents', () => {
  const { store, session } = storeAndSession();
  integrate('run-3', fragment([task('a'), task('b', ['a'])]), { registry: registry(), session, store, workspace: 'docs' });

  const result = integrate('run-3', fragment([task('x')]), {
    registry: registry(),
    session,
    store,
    workspace: 'docs',
    insertAfterTasks: ['run-3:a'],
  });

  assert.equal(result.ok, true);
  const plan = Object.fromEntries(session.headlessPlan.map((item) => [item.id, item]));
  assert.deepEqual(plan['run-3:x'].dependsOn, ['run-3:a']);
  assert.deepEqual(plan['run-3:b'].dependsOn, ['run-3:x']);
  store.close();
});

test('planIntegrator resolves global id collisions', () => {
  const { store, session } = storeAndSession();
  integrate('run-4', fragment([task('a')]), { registry: registry(), session, store, workspace: 'docs' });
  const result = integrate('run-4', fragment([task('a')]), { registry: registry(), session, store, workspace: 'docs' });

  assert.equal(result.ok, true);
  assert.deepEqual(session.headlessPlan.map((item) => item.id), ['run-4:a', 'run-4:a-2']);
  assert.deepEqual(store.listTasks({ runId: 'run-4' }).map((item) => item.id), ['run-4:a', 'run-4:a-2']);
  store.close();
});

test('planIntegrator rejects insertions that would modify a terminal task', () => {
  const { store, session } = storeAndSession();
  integrate('run-5', fragment([task('a')]), { registry: registry(), session, store, workspace: 'docs' });
  dispatchAgentEvent(session, createAgentEvent('plan_step_updated', {
    origin: 'test',
    runId: 'run-5',
    workspace: 'docs',
    taskId: 'run-5:a',
    payload: { taskId: 'run-5:a', status: 'done' },
  }));

  const result = integrate('run-5', fragment([task('x')]), {
    registry: registry(),
    session,
    store,
    workspace: 'docs',
    insertBeforeTasks: ['run-5:a'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'terminal_task_mutation');
  assert.equal(session.headlessPlan.length, 1);
  assert.equal(session.agentEvents.at(-1).type, 'plan.rejected');
  store.close();
});

test('planIntegrator replay reconstructs the same DAG projection', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-plan-integrator-'));
  const store = openRuntimeStore({ stateDir });
  const session = { activities: {}, headlessPlan: null };
  integrate('run-6', fragment([task('a'), task('b', ['a'])]), { registry: registry(), session, store, workspace: 'docs' });
  const originalPlan = session.headlessPlan.map(({ id, dependsOn, status }) => ({ id, dependsOn, status }));
  store.close();

  const reopened = openRuntimeStore({ stateDir });
  const replayed = { activities: {}, headlessPlan: null };
  reopened.hydrateSession(replayed, { workspace: 'docs' });
  assert.deepEqual(
    replayed.headlessPlan.map(({ id, dependsOn, status }) => ({ id, dependsOn, status })),
    originalPlan,
  );
  reopened.close();
});
