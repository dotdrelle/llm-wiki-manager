import { findSkill, listSkills } from './skills.js';

const INVOCATION_RE = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/;
// remember/forget/memory are memory requests Donna performs with her tools, not
// skills: an unknown-skill refusal would stop them before she sees them.
export const RESERVED_SLASH_COMMANDS = new Set(['status', 'stop', 'run', 'queue', 'skills', 'help', 'exit', 'quit', 'chat', 'agent', 'maintenance', 'remember', 'forget', 'memory']);

export function explicitSkillReference(input, skillName, language = null) {
  const name = escapeRegExp(String(skillName ?? '').trim());
  if (!name) return false;
  const primary = String(language ?? '').toLowerCase().split(/[-_]/)[0];
  if (!['en', 'fr'].includes(primary)) return false;
  const text = String(input ?? '').split(/[.!?\n]/).map((part) => part.trim()).filter(Boolean);
  const keyword = '(?:skill|workflow)';
  const patterns = [
    new RegExp(`\\b${keyword}\\s+${name}\\b`, 'i'),
    new RegExp(`\\b${name}\\s+${keyword}\\b`, 'i'),
    new RegExp(`/skills\\s+run\\s+${name}\\b`, 'i'),
    new RegExp(`/${name}\\s+(?:comme|as)\\s+${keyword}\\b`, 'i'),
  ];
  return text.some((sentence) => patterns.some((pattern) => pattern.test(sentence)));
}

/*
 Does a compiled intention NAME the skill one wants to launch from it?

 A skill body is compiled into business intentions, and an intention
 necessarily describes what a neighbouring skill does: that is how a single
 `/wiki-ingest` used to relaunch the sibling skill that rebuilt the concept
 grid, which relaunched the next one — concepts and taxonomy produced several
 times for one request. (Those sibling skills disappeared with the 0.15.66
 simplification; the guard against selection by description remains, and it
 is what these rules lock down.)

 Deliberate composition remains possible: a body that writes `/deliver` or
 "the deliver skill" names its target, and thus differs from an intention
 that merely describes it. It is the only signal that does not depend on what
 the model declares about its own selection.
*/
export function objectiveNamesSkill(input, skillName) {
  const raw = String(skillName ?? '').trim();
  const name = escapeRegExp(raw);
  if (!name) return false;
  const text = String(input ?? '').trim();
  // A direct invocation: the request IS the name, nothing else.
  if (text.toLowerCase() === raw.toLowerCase()) return true;
  /*
   The name alone is not enough: several scaffold skills carry a name that is
   also a common word. "Run the production pipeline steps ingest, build,
   export and polish" thus names the `pipeline` skill, which relaunches
   ingest + build + export + polish — far worse than the cascade being fixed.
   The name must therefore be cited AS a skill: slash form, or an explicit
   turn of phrase. The right boundary is written by hand, `\b` does not bound
   after a trailing `-` (`wiki-build` must not match inside `wiki-builder`).
  */
  const end = '(?![A-Za-z0-9_-])';
  // The slash form is a command, not a path: `/wiki-build` followed by `/` is
  // `wiki/concepts/...`-style text referencing a file, not an invocation of the
  // `wiki-build` skill. A trailing `/` must not satisfy the right boundary here,
  // or a compiled objective that merely names a path re-opens the nested-skill
  // cascade this guard exists to close.
  const slashEnd = '(?![A-Za-z0-9_/-])';
  const keyword = '(?:skill|workflow|compétence)';
  return [
    new RegExp(`(?:^|[^A-Za-z0-9_-])/${name}${slashEnd}`, 'i'),
    // Same path-vs-invocation distinction as the slash form above: unlike
    // the third pattern below, nothing after this one forces a following
    // whitespace, so a trailing `/` here would otherwise satisfy `end` and
    // let "the skill /wiki-build/export-context" match `wiki-build`.
    new RegExp(`\\b${keyword}\\s+/?${name}${slashEnd}`, 'i'),
    new RegExp(`(?:^|[^A-Za-z0-9_-])/?${name}${end}\\s+${keyword}\\b`, 'i'),
    new RegExp(`/skills\\s+run\\s+${name}${end}`, 'i'),
  ].some((pattern) => pattern.test(text));
}

export function matchSkillInvocation(session, input, { allowReserved = false } = {}) {
  const match = INVOCATION_RE.exec(String(input ?? '').trim());
  if (!match) return null;
  if (!allowReserved && RESERVED_SLASH_COMMANDS.has(match[1].toLowerCase())) return null;
  const skill = findSkill(session, match[1]);
  return skill ? { skill, rawArgs: String(match[2] ?? '').trim(), input: String(input ?? '').trim() } : null;
}

/**
 * A `/name` that is not a built-in and names no workspace skill.
 *
 * Passed on as prose, it reached Donna as a bare "/wiki-rebuild" and she
 * improvised from the conversation — re-running the previous request (a page
 * reformat) instead of saying the command did not exist. A workspace without
 * `.wiki/skills/` made EVERY skill command take that path silently. The caller
 * refuses it instead, naming what does exist.
 */
export function unknownSkillInvocation(session, input) {
  const match = INVOCATION_RE.exec(String(input ?? '').trim());
  if (!match) return null;
  const name = match[1];
  if (RESERVED_SLASH_COMMANDS.has(name.toLowerCase()) || findSkill(session, name)) return null;
  const available = listSkills(session).map((skill) => `/${skill.name}`);
  const message = available.length
    ? `Unknown skill /${name}. Skills available in this workspace: ${available.join(', ')}.`
    : `Unknown skill /${name}: this workspace has no skills installed (.wiki/skills/ is missing). `
      + 'Restore the default ones with "wiki-workspace wiki <workspace> init", which never overwrites existing files.';
  return { name, available, message };
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
