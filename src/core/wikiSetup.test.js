import assert from 'node:assert/strict';
import test from 'node:test';

import { startAgents } from './wikiSetup.js';

const CONTEXT = {
  exists: true,
  args: [],
  profiles: ['connectors'],
  expectedProfileServices: ['connectors'],
  composeFiles: [],
};

function startOptions(overrides = {}) {
  return {
    composeContext: CONTEXT,
    imagesCheck: async () => [],
    exec: async () => ({ stdout: 'started', stderr: '' }),
    ...overrides,
  };
}

test('starting the agents succeeds when every enabled service is running', async () => {
  const result = await startAgents(startOptions({ agentsCheck: async () => null }));
  assert.equal(result.output, 'started');
  assert.deepEqual(result.profiles, ['connectors']);
});

test('an enabled connector that never started makes the start fail, not succeed', async () => {
  // The script exits 0 whether or not the profiled container came up, so
  // trusting its exit code alone reported success while connectors was absent
  // — the operator only found out much later, through a silent preflight line.
  await assert.rejects(
    startAgents(startOptions({
      agentsCheck: async () => ({ kind: 'agents', context: { missingServices: ['connectors'], profiles: ['connectors'] } }),
    })),
    (err) => {
      assert.equal(err.name, 'AgentsNotRunningError');
      assert.deepEqual(err.missingServices, ['connectors']);
      assert.match(err.message, /never started: connectors/);
      assert.match(err.message, /Active profiles: connectors\./);
      return true;
    },
  );
});

test('a listed but stopped service also fails the start', async () => {
  await assert.rejects(
    startAgents(startOptions({
      agentsCheck: async () => ({ kind: 'agents', context: { downServices: ['cme'] } }),
    })),
    (err) => {
      assert.equal(err.name, 'AgentsNotRunningError');
      assert.deepEqual(err.downServices, ['cme']);
      assert.match(err.message, /not running: cme/);
      return true;
    },
  );
});

test('the verification runs against the same compose context as the start', async () => {
  let seen = null;
  await startAgents(startOptions({
    agentsCheck: async ({ context }) => { seen = context; return null; },
  }));
  assert.equal(seen, CONTEXT);
});

test('the manager .env values override stale blank process values for agents up', async () => {
  let childEnv = null;
  const context = {
    ...CONTEXT,
    env: {
      ...process.env,
      GOOGLE_OAUTH_CLIENT_SECRET: 'fresh-secret',
    },
  };
  await startAgents(startOptions({
    composeContext: context,
    agentsCheck: async () => null,
    exec: async (_file, _args, options) => {
      childEnv = options.env;
      return { stdout: 'started', stderr: '' };
    },
  }));
  assert.equal(childEnv.GOOGLE_OAUTH_CLIENT_SECRET, 'fresh-secret');
});

test('an optional agent that refuses to start degrades instead of failing /start all', async () => {
  // The gateway image not being pulled yet makes `docker compose up` exit
  // non-zero while the base stack still comes up. Aborting there made
  // `/start all` stop before the workspace services — the optional tail
  // wagging the whole dog. With the base agents verified up, the start
  // returns a degraded result the caller can continue from.
  const result = await startAgents(startOptions({
    exec: async () => {
      const err = new Error('pull access denied for dotdrelle/wiki-agentic-gateway:latest');
      err.code = 1;
      throw err;
    },
    agentsCheck: async () => null,
  }));

  assert.equal(result.degraded, true);
  assert.match(result.output, /started degraded/);
  assert.match(result.output, /wiki-agentic-gateway/);
  assert.deepEqual(result.profiles, ['connectors']);
});

test('a docker failure that leaves the base agents down still fails the start', async () => {
  await assert.rejects(
    startAgents(startOptions({
      exec: async () => {
        const err = new Error('Cannot connect to the Docker daemon');
        err.code = 1;
        throw err;
      },
      agentsCheck: async () => ({ kind: 'agents', context: { downServices: ['cme', 'documents'] } }),
    })),
    /Docker daemon is not running/,
  );
});
