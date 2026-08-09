import { findSkill } from './skills.js';

const INVOCATION_RE = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/;
export const RESERVED_SLASH_COMMANDS = new Set(['status', 'stop', 'run', 'queue', 'skills', 'help', 'exit', 'quit', 'chat', 'agent']);

export function matchSkillInvocation(session, input, { allowReserved = false } = {}) {
  const match = INVOCATION_RE.exec(String(input ?? '').trim());
  if (!match) return null;
  if (!allowReserved && RESERVED_SLASH_COMMANDS.has(match[1].toLowerCase())) return null;
  const skill = findSkill(session, match[1]);
  return skill ? { skill, rawArgs: String(match[2] ?? '').trim(), input: String(input ?? '').trim() } : null;
}

export function parseSkillArguments(skill, rawArgs = '') {
  const params = Array.isArray(skill?.params) ? skill.params : [];
  if (params.length === 0) return {};
  if (params.length === 1) return { [params[0]]: unquote(String(rawArgs).trim()) };
  const tokens = tokenizeArguments(rawArgs);
  return Object.fromEntries(params.map((param, index) => [param, index === params.length - 1 ? tokens.slice(index).join(' ') : (tokens[index] ?? '')]));
}

export function applyLegacySkillPlaceholders(body, args) {
  let text = String(body ?? '');
  const used = [];
  for (const [name, value] of Object.entries(args ?? {})) {
    const marker = `{${name}}`;
    if (!text.includes(marker)) continue;
    text = text.replaceAll(marker, String(value ?? ''));
    used.push(name);
  }
  return { body: text, deprecatedPlaceholders: used };
}

function tokenizeArguments(raw) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const char of String(raw ?? '').trim()) {
    if (escaped) { current += char; escaped = false; }
    else if (char === '\\') escaped = true;
    else if (quote) { if (char === quote) quote = null; else current += char; }
    else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) { if (current) { tokens.push(current); current = ''; } }
    else current += char;
  }
  if (escaped) current += '\\';
  if (quote) {
    const error = new Error('Unterminated quoted skill argument. Close the quote and retry.');
    error.code = 'skill_arguments_invalid';
    throw error;
  }
  if (current) tokens.push(current);
  return tokens;
}

function unquote(value) {
  return value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) ? value.slice(1, -1) : value;
}
