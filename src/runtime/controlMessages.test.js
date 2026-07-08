import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlLanguage, controlMessage } from './controlMessages.js';

test('controlLanguage maps fr locales to fr and everything else to en', () => {
  assert.equal(controlLanguage({ language: 'fr-FR' }), 'fr');
  assert.equal(controlLanguage({ language: 'fr' }), 'fr');
  assert.equal(controlLanguage({ language: 'en-US' }), 'en');
  assert.equal(controlLanguage({ language: null }), 'en');
  assert.equal(controlLanguage(null), 'en');
});

test('controlMessage returns the localized queued acknowledgement', () => {
  assert.match(controlMessage({ language: 'fr-FR' }, 'queued_for_future_run'), /ajoutée à la file/);
  assert.match(controlMessage({ language: 'en-US' }, 'queued_for_future_run'), /added to the queue/);
});

test('controlMessage falls back to en for unknown locales and throws on unknown keys', () => {
  assert.match(controlMessage({ language: 'de-DE' }, 'queued_for_future_run'), /added to the queue/);
  assert.throws(() => controlMessage({ language: 'fr-FR' }, 'nope'), /Unknown control message key/);
});
