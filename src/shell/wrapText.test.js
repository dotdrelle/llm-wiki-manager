import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { wrapText } from './wrapText.js';

test('wraps on word boundaries within the given width', () => {
  const lines = wrapText('Required: an agentic model with tool calling support.', 20);
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(line.length <= 20, `too wide: ${line}`);
  assert.equal(lines.join(' '), 'Required: an agentic model with tool calling support.');
});

test('keeps explicit line breaks', () => {
  assert.deepEqual(wrapText('one\ntwo', 40), ['one', 'two']);
});

test('splits a word longer than the box instead of letting it overflow', () => {
  const lines = wrapText('https://gateway.internal.example.com/v1/models', 16);
  for (const line of lines) assert.ok(line.length <= 16, `too wide: ${line}`);
  assert.equal(lines.join(''), 'https://gateway.internal.example.com/v1/models');
});

test('marks the truncation instead of cutting silently', () => {
  const lines = wrapText('a b c d e f g h i j k l m n o p', 4, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith('…'));
});

test('a short text is returned untouched', () => {
  assert.deepEqual(wrapText('API key', 40), ['API key']);
});

test('the wizard renders every prose field through wrapText', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./SetupWizard.tsx', import.meta.url)),
    'utf8',
  );
  // Garde-fou : un `<text height={1}>` autour d'un libellé, d'une note ou
  // d'une erreur réintroduirait la troncature silencieuse.
  for (const call of [
    'wrapText((step() as any).message ?? (step() as any).label, textWidth(), 5)',
    'wrapText((step() as any).note, textWidth(), 4)',
    'wrapText(message(), textWidth(), 5)',
  ]) {
    assert.ok(source.includes(call), `missing wrapped render: ${call}`);
  }
});
