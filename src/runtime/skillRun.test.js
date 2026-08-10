import assert from 'node:assert/strict';
import test from 'node:test';
import { runSkillChain, validateNamedSkillArguments } from './skillRun.js';

const skill = { name: 'deliver', params: ['template', 'polish'], body: 'Deliver the requested output.' };

test('named skill arguments preserve spaces and fill omitted declarations with empty strings', () => {
  const args = validateNamedSkillArguments(skill, { template: 'Quarterly report' });
  assert.equal(Object.getPrototypeOf(args), null);
  assert.deepEqual({ ...args }, { template: 'Quarterly report', polish: '' });
});

test('named skill arguments reject undeclared, non-string, and oversized values', () => {
  assert.throws(() => validateNamedSkillArguments(skill, { target: 'x' }), { code: 'skill_arguments_invalid' });
  assert.throws(() => validateNamedSkillArguments(skill, { template: 42 }), { code: 'skill_arguments_invalid' });
  assert.throws(() => validateNamedSkillArguments(skill, { template: 'x'.repeat(2_001) }), { code: 'skill_arguments_invalid' });
});

test('runSkillChain enqueues named arguments without exposing a skill body field', async () => {
  const queued = [];
  const result = await runSkillChain({ session: {} }, skill, {
    args: { template: 'Quarterly report' },
    enqueueControlRequest(_context, input, metadata) {
      const item = { id: `item-${queued.length}`, input, status: 'queued', ...metadata };
      queued.push(item);
      return item;
    },
    drainControlQueue() {},
  });
  assert.equal(result.objectives, 1);
  assert.match(queued[0].input, /template: Quarterly report/);
  assert.equal('body' in queued[0], false);
});
