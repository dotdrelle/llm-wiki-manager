import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyControlMessage } from './server.js';

const running = { running: true };

// A bare "yes" answers the runtime's own last prompt. Anything MORE than a
// bare yes is a request, and the rule used to be prefix-anchored only: every
// message merely STARTING on a yes was classified `observe` and answered with
// a status report, shadowing the modify_run and enqueue_run branches below it.
test('a bare confirmation during a run is a status check', async () => {
  for (const input of ['oui', 'OK', 'vas-y', "d'accord", 'yes.', 'entendu !']) {
    const result = await classifyControlMessage(input, running);
    assert.equal(result.kind, 'observe', `expected observe for ${JSON.stringify(input)}`);
  }
});

test('a plan change that merely opens on a yes is still a plan change', async () => {
  const result = await classifyControlMessage(
    'oui, ajoute une étape de polish après le build',
    running,
  );
  assert.equal(result.kind, 'modify_run');
});

test('a new task that opens on a yes reaches the model classifier, not the status branch', async () => {
  const result = await classifyControlMessage("vas-y lance l'export", running, {
    llm: { complete: async () => 'action' },
  });
  assert.equal(result.kind, 'enqueue_run');
});
