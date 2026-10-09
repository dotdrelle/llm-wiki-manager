import assert from 'node:assert/strict';
import test from 'node:test';
import { dsmlInvokedName, dsmlToolCalls, hasDsmlMarkup, stripDsmlArtifacts } from './textArtifacts.js';

const block = (bar) => [
  `<${bar}DSML${bar}function_calls>`,
  `<${bar}DSML${bar}invoke name="runtime__run_skill">`,
  `<${bar}DSML${bar}parameter name="skillName" string="true">new-template</${bar}DSML${bar}parameter>`,
  `<${bar}DSML${bar}parameter name="limit" string="false">3</${bar}DSML${bar}parameter>`,
  `</${bar}DSML${bar}invoke>`,
  `</${bar}DSML${bar}function_calls>`,
].join('\n');

test('parses DSML tool calls, single or doubled, ASCII or fullwidth bars', () => {
  for (const bar of ['｜', '｜｜', '|', '||']) {
    const calls = dsmlToolCalls(block(bar));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'runtime__run_skill');
    assert.deepEqual(JSON.parse(calls[0].function.arguments), { skillName: 'new-template', limit: 3 });
    assert.equal(dsmlInvokedName(block(bar)), 'runtime__run_skill');
    assert.equal(hasDsmlMarkup(block(bar)), true);
  }
});

test('refuses a guessed argument and an incomplete block; prose is not DSML', () => {
  assert.equal(dsmlToolCalls(block('｜').replace('>3<', '>not json<')), null);
  assert.equal(dsmlToolCalls('<｜DSML｜invoke name="x">'), null);
  assert.equal(hasDsmlMarkup('a | b | c'), false);
});

test('strips DSML markup, single bars included', () => {
  assert.equal(stripDsmlArtifacts(`Voici.\n${block('｜')}`).trim(), 'Voici.');
});
