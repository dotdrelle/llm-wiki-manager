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

test('every shipped scaffold skill compiles to a single intention, deterministically', async () => {
  const expected = { pipeline: 1, 'wiki-sync': 1, 'wiki-ingest': 1, 'wiki-build': 1, deliver: 1, diagnose: 1, status: 1, 'new-template': 1, 'wiki-rebuild': 1 };
  // Passing no llmFallback used to make this test assert the one path
  // production never takes: an ambiguous body silently returns the safe
  // mono-intention fallback, so the count was 1 and the test was green while
  // production called the LLM and got 3. A shipped skill reaching the LLM
  // splitter is a build-time defect, not a runtime coin flip — so the fallback
  // here throws, and the deterministic pass must never need it.
  const llmFallback = () => { throw new Error('a shipped skill must not need the LLM splitter'); };
  for (const [name, count] of Object.entries(expected)) {
    const raw = readFileSync(resolve('../llm-wiki/scaffold/workspace/.wiki/skills', `${name}.md`), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    assert.equal(deterministicObjectives(body).ambiguous, false, `${name} is ambiguous for the deterministic pass`);
    assert.equal((await compileSkillObjectives({ ...meta, body }, {}, { llmFallback })).length, count, name);
  }
});

test('the shipped wiki-rebuild skill resolves through the deterministic alias path only', async () => {
  // The objective resolver's fast path fires only when EXACTLY ONE capability
  // alias phrase matches the objective. Bare words other agents alias ('build',
  // 'rebuild', 'ingest', 'check', 'export'…) would make the LLM resolver decide
  // instead. The shipped body is worded to stay on the deterministic path: it
  // must carry the agent-production knowledge.rebuild alias phrase and none of
  // the colliding words — verified against the alias lists actually shipped in
  // agent-production (knowledge.rebuild / knowledge.check) and the other
  // agents (cme: 'export sources'…, gateway: 'check'…).
  const raw = readFileSync(resolve('../llm-wiki/scaffold/workspace/.wiki/skills', 'wiki-rebuild.md'), 'utf8');
  const { body } = parseFrontmatter(raw);
  const objectives = await compileSkillObjectives({ body }, {});
  assert.equal(objectives.length, 1);
  const text = objectives[0].text;
  assert.match(text, /file the archived sources/i);
  for (const word of ['ingest', 'build', 'rebuild', 'export', 'publish', 'okf', 'frontmatter', 'diagnose', 'restore', 'pipeline', 'check', 'audit', 'review', 'analyze', 'compare']) {
    assert.doesNotMatch(text, new RegExp(`\\b${word}\\b`, 'i'), `word "${word}" must not appear in the objective`);
  }
});

test('every orchestrated scaffold skill declares the capability it targets', () => {
  // Without a declaration the capability is inferred from the body's prose by
  // alias matching, which any runtime added to agent-runtimes.json can break by
  // declaring a bare English word as an alias. Declared, the run is routed by
  // registry lookup and no text is matched at all.
  // Only the skills whose declaration is actually APPLIED, and only where the
  // target agent accepts it. The list is deliberately short:
  // - parameterised skills are dropped by skillRun (the capabilityPlan route
  //   skips the argument extraction a selector like <template> needs);
  // - pipeline keeps text resolution until an E2E test can assert its agent
  //   still plans its own DAG;
  // - diagnose declared `workspace.diagnose/doctor` and BROKE: agent_plan's
  //   operation allow-list has no `doctor`, so the plan was refused, the
  //   refusal swallowed, and the run reported done without diagnosing
  //   anything. Declaring a capability the executor cannot plan is worse than
  //   not declaring one.
  const orchestrated = ['wiki-sync'];
  for (const name of orchestrated) {
    const raw = readFileSync(resolve('../llm-wiki/scaffold/workspace/.wiki/skills', `${name}.md`), 'utf8');
    const { meta } = parseFrontmatter(raw);
    assert.match(String(meta.capability ?? ''), /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9_-]*)+$/, `${name} declares no capability`);
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
    name: 'collect-then-ingest',
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
