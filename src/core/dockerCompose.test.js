import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';

test('agent-runtime compose command passes runtime args to the image entrypoint', async () => {
  const raw = await readFile(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
  const compose = YAML.parse(raw);
  const service = compose.services['agent-runtime'];

  assert.equal(service.image, 'dotdrelle/llm-wiki-manager:latest');
  assert.equal(service.command, 'runtime --host 0.0.0.0 --port 7788 --state-dir /state');
  assert.ok(!service.command.startsWith('wiki-manager '));
});
