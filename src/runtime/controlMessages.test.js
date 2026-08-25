import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlMessage } from './controlMessages.js';

test('controlMessage returns the deterministic English acknowledgement regardless of locale', () => {
  assert.match(controlMessage({ language: 'fr-FR' }, 'queued_for_future_run'), /added to the queue/);
  assert.match(controlMessage({ language: 'es' }, 'queued_for_future_run'), /added to the queue/);
  assert.match(controlMessage(null, 'queued_for_future_run'), /added to the queue/);
});

test('controlMessage keeps every key in English and throws on unknown keys', () => {
  assert.match(controlMessage({ language: 'fr' }, 'ambiguous_control'), /queue it/);
  assert.match(controlMessage({ language: 'fr' }, 'converse_while_idle'), /treated as conversation/);
  assert.throws(() => controlMessage({ language: 'fr-FR' }, 'nope'), /Unknown control message key/);
});
