import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCommit, versionWithBuild } from './buildInfo.js';

test('versionWithBuild always exposes a provenance suffix', () => {
  const formatted = versionWithBuild({ version: '9.9.9' });
  // From the development repo the live git short sha is used; from a packed
  // install the buildInfo.json commit; '+dev' only when neither is available.
  assert.match(formatted, /^9\.9\.9\+(?:[0-9a-f]{4,40}|dev)$/);
});

test('buildCommit is stable across calls (cached)', () => {
  assert.equal(buildCommit(), buildCommit());
});
