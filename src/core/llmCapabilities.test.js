import assert from 'node:assert/strict';
import test from 'node:test';
import { bareModelName, supportsTemperature } from './llmCapabilities.js';

test('bareModelName strips a gateway prefix', () => {
  assert.equal(bareModelName('openai/gpt-5-mini'), 'gpt-5-mini');
  assert.equal(bareModelName('gpt-4.1'), 'gpt-4.1');
  assert.equal(bareModelName(undefined), '');
});

test('gpt-5 refuses temperature behind a gateway or an openai engine', () => {
  assert.equal(supportsTemperature({ model: 'openai/gpt-5-mini', provider: 'ai-gateway' }), false);
  assert.equal(supportsTemperature({ model: 'gpt-5', engine: 'openai' }), false);
  assert.equal(supportsTemperature({ model: 'gpt-5.4-mini', provider: 'ai-gateway' }), false);
});

test('gpt-5 on a non-openai engine keeps temperature', () => {
  // A local server serving a model merely NAMED gpt-5 is not OpenAI.
  assert.equal(supportsTemperature({ model: 'gpt-5', engine: 'vllm' }), true);
  assert.equal(supportsTemperature({ model: 'gpt-5', provider: 'openai-compatible' }), true);
});

test('every other model keeps temperature', () => {
  assert.equal(supportsTemperature({ model: 'gpt-4.1', provider: 'ai-gateway' }), true);
  assert.equal(supportsTemperature({ model: 'claude-3-5-sonnet' }), true);
  assert.equal(supportsTemperature({}), true);
});
