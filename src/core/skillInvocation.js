import { findSkill } from './skills.js';

const INVOCATION_RE = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/;
export const RESERVED_SLASH_COMMANDS = new Set(['status', 'stop', 'run', 'queue', 'skills', 'help', 'exit', 'quit', 'chat', 'agent']);

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
 Une intention compilée NOMME-t-elle la compétence qu'on veut lancer depuis
 elle ?

 Le corps d'une compétence est compilé en intentions métier, et une intention
 décrit forcément ce que fait une compétence voisine : la deuxième intention de
 `/wiki-ingest` est mot pour mot le corps de `/wiki-rebuild-concepts`. Le
 sélecteur par description la reconnaissait donc et relançait la compétence
 voisine, qui relançait la suivante — concepts et taxonomie produits plusieurs
 fois pour un seul `/wiki-ingest`.

 La composition volontaire reste possible : un corps qui écrit `/deliver` ou
 « the deliver skill » nomme sa cible, et se distingue ainsi d'une intention
 qui se contente de la décrire. C'est le seul signal qui ne dépende pas de ce
 que le modèle déclare de sa propre sélection.
*/
export function objectiveNamesSkill(input, skillName) {
  const raw = String(skillName ?? '').trim();
  const name = escapeRegExp(raw);
  if (!name) return false;
  const text = String(input ?? '').trim();
  // Une invocation directe : la demande EST le nom, rien d'autre.
  if (text.toLowerCase() === raw.toLowerCase()) return true;
  /*
   Le nom seul ne suffit pas : plusieurs compétences du scaffold portent un nom
   qui est aussi un mot courant. « Run the production pipeline steps concepts,
   reclassify-concepts and taxonomy » nomme ainsi la compétence `pipeline`, qui
   relance ingest + build + export + polish — bien pire que la cascade qu'on
   corrige. Le nom doit donc être cité EN TANT QUE compétence : forme slash, ou
   tournure explicite. La borne droite est écrite à la main, `\b` ne bornant pas
   après un `-` final (`wiki-build` ne doit pas matcher dans `wiki-builder`).
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
    new RegExp(`\\b${keyword}\\s+/?${name}${end}`, 'i'),
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
