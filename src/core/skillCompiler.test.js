import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSkillObjectives, createSkillCompilerFallback, deterministicObjectives, validateCompiledObjectives } from './skillCompiler.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFrontmatter } from './skills.js';

test('numbered and bullet lists are strong objective boundaries', () => {
  assert.equal(deterministicObjectives('1. Export source\n2. Ingest files').objectives.length, 2);
  assert.equal(deterministicObjectives('- Export source\n- Ingest files').objectives.length, 2);
});

test('paragraphs preserve one delegable intention while Puis splits', async () => {
  assert.equal((await compileSkillObjectives({ body: 'Run the complete pipeline.\n\nInclude indexing.\n\nReport it.' })).length, 1);
  assert.equal((await compileSkillObjectives({ body: 'Exporter la source.\n\nPuis ingérer les fichiers.' })).length, 2);
});

test('optional objectives continue on failure', async () => {
  const result = await compileSkillObjectives({ body: 'Export source.\n\nOptionnellement, envoyer une notification.' });
  assert.equal(result[1].optional, true);
  assert.equal(result[1].continueOnFailure, true);
});

test('compiler appends natural parameters without teaching placeholders', async () => {
  const [objective] = await compileSkillObjectives({ body: 'Build the deliverable.' }, { template: 'architecture' });
  assert.match(objective.text, /User parameters:\ntemplate: architecture/);
});

test('validation rejects technical routing details', () => {
  assert.throws(() => validateCompiledObjectives([{ text: 'agent: cme' }]), { code: 'skill_compile_failed' });
});

test('scaffold skills preserve existing capabilities and split only wiki-sync', async () => {
  const expected = { pipeline: 1, 'wiki-ingest': 2, 'wiki-build': 1, deliver: 1, diagnose: 1, status: 1, 'new-template': 1, 'wiki-sync': 2 };
  for (const [name, count] of Object.entries(expected)) {
    const raw = readFileSync(resolve('../llm-wiki/scaffold/workspace/.wiki/skills', `${name}.md`), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    assert.equal((await compileSkillObjectives({ ...meta, body })).length, count, name);
  }
});

test('LLM fallback degrades from missing tool calls to validated JSON text', async () => {
  let calls = 0;
  const fallback = createSkillCompilerFallback({ completeWithTools: async ({ tools }) => {
    calls += 1;
    return tools.length ? { content: null, tool_calls: null } : { content: '{"objectives":[{"text":"Do the coherent workflow."}]}' };
  } });
  assert.equal(await fallback({ body: 'ambiguous', maxObjectives: 12 }), '{"objectives":[{"text":"Do the coherent workflow."}]}');
  assert.equal(calls, 2);
});

test('every objective of a chain carries the user parameters, not just the last', async () => {
  // Appending the parameters before splitting attached `source` to the ingest
  // step and left the export step — the one that consumes it — without it.
  const skill = {
    name: 'wiki-sync',
    params: ['source'],
    body: 'Export the requested source.\n\nThen ingest what was exported.',
  };
  const objectives = await compileSkillObjectives(skill, { source: 'ESPACE-CONF' });
  assert.equal(objectives.length, 2);
  for (const objective of objectives) {
    assert.match(objective.text, /User parameters:\nsource: ESPACE-CONF/);
  }
  assert.match(objectives[0].text, /^Export the requested source\./);
});

test('a parameter named after a routing field does not fail validation', async () => {
  // The routing guard judges the authored intention, not what the caller typed.
  const objectives = await compileSkillObjectives(
    { name: 'x', params: ['agent'], body: 'Do the thing.' },
    { agent: 'production' },
  );
  assert.equal(objectives.length, 1);
  assert.match(objectives[0].text, /agent: production/);
});

test('LLM fallback sees authored prose and parameters are appended exactly once', async () => {
  let fallbackBody = null;
  const objectives = await compileSkillObjectives(
    { body: 'Please export the source. Please build the result. Please send the report.' },
    { source: 'SPACE' },
    { llmFallback: async ({ body }) => {
      fallbackBody = body;
      return [{ text: body }];
    } },
  );
  assert.doesNotMatch(fallbackBody, /User parameters:/);
  assert.equal(objectives[0].text.match(/User parameters:/g)?.length, 1);
  assert.equal(objectives[0].text.match(/source: SPACE/g)?.length, 1);
});
