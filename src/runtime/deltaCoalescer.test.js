import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeltaCoalescer } from './deltaCoalescer.js';

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('coalesces fragments pushed within the interval into one flush', async () => {
  const flushed = [];
  const coalescer = createDeltaCoalescer((delta) => flushed.push(delta), { intervalMs: 20 });
  coalescer.push('Bon');
  coalescer.push('jour ');
  coalescer.push('le monde.');
  assert.deepEqual(flushed, [], 'rien ne doit partir avant l\'intervalle');
  await tick(35);
  assert.deepEqual(flushed, ['Bonjour le monde.']);
});

test('flush() emits the buffered fragments immediately, in order', () => {
  const flushed = [];
  const coalescer = createDeltaCoalescer((delta) => flushed.push(delta), { intervalMs: 1000 });
  coalescer.push('a');
  coalescer.push('b');
  coalescer.flush();
  assert.deepEqual(flushed, ['ab']);
  // Nothing left to flush twice.
  coalescer.flush();
  assert.deepEqual(flushed, ['ab']);
});

test('reset() drops buffered provisional narration', () => {
  const flushed = [];
  const coalescer = createDeltaCoalescer((delta) => flushed.push(delta), { intervalMs: 1000 });
  coalescer.push('je vais regarder…');
  coalescer.reset();
  coalescer.flush();
  assert.deepEqual(flushed, []);
});

test('a single flush covers fragments that arrive after a first flush', async () => {
  const flushed = [];
  const coalescer = createDeltaCoalescer((delta) => flushed.push(delta), { intervalMs: 20 });
  coalescer.push('un ');
  await tick(30);
  coalescer.push('deux');
  await tick(30);
  assert.deepEqual(flushed, ['un ', 'deux']);
});

test('dispose() stops the pending timer without emitting', async () => {
  const flushed = [];
  const coalescer = createDeltaCoalescer((delta) => flushed.push(delta), { intervalMs: 20 });
  coalescer.push('perdu');
  coalescer.dispose();
  await tick(40);
  assert.deepEqual(flushed, []);
});
