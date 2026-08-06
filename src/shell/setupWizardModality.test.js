import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The shell renders in a terminal, so there is no DOM to drive and no
// typechecker on these .tsx files (bun strips the types at run time). Source
// assertions are the only mechanized guard available here — they are narrow on
// purpose: each one names the exact invariant that broke.
const tuiPath = fileURLToPath(new URL('./tui.tsx', import.meta.url));

function tuiSource() {
  return readFileSync(tuiPath, 'utf8');
}

test('the chat composer loses focus while a modal is open', () => {
  const source = tuiSource();

  // The setup wizard used to leave `chatFocused` true underneath itself, so
  // every keystroke answering a wizard question was ALSO typed into the chat
  // input at the bottom of the window — visible, and submitted on Enter.
  assert.match(
    source,
    /chatFocused=\{!state\.activeEditor\(\) && screen\(\) === 'main'\}/,
    'chatFocused must exclude every non-main screen, not just the file editor',
  );
  assert.doesNotMatch(
    source,
    /chatFocused=\{!state\.activeEditor\(\)\}/,
    'the editor-only form of chatFocused lets wizard keystrokes reach the composer',
  );
});

test('the setup wizard renders over an opaque backdrop', () => {
  const source = tuiSource();
  const setupBranch = source.slice(source.indexOf("{screen() === 'setup' ?"));

  assert.ok(setupBranch, "the setup branch must exist in tui.tsx");
  // Without a full-bleed backdrop the wizard floats over a live two-pane
  // layout and the panes show through around its border.
  assert.match(setupBranch, /position="absolute"[\s\S]{0,200}backgroundColor="#0B0D12"/);
  assert.match(setupBranch, /width=\{dimensions\(\)\.width\}[\s\S]{0,120}height=\{dimensions\(\)\.height\}/);
  // The backdrop must sit under the wizard dialog (zIndex 40 in SetupWizard).
  const zIndex = setupBranch.match(/zIndex=\{(\d+)\}/);
  assert.ok(zIndex, 'the backdrop must declare a zIndex');
  assert.ok(Number(zIndex[1]) < 40, 'the backdrop must sit below the wizard dialog');
});

test('the global key handler ignores every screen but main', () => {
  const source = tuiSource();

  // Belt to the chatFocused braces: even if a future modal forgets the prop,
  // the shared shortcuts (history, slash completion, Esc) stay out of it.
  assert.match(source, /if \(screen\(\) !== 'main'\) return;/);
});
