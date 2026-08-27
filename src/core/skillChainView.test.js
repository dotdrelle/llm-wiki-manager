import test from 'node:test';
import assert from 'node:assert/strict';
import { chainStepLabel, projectSkillChains, renderSkillChain, selectionKindLabel } from './skillChainView.js';

const WIKI_SYNC = [
  {
    id: 'c0', chainId: 'chain-1', chainSequence: 0, skillName: 'wiki-sync', selectionKind: 'description_match', status: 'done',
    input: 'Export the requested Confluence source, or all configured sources when none is specified. Check configuration first.\n\nUser parameters:\nsource: docs',
  },
  {
    id: 'c1', chainId: 'chain-1', chainSequence: 1, skillName: 'wiki-sync', status: 'running', runId: 'run-b',
    input: 'Ingest the newly exported Markdown into the wiki, with the normal mutation approval.',
  },
];

test('a chain reads as ordered steps with one short label each', () => {
  const [chain] = projectSkillChains(WIKI_SYNC);
  assert.equal(chain.skillName, 'wiki-sync');
  assert.equal(chain.selectionKind, 'description_match');
  assert.equal(chain.status, 'running');
  assert.deepEqual(chain.steps.map((step) => step.symbol), ['✓', '●']);
  assert.equal(chain.steps[0].label, 'Step 1/2');
  assert.equal(chain.steps[1].runId, 'run-b');
});

test('the label drops the appended parameter block and never cuts a word', () => {
  assert.equal(chainStepLabel('Do the thing.\n\nUser parameters:\nsource: docs'), 'Do the thing');
  const label = chainStepLabel('An objective long enough to need clipping somewhere sensible indeed.');
  assert.ok(label.endsWith('…'));
  assert.ok(!label.includes('  '));
  assert.ok(label.length <= 53);
});

test('after a cancel the chain shows the cancelled step and the skipped remainder', () => {
  const [chain] = projectSkillChains([
    { id: 'c0', chainId: 'k', chainSequence: 0, skillName: 'wiki-sync', status: 'done', input: 'Export source.' },
    { id: 'c1', chainId: 'k', chainSequence: 1, status: 'cancelled', input: 'Ingest files.' },
    { id: 'c2', chainId: 'k', chainSequence: 2, status: 'skipped', skipReason: 'chain_cancelled', input: 'Publish results.' },
  ]);
  assert.equal(chain.status, 'cancelled');
  assert.equal(
    renderSkillChain(chain),
    ['wiki-sync', '', '✓ Step 1/3', '  done', '× Step 2/3', '  cancelled', '– Step 3/3', '  skipped · chain_cancelled'].join('\n'),
  );
});

test('standalone control items are not chains', () => {
  assert.deepEqual(projectSkillChains([{ id: 'x', status: 'queued', input: 'do something' }]), []);
  assert.deepEqual(projectSkillChains(), []);
});

test('the selection reason is humanized, not leaked as an audit enum', () => {
  assert.equal(selectionKindLabel('explicit_name'), 'explicit name');
  assert.equal(selectionKindLabel('description_match'), 'description match');
  assert.equal(selectionKindLabel(null), null);
  const [chain] = projectSkillChains([
    { id: 'c0', chainId: 'k', chainSequence: 0, skillName: 'wiki-taxonomy', selectionKind: 'explicit_name', status: 'running', input: '/wiki-taxonomy' },
  ]);
  assert.equal(chain.selectionKind, 'explicit_name');
  assert.equal(chain.selectionLabel, 'explicit name');
  assert.equal(renderSkillChain(chain).split('\n')[0], 'wiki-taxonomy · explicit name');
});
