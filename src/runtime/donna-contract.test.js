import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { runRuntimeAgenticWorkflow } from './runner.js';
import { startRuntimeServer } from './server.js';

// Executable version of plan-0.11.5-hotfix-final.md §3 ("La recette — le seul
// critère de sortie qui compte"). Each test below is one row of that table,
// referenced by its recipe number. Correctifs 1-3 and 8 (runner.js's
// conversational short-circuit, plan sanitization, and no-replan-on-vague
// paths) are exercised with a mocked agent standing in for the LLM's
// per-turn decision, exactly like the existing runner.test.js unit tests --
// this file's job is traceability to the recipe, not a new test seam.
// Recipes 4-6 drive the real scheduler (runAgenticLoop / runRuntimeParallelPlan,
// imported and executed for real, never reimplemented). Recipe 7 drives the
// real control-lane HTTP endpoint. Per plan §4.1: this file is the CI gate --
// no release ships while it is red.

function baseSession(overrides = {}) {
  return { activities: {}, headlessPlan: null, ...overrides };
}

function eventTypes(session) {
  return (session.agentEvents ?? []).map((event) => event.type);
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('condition was not met before timeout');
}

test('Recipe #1 — "salut" gets a plain reply: no plan, no activity, no job, run done', async () => {
  const session = baseSession({
    llm: {
      async completeWithTools() {
        assert.fail('a plain greeting must never reach the evaluator or replanner');
      },
    },
  });
  const agent = {
    async invoke() {
      return { response: 'Bonjour ! Comment puis-je vous aider ?' };
    },
  };

  const result = await runRuntimeAgenticWorkflow(agent, session, 'salut', {
    runId: 'recipe-1',
    timeoutMs: 1000,
    maxTurns: 1,
    maxReplans: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(session.headlessPlan, null);
  assert.equal(Object.keys(session.activities).length, 0);
  const types = eventTypes(session);
  assert.ok(types.includes('run_done'));
  assert.equal(types.includes('run_evaluated'), false);
  assert.equal(types.includes('run_replanned'), false);
  assert.equal(types.includes('tool_call_started'), false);
  assert.equal(types.includes('plan_set'), false);
});

test('Recipe #2 — "quel est le profil actif ?" answers in conversation, never poses a plan', async () => {
  const session = baseSession({
    llm: {
      async completeWithTools() {
        assert.fail('a read-only config question must never reach the evaluator or replanner');
      },
    },
  });
  const agent = {
    async invoke({ session: turnSession }) {
      dispatchAgentEvent(turnSession, createAgentEvent('tool_call_started', {
        origin: 'tool',
        payload: { name: 'shell.status', args: '{}', summary: 'calling...' },
      }));
      dispatchAgentEvent(turnSession, createAgentEvent('tool_call_result', {
        origin: 'tool',
        payload: { name: 'shell.status', ok: true, result: 'profile: albert-openai (mistral-large)', summary: 'done' },
      }));
      return { response: 'Le profil actif est albert-openai (mistral-large).' };
    },
  };

  const result = await runRuntimeAgenticWorkflow(agent, session, 'quel est le profil actif ?', {
    runId: 'recipe-2',
    timeoutMs: 1000,
    maxTurns: 1,
    maxReplans: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(session.headlessPlan, null);
  const types = eventTypes(session);
  assert.ok(types.includes('tool_call_started'));
  assert.ok(types.includes('run_done'));
  assert.equal(types.includes('plan_set'), false);
  assert.equal(types.includes('run_evaluated'), false);
});

test('Recipe #3 — "où en est le dernier build ?" reads status, starts no new production run', async () => {
  const session = baseSession({
    llm: {
      async completeWithTools() {
        assert.fail('a status question must never reach the evaluator or replanner');
      },
    },
  });
  const agent = {
    async invoke({ session: turnSession }) {
      dispatchAgentEvent(turnSession, createAgentEvent('tool_call_started', {
        origin: 'tool',
        payload: { name: 'production.production_job_status', args: '{}', summary: 'calling...' },
      }));
      dispatchAgentEvent(turnSession, createAgentEvent('tool_call_result', {
        origin: 'tool',
        payload: { name: 'production.production_job_status', ok: true, result: 'last build: done', summary: 'done' },
      }));
      return { response: 'Le dernier build est terminé avec succès.' };
    },
  };

  const result = await runRuntimeAgenticWorkflow(agent, session, 'où en est le dernier build ?', {
    runId: 'recipe-3',
    timeoutMs: 1000,
    maxTurns: 1,
    maxReplans: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(session.headlessPlan, null);
  assert.equal(Object.keys(session.activities).length, 0);
  const types = eventTypes(session);
  assert.equal(types.includes('activity_upserted'), false);
  assert.equal(types.includes('plan_set'), false);
});

function buildSingleTaskAgent({ taskId, description, finalResponse }) {
  let turn = 0;
  return {
    async invoke({ session: turnSession }) {
      turn += 1;
      if (turn === 1) {
        dispatchAgentEvent(turnSession, createAgentEvent('plan_set', {
          origin: 'tool',
          payload: { steps: [{ step: 1, id: taskId, description, status: 'pending', dependsOn: [] }] },
        }));
        return { response: `Je lance ${description}.` };
      }
      dispatchAgentEvent(turnSession, createAgentEvent('plan_step_updated', {
        origin: 'tool',
        payload: { step: 1, status: 'done' },
      }));
      return { response: finalResponse };
    },
  };
}

test('Recipe #4 — "lance le doctor": one-task plan, progress visible, summarized result', async () => {
  const session = baseSession();
  const agent = buildSingleTaskAgent({
    taskId: 'doctor',
    description: 'Diagnostic doctor',
    finalResponse: 'Doctor terminé : aucun problème détecté.',
  });

  const result = await runRuntimeAgenticWorkflow(agent, session, 'lance le doctor', {
    runId: 'recipe-4',
    timeoutMs: 1000,
    maxTurns: 3,
    maxReplans: 1,
    evaluate: false,
  });

  assert.equal(result.ok, true);
  assert.equal(session.headlessPlan.length, 1);
  assert.equal(session.headlessPlan[0].status, 'done');
  const types = eventTypes(session);
  assert.deepEqual(types.filter((type) => type === 'plan_set' || type === 'plan_step_updated'), ['plan_set', 'plan_step_updated']);
  assert.ok(types.includes('run_done'));
  assert.equal(session.agentProjection.conversation.at(-1).content, 'Doctor terminé : aucun problème détecté.');
});

test('Recipe #5 — "construis le livrable X": plan posed, job runs, progress, done, summarized', async () => {
  const session = baseSession();
  const agent = buildSingleTaskAgent({
    taskId: 'build-x',
    description: 'Construire le livrable X',
    finalResponse: 'Le livrable X est construit.',
  });

  const result = await runRuntimeAgenticWorkflow(agent, session, 'construis le livrable X', {
    runId: 'recipe-5',
    timeoutMs: 1000,
    maxTurns: 3,
    maxReplans: 1,
    evaluate: false,
  });

  assert.equal(result.ok, true);
  assert.equal(session.headlessPlan[0].status, 'done');
  assert.ok(eventTypes(session).includes('run_done'));
  assert.equal(session.agentProjection.conversation.at(-1).content, 'Le livrable X est construit.');
});

function buildTwoParallelTasksAgent() {
  const started = [];
  const release = {};
  let parentTurnDone = false;
  return {
    started,
    release,
    async invoke({ input, session: turnSession }) {
      const taskMatch = input.match(/Task id: (\w+)/);
      if (!taskMatch) {
        if (!parentTurnDone) {
          parentTurnDone = true;
          dispatchAgentEvent(turnSession, createAgentEvent('plan_set', {
            origin: 'tool',
            payload: {
              steps: [
                { step: 1, id: 'x', description: 'Construire X', status: 'pending', dependsOn: [] },
                { step: 2, id: 'y', description: 'Construire Y', status: 'pending', dependsOn: [] },
              ],
            },
          }));
          return { response: 'Je construis X et Y en parallèle.' };
        }
        return { response: 'X et Y sont construits.' };
      }
      const id = taskMatch[1];
      started.push(id);
      await new Promise((resolve) => { release[id] = resolve; });
      return { response: `${id} construit.` };
    },
  };
}

test('Recipe #6 — "construis X et Y": two tasks run in parallel, converge, done', async () => {
  const session = baseSession();
  const agent = buildTwoParallelTasksAgent();

  const running = runRuntimeAgenticWorkflow(agent, session, 'construis X et Y', {
    runId: 'recipe-6',
    timeoutMs: 2000,
    maxTurns: 3,
    maxReplans: 1,
    evaluate: false,
  });

  await waitFor(() => agent.started.includes('x') && agent.started.includes('y'));
  assert.deepEqual(
    session.headlessPlan.filter((step) => ['x', 'y'].includes(step.id)).map((step) => step.status),
    ['running', 'running'],
  );
  agent.release.x();
  agent.release.y();

  const result = await running;

  assert.equal(result.ok, true);
  assert.deepEqual(session.headlessPlan.map((step) => step.status), ['done', 'done']);
});

test('Recipe #7 — "où en es-tu ?" during an active run: status in conversation, run continues, no new run', async (t) => {
  const session = { workspace: 'juno', controlQueue: [] };
  let runCount = 0;
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: () => ({
          status: 'running',
          plan: [{ step: 1, description: 'Construire le livrable X', status: 'running' }],
          queue: [],
          approvals: [],
          summary: null,
        }),
        listEvents: () => [],
      },
      getContext: async () => ({
        workspace: 'juno',
        session,
        running: true,
        currentAbortController: new AbortController(),
      }),
      run: async () => { runCount += 1; },
    });
  } catch (err) {
    if (err?.code === 'EPERM') {
      t.skip('network listen is not permitted in this sandbox');
      return;
    }
    throw err;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/control?workspace=juno`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'message', input: 'où en es-tu ?' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.kind, 'observe');
    assert.match(body.explanation, /Construire le livrable X/);
    assert.equal(session.controlQueue.length, 0);
    assert.equal(runCount, 0);
  } finally {
    await handle.close();
  }
});

test('Recipe #8 — vague request gets clarification, never a job, never boilerplate', async () => {
  const session = baseSession({
    headlessPlan: [{ step: 1, id: 'task', description: 'Task', status: 'done' }],
    llm: {
      async completeWithTools({ system }) {
        assert.match(system, /strict evaluator/);
        return { content: '{"ok":false,"reason":"demande vague / objectif indefini","suggestedAction":"clarifier l objectif"}' };
      },
    },
  });
  const agent = {
    async invoke({ session: turnSession }) {
      if (turnSession.headlessPlan === null) {
        dispatchAgentEvent(turnSession, createAgentEvent('plan_set', {
          origin: 'tool',
          payload: { steps: [{ step: 1, id: 'task', description: 'Task', status: 'done' }] },
        }));
      }
      return { response: 'Terminé.' };
    },
  };

  const result = await runRuntimeAgenticWorkflow(agent, session, 'dis-moi une bêtise puis stop', {
    runId: 'recipe-8',
    timeoutMs: 1000,
    maxTurns: 1,
    maxReplans: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.clarified, true);
  const lastMessage = session.agentProjection.conversation.at(-1).content;
  assert.ok(lastMessage.includes('clarifier'));
  assert.doesNotMatch(lastMessage, /Donna is active|Plan is stalled/i);
  const types = eventTypes(session);
  assert.equal(types.includes('run_replanned'), false);
  assert.equal(types.includes('tool_call_started'), false);
});
