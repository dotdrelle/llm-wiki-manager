import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLACEHOLDER_VALUE_RE,
  buildInheritedWikircPatch,
  cmeCredentialsPath,
  copyCmeCredentials,
  isRealValue,
} from './workspaceInherit.js';

const SCAFFOLD_LLM = {
  provider: 'openai-compatible',
  engine: 'generic',
  baseUrl: 'https://mon-provider.example.com/v1',
  model: 'YOUR_MODEL_NAME',
  apiKey: 'YOUR_LLM_API_KEY',
};

const WORKING_LLM = {
  provider: 'ai-gateway',
  engine: 'generic',
  baseUrl: 'https://itsdonna.events/v1',
  model: 'deepseek-v4-pro',
  apiKey: 'sk-real-gateway-key',
  temperature: 0.1,
};

test('scaffold placeholders never count as configured values', () => {
  for (const value of Object.values(SCAFFOLD_LLM).filter((v) => typeof v === 'string')) {
    if (value === 'openai-compatible' || value === 'generic') continue;
    assert.equal(isRealValue(value), false, `${value} must be treated as a placeholder`);
  }
  assert.equal(isRealValue('https://itsdonna.events/v1'), true);
  assert.equal(isRealValue(''), false);
  assert.equal(isRealValue(null), false);
  // Booleans and numbers are legitimate answers; `false` and `0` must survive.
  assert.equal(isRealValue(false), true);
  assert.equal(isRealValue(0), true);
});

test('the placeholder rule stays identical to the wizard', () => {
  // The wizard applies the same "a scaffolded value is not an answer" rule. If
  // the two drift, /new starts inheriting values the wizard would refuse.
  const wizard = readFileSync(
    fileURLToPath(new URL('../shell/SetupWizard.tsx', import.meta.url)),
    'utf8',
  );
  const match = wizard.match(/^const PLACEHOLDER_VALUE_RE = (\/.+\/i);$/m);
  assert.ok(match, 'SetupWizard.tsx must keep PLACEHOLDER_VALUE_RE on one line');
  assert.equal(match[1], String(PLACEHOLDER_VALUE_RE));
});

test('a new workspace inherits the working LLM block over scaffold placeholders', () => {
  const { patch, inherited } = buildInheritedWikircPatch(
    { llm: WORKING_LLM },
    { llm: SCAFFOLD_LLM },
  );

  assert.equal(patch.llm.baseUrl, 'https://itsdonna.events/v1');
  assert.equal(patch.llm.model, 'deepseek-v4-pro');
  assert.equal(patch.llm.apiKey, 'sk-real-gateway-key');
  assert.equal(patch.llm.provider, 'ai-gateway');
  assert.equal(patch.llm.temperature, 0.1);
  assert.ok(inherited.includes('llm.baseUrl'));
});

test('provider and engine follow the endpoint they describe', () => {
  // Keeping the scaffold's `openai-compatible` while adopting a gateway URL
  // would describe the wrong kind of server — the conflation the
  // provider/engine split exists to prevent.
  const taken = buildInheritedWikircPatch({ llm: WORKING_LLM }, { llm: SCAFFOLD_LLM });
  assert.equal(taken.patch.llm.provider, 'ai-gateway');
  assert.ok(taken.inherited.includes('llm.provider'));

  // Endpoint not taken over: provider and engine stay where they are, whatever
  // the source says.
  const kept = buildInheritedWikircPatch(
    { llm: WORKING_LLM },
    { llm: { ...SCAFFOLD_LLM, baseUrl: 'http://localhost:11434/v1' } },
  );
  assert.equal(kept.patch.llm?.provider, undefined);
  assert.equal(kept.patch.llm?.engine, undefined);
});

test('a value already set on the target is never overwritten', () => {
  const { patch } = buildInheritedWikircPatch(
    { llm: WORKING_LLM },
    { llm: { ...SCAFFOLD_LLM, model: 'mistral-large', baseUrl: 'http://localhost:11434/v1' } },
  );

  assert.equal(patch.llm.model, undefined, 'a deliberate model must survive');
  assert.equal(patch.llm.baseUrl, undefined, 'a deliberate endpoint must survive');
  assert.equal(patch.llm.apiKey, 'sk-real-gateway-key', 'the still-placeholder key is filled');
});

test('mcp.accessKey is never part of the inherited patch', () => {
  const { patch, inherited } = buildInheritedWikircPatch(
    { llm: WORKING_LLM, mcp: { accessKey: 'source-secret' } },
    { llm: SCAFFOLD_LLM, mcp: { accessKey: 'target-secret' } },
  );

  assert.equal(patch.mcp, undefined);
  assert.ok(!inherited.some((key) => key.startsWith('mcp')));
});

test('a divergent vector endpoint is not inherited without its own key', () => {
  // Carrying baseUrl alone would send the gateway key — which unlocks every
  // provider behind it — to a different host.
  const { patch, inherited } = buildInheritedWikircPatch(
    {
      llm: WORKING_LLM,
      retrieval: { vector: { enabled: true, baseUrl: 'http://infinity.internal:7997/v1' } },
    },
    { llm: SCAFFOLD_LLM, retrieval: { vector: {} } },
  );

  assert.equal(patch.retrieval?.vector?.baseUrl, undefined);
  assert.ok(!inherited.includes('retrieval.vector.baseUrl'));
  assert.equal(patch.retrieval.vector.enabled, true, 'the rest of the block still travels');
});

test('a divergent vector endpoint IS inherited when it carries its own key', () => {
  const { patch } = buildInheritedWikircPatch(
    {
      llm: WORKING_LLM,
      retrieval: {
        vector: { enabled: true, baseUrl: 'http://infinity.internal:7997/v1', apiKey: 'vec-key' },
      },
    },
    { llm: SCAFFOLD_LLM, retrieval: { vector: {} } },
  );

  assert.equal(patch.retrieval.vector.baseUrl, 'http://infinity.internal:7997/v1');
  assert.equal(patch.retrieval.vector.apiKey, 'vec-key');
});

test('nothing to inherit yields an empty patch', () => {
  const { patch, inherited } = buildInheritedWikircPatch({ llm: SCAFFOLD_LLM }, { llm: WORKING_LLM });
  assert.deepEqual(patch, {});
  assert.deepEqual(inherited, []);
});

test('CME credentials are copied, and the source manifest is not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cme-inherit-'));
  const sourceDir = join(root, 'cme', 'acme', 'cme');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, 'app_data.json'), '{"auth":{"pat":"secret"}}', 'utf8');
  // Export scope is what makes a workspace different — it must NOT travel.
  writeFileSync(join(root, 'cme', 'acme', 'sources-manifest.yaml'), 'sources: []\n', 'utf8');

  const copied = await copyCmeCredentials(root, 'acme', 'fresh');

  assert.equal(copied, cmeCredentialsPath(root, 'fresh'));
  assert.equal(readFileSync(copied, 'utf8'), '{"auth":{"pat":"secret"}}');
  assert.equal(existsSync(join(root, 'cme', 'fresh', 'sources-manifest.yaml')), false);
});

test('existing CME credentials on the target are never clobbered', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cme-inherit-keep-'));
  mkdirSync(join(root, 'cme', 'acme', 'cme'), { recursive: true });
  mkdirSync(join(root, 'cme', 'fresh', 'cme'), { recursive: true });
  writeFileSync(join(root, 'cme', 'acme', 'cme', 'app_data.json'), '{"from":"source"}', 'utf8');
  writeFileSync(join(root, 'cme', 'fresh', 'cme', 'app_data.json'), '{"from":"target"}', 'utf8');

  assert.equal(await copyCmeCredentials(root, 'acme', 'fresh'), null);
  assert.equal(
    readFileSync(cmeCredentialsPath(root, 'fresh'), 'utf8'),
    '{"from":"target"}',
  );
});

test('copying is a no-op without a source, a target, or a source file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cme-inherit-noop-'));
  assert.equal(await copyCmeCredentials(root, 'absent', 'fresh'), null);
  assert.equal(await copyCmeCredentials(root, null, 'fresh'), null);
  assert.equal(await copyCmeCredentials(root, 'acme', 'acme'), null);
});
