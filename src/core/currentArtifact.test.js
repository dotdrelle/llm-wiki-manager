import assert from 'node:assert/strict';
import test from 'node:test';
import {
  artifactFromToolCall,
  currentArtifactFor,
  currentArtifactPromptLine,
  rememberArtifact,
} from './currentArtifact.js';

test('artifactFromToolCall records editable write tools with a path', () => {
  assert.deepEqual(artifactFromToolCall('template_write', { path: 'templates/notes/basic.md', confirm: true }), {
    path: 'templates/notes/basic.md',
    kind: 'template',
  });
  assert.deepEqual(artifactFromToolCall('build_context_write', { path: 'build-context/rules/citations.md' }), {
    path: 'build-context/rules/citations.md',
    kind: 'build-context',
  });
  assert.deepEqual(artifactFromToolCall('wiki_write_page', { path: 'wiki/flux/ingestion.md' }), {
    path: 'wiki/flux/ingestion.md',
    kind: 'wiki page',
  });
});

test('artifactFromToolCall records template_read only when a path is given', () => {
  assert.deepEqual(artifactFromToolCall('template_read', { path: 'templates/notes/basic.md' }), {
    path: 'templates/notes/basic.md',
    kind: 'template',
  });
  assert.equal(artifactFromToolCall('template_read', {}), null);
});

test('artifactFromToolCall ignores read tools and tools without a path', () => {
  assert.equal(artifactFromToolCall('wiki_read_page', { path: 'wiki/page.md' }), null);
  assert.equal(artifactFromToolCall('wiki_search_context', { query: 'x' }), null);
  assert.equal(artifactFromToolCall('template_write', {}), null);
  assert.equal(artifactFromToolCall('unknown_tool', { path: 'templates/x.md' }), null);
});

test('currentArtifactFor is workspace-scoped', () => {
  const artifact = { workspace: 'acpi', path: 'templates/notes/basic.md', kind: 'template' };
  assert.equal(currentArtifactFor({ workspace: 'acpi', currentArtifact: artifact }), artifact);
  assert.equal(currentArtifactFor({ workspace: 'other', currentArtifact: artifact }), null);
  assert.equal(currentArtifactFor({ workspace: 'acpi' }), null);
});

test('currentArtifactPromptLine names the artifact for follow-up edits', () => {
  const line = currentArtifactPromptLine({ path: 'templates/presentation/presentation.md', kind: 'template' });
  assert.match(line, /templates\/presentation\/presentation\.md/);
  assert.match(line, /this slide/);
  assert.equal(currentArtifactPromptLine(null), null);
});

test('rememberArtifact records a workspace-scoped artifact and ignores empty paths', () => {
  const session = { workspace: 'acpi' };
  rememberArtifact(session, { path: 'templates/notes/basic.md', kind: 'template' });
  assert.equal(session.currentArtifact.path, 'templates/notes/basic.md');
  assert.equal(session.currentArtifact.workspace, 'acpi');
  assert.equal(session.currentArtifact.kind, 'template');
  rememberArtifact(session, { path: '   ', kind: 'template' });
  assert.equal(session.currentArtifact.path, 'templates/notes/basic.md');
});
