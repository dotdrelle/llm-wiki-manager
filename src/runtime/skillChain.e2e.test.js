import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { RESERVED_SLASH_COMMANDS } from '../core/skillInvocation.js';
import { startRuntimeServer as startRuntimeServerImpl } from './server.js';

// Plan V4.1 §58 — E2E-001..005.
//
// These drive the real HTTP surface with a stub `run` so the assertions are on
// what the runtime actually did: how many runs were started, in which order,
// under which chain, and what survived a cancel or a kill. The stub is the only
// fake — routing, compilation, drain and cancellation are the production code.

const SCAFFOLD_SKILLS = resolve('../llm-wiki/scaffold/workspace/.wiki/skills');

function startRuntimeServer(options) {
  return startRuntimeServerImpl({ token: '', ...options });
}

function workspaceWithSkills(files) {
  const root = mkdtempSync(join(tmpdir(), 'skill-chain-e2e-'));
  const skillDir = join(root, '.wiki', 'skills');
  mkdirSync(skillDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    if (body === null) {
      // Use the real shipped skill: the guard is worthless against a body
      // rewritten for the test.
      copyFileSync(join(SCAFFOLD_SKILLS, `${name}.md`), join(skillDir, `${name}.md`));
    } else {
      writeFileSync(join(skillDir, `${name}.md`), body);
    }
  }
  return root;
}

// Starts the server with a run stub that records every started run and finishes
// it on demand, so a chain can be observed step by step.
async function harness(t, { skills, autoFinish = true } = {}) {
  if (!existsSync(SCAFFOLD_SKILLS)) {
    t.skip('llm-wiki is not checked out next to llm-wiki-manager');
    return null;
  }
  const root = workspaceWithSkills(skills);
  const session = { workspace: 'acme', workspacePath: root, controlQueue: [] };
  const context = { workspace: 'acme', session, running: false, currentAbortController: null };
  const runs = [];
  const pending = [];
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: () => ({ status: 'idle', plan: [], queue: [], approvals: [] }),
        listEvents: () => [],
      },
      getContext: async () => context,
      run: async (ctx, body, { runId, signal } = {}) => {
        runs.push({ runId, input: body.input, capabilityPlan: body.capabilityPlan });
        if (autoFinish) {
          dispatchAgentEvent(ctx.session, createAgentEvent('run_done', { origin: 'runtime', runId }));
          return;
        }
        await new Promise((resolveRun) => {
          pending.push({ runId, finish: resolveRun });
          signal?.addEventListener('abort', () => resolveRun(), { once: true });
        });
      },
      cancel: async (ctx) => {
        dispatchAgentEvent(ctx.session, createAgentEvent('run_cancelled', {
          origin: 'runtime',
          runId: ctx.currentRunId,
        }));
      },
    });
  } catch (err) {
    if (err?.code === 'EPERM') {
      t.skip('network listen is not permitted in this sandbox');
      return null;
    }
    throw err;
  }
  const post = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const finishRun = async (runId) => {
    const entry = pending.find((item) => item.runId === runId);
    dispatchAgentEvent(session, createAgentEvent('run_done', { origin: 'runtime', runId }));
    entry?.finish();
    await settle();
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  t.after(async () => {
    context.currentAbortController?.abort();
    for (const entry of pending) entry.finish();
    await handle.close();
  });
  return { context, session, runs, post, finishRun, settle, chain: () => session.controlQueue };
}

test('E2E-001 pipeline: one objective, one run, internal plan left untouched', async (t) => {
  const env = await harness(t, { skills: { pipeline: null } });
  if (!env) return;

  const { status, body } = await env.post('/run?workspace=acme', { input: '/pipeline' });
  await env.settle();

  assert.equal(status, 202);
  assert.equal(body.kind, 'skill_chain');
  assert.equal(body.objectives, 1, 'pipeline must never be fragmented into sub-steps');
  assert.equal(env.runs.length, 1, 'one objective must produce exactly one run');
  // The run receives the business intention verbatim: nothing here pre-resolves
  // a capability or hands the dispatcher a plan, so the pipeline capability
  // keeps its own DAG and its own concurrency.
  assert.equal(env.runs[0].input, body.items[0].input);
  assert.equal(env.runs[0].capabilityPlan, undefined);
  assert.equal(env.chain().length, 1);
});

test('E2E-002 wiki-sync: two objectives, two ordered runs, one chainId', async (t) => {
  const env = await harness(t, { skills: { 'wiki-sync': null } });
  if (!env) return;

  const { body } = await env.post('/run?workspace=acme', { input: '/wiki-sync docs' });
  await env.settle();

  assert.equal(body.objectives, 2);
  assert.equal(env.runs.length, 2, 'the second objective must run after the first');
  assert.match(env.runs[0].input, /^Export the requested Confluence source/);
  assert.match(env.runs[1].input, /^Ingest the newly exported Markdown/);
  // CME first, Production second — and the parameter reaches the step that
  // consumes it, not only the last objective.
  for (const run of env.runs) assert.match(run.input, /User parameters:\nsource: docs/);
  const items = env.chain();
  assert.equal(items.length, 2);
  assert.equal(items[0].chainId, items[1].chainId);
  assert.equal(items[0].chainId, body.chainId);
  assert.deepEqual(items.map((item) => item.status), ['done', 'done']);
  assert.deepEqual(items.map((item) => item.skillName), ['wiki-sync', 'wiki-sync']);
});

test('E2E-003 cancel: the running step and its chain stop, unrelated queue survives', async (t) => {
  const env = await harness(t, {
    autoFinish: false,
    skills: {
      'three-step': '---\nname: three-step\nparams: []\n---\nCollect the sources.\n\nThen ingest them.\n\nThen publish the result.',
    },
  });
  if (!env) return;

  const { body } = await env.post('/run?workspace=acme', { input: '/three-step' });
  await env.settle();
  assert.equal(body.objectives, 3);

  // An unrelated request queued while the chain runs must not be collateral.
  await env.post('/run?workspace=acme', {
    input: 'unrelated structured work',
    intent: 'enqueue',
    capabilityPlan: { tasks: [{ id: 't1' }] },
  });
  await env.settle();

  await env.finishRun(env.runs[0].runId);
  assert.equal(env.runs.length, 2, 'step 2 must have started');

  const cancelled = await env.post('/cancel?workspace=acme');
  await env.settle();
  assert.equal(cancelled.status, 202);

  const items = env.chain();
  const chainItems = items.filter((item) => item.chainId === body.chainId);
  assert.equal(chainItems[0].status, 'done');
  assert.equal(chainItems[1].status, 'cancelled', 'the running step is cancelled');
  assert.equal(chainItems[2].status, 'skipped', 'the rest of the same chain is skipped');
  assert.equal(chainItems[2].skipReason, 'chain_cancelled');

  const unrelated = items.find((item) => !item.chainId);
  assert.ok(unrelated, 'the unrelated enqueue must still be in the queue');
  assert.notEqual(unrelated.status, 'skipped');
  assert.notEqual(unrelated.status, 'cancelled');
});

// Plan V4.1 §57 — performance gate. The compiler test already locks the
// objective counts; what has to be guarded here is the step after it: one
// objective must become exactly one run, and therefore exactly one
// resolveObjective call, since prepareDelegation resolves once per run. A skill
// that silently fragments would show up as extra runs, not as extra objectives.
const PERFORMANCE_TABLE = {
  pipeline: 1,
  'wiki-ingest': 1,
  'wiki-build': 1,
  deliver: 1,
  diagnose: 1,
  status: 1,
  'new-template': 1,
  'wiki-sync': 2,
};

for (const [name, expected] of Object.entries(PERFORMANCE_TABLE)) {
  test(`§57 performance gate: ${name} compiles to ${expected} objective(s) and ${expected} run(s)`, async (t) => {
    const env = await harness(t, { skills: { [name]: null } });
    if (!env) return;
    // `status` collides with a built-in slash command: it is reachable only
    // through the explicit `/skills run status` path, which carries skillName.
    const reserved = RESERVED_SLASH_COMMANDS.has(name);
    const { body } = await env.post('/run?workspace=acme', {
      input: `/${name}`,
      ...(reserved ? { skillName: name } : {}),
    });
    await env.settle();
    assert.equal(body.kind, 'skill_chain', reserved ? 'reserved names need skillName' : 'plain invocation');
    assert.equal(body.objectives, expected, 'objective count');
    assert.equal(env.runs.length, expected, 'run count');
    assert.equal(env.chain().length, expected, 'control items');
    // One run carries one whole intention: never a pre-resolved capability plan.
    for (const run of env.runs) assert.equal(run.capabilityPlan, undefined);
  });
}

test('E2E-004 kill: the whole workspace queue is purged, chain or not', async (t) => {
  // /run cancel is chain-scoped by design; /run kill deliberately is not, and
  // that asymmetry is the invariant worth guarding.
  const env = await harness(t, {
    autoFinish: false,
    skills: {
      'two-step': '---\nname: two-step\nparams: []\n---\nCollect the sources.\n\nThen ingest them.',
    },
  });
  if (!env) return;

  await env.post('/run?workspace=acme', { input: '/two-step' });
  await env.settle();
  await env.post('/run?workspace=acme', {
    input: 'unrelated structured work',
    intent: 'enqueue',
    capabilityPlan: { tasks: [{ id: 't1' }] },
  });
  await env.settle();
  assert.equal(env.chain().filter((item) => item.status === 'queued').length, 2);

  const killed = await env.post('/kill?workspace=acme');
  await env.settle();

  assert.equal(killed.status, 202);
  assert.equal(killed.body.killed, true);
  assert.equal(
    env.chain().some((item) => item.status === 'queued'),
    false,
    'kill leaves nothing queued, unlike cancel',
  );
});

test('E2E-005 legacy: a structured enqueue keeps carrying its capabilityPlan', async (t) => {
  const env = await harness(t, {
    autoFinish: false,
    skills: { 'one-step': '---\nname: one-step\nparams: []\n---\nDo the whole thing in one go.' },
  });
  if (!env) return;

  await env.post('/run?workspace=acme', { input: '/one-step' });
  await env.settle();

  const plan = { tasks: [{ id: 't1', requiredCapability: 'knowledge.ingest' }] };
  const enqueued = await env.post('/run?workspace=acme', {
    input: 'ingest the pending files',
    intent: 'enqueue',
    capabilityPlan: plan,
  });
  await env.settle();

  assert.equal(enqueued.status, 202);
  const queued = env.chain().find((item) => !item.chainId);
  assert.deepEqual(queued.capabilityPlan, plan, 'the structured plan must survive the queue');

  // …and reach the run untouched once the chain step ahead of it completes.
  await env.finishRun(env.runs[0].runId);
  const structuredRun = env.runs.find((run) => run.capabilityPlan);
  assert.deepEqual(structuredRun?.capabilityPlan, plan);
});
