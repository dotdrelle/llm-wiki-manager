import { randomUUID } from 'node:crypto';
import { applyLegacySkillPlaceholders, parseSkillArguments } from '../core/skillInvocation.js';
import { compileSkillObjectives, createSkillCompilerFallback } from '../core/skillCompiler.js';

const SKILL_PARAM_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_PARAM_COUNT = 12;
const MAX_PARAM_VALUE_LENGTH = 2_000;
const MAX_ARGUMENTS_LENGTH = 8_000;

export function validateNamedSkillArguments(skill, supplied = {}) {
  if (supplied == null) supplied = {};
  if (typeof supplied !== 'object' || Array.isArray(supplied)) throw argumentError('Skill arguments must be an object.');
  const declared = Array.isArray(skill?.params) ? skill.params : [];
  if (declared.length > MAX_PARAM_COUNT || declared.some((name) => !SKILL_PARAM_RE.test(name) || DANGEROUS_KEYS.has(name))) {
    throw argumentError('The skill declares invalid parameters.');
  }
  const allowed = new Set(declared);
  const entries = Object.entries(supplied);
  if (entries.length > MAX_PARAM_COUNT) throw argumentError(`A skill accepts at most ${MAX_PARAM_COUNT} arguments.`);
  let total = 0;
  const normalized = Object.create(null);
  for (const [name, value] of entries) {
    if (!allowed.has(name) || DANGEROUS_KEYS.has(name)) throw argumentError(`Unknown skill argument: ${name}.`);
    if (value != null && typeof value !== 'string') throw argumentError(`Skill argument ${name} must be a string.`);
    const text = value == null ? '' : value;
    if (text.length > MAX_PARAM_VALUE_LENGTH) throw argumentError(`Skill argument ${name} exceeds ${MAX_PARAM_VALUE_LENGTH} characters.`);
    total += text.length;
    normalized[name] = text;
  }
  if (total > MAX_ARGUMENTS_LENGTH) throw argumentError(`Skill arguments exceed ${MAX_ARGUMENTS_LENGTH} characters in total.`);
  for (const name of declared) if (!(name in normalized)) normalized[name] = '';
  return normalized;
}

export async function runSkillChain(context, skill, {
  args = null,
  rawArgs = null,
  enqueueControlRequest,
  drainControlQueue,
  selectionKind = null,
  /**
   * Compétences déjà en cours d'exécution au-dessus de celle-ci. Chaque élément
   * mis en file la porte, augmentée de la compétence courante : c'est ce qui
   * permet au run imbriqué — qui démarre longtemps après son parent — de
   * reconnaître un cycle.
   */
  skillStack = [],
} = {}) {
  if (args !== null && rawArgs !== null) {
    const error = new Error('Provide named skill arguments or raw arguments, not both.');
    error.code = 'skill_arguments_invalid';
    throw error;
  }
  if (typeof enqueueControlRequest !== 'function' || typeof drainControlQueue !== 'function') {
    throw new TypeError('runSkillChain requires the runtime control queue functions.');
  }

  const resolvedArgs = args === null ? parseSkillArguments(skill, rawArgs ?? '') : validateNamedSkillArguments(skill, args);
  const legacy = applyLegacySkillPlaceholders(skill.body, resolvedArgs);
  const naturalArgs = Object.fromEntries(
    Object.entries(resolvedArgs).filter(([name]) => !legacy.deprecatedPlaceholders.includes(name)),
  );
  const objectives = await compileSkillObjectives(
    { ...skill, body: legacy.body },
    naturalArgs,
    { llmFallback: createSkillCompilerFallback(context.session?.llm, { timeoutMs: 8_000 }) },
  );
  const chainId = `chain-${randomUUID()}`;
  const nestedStack = [...(Array.isArray(skillStack) ? skillStack : []), skill.name];
  const publicInput = formatPublicSkillInvocation(skill.name, resolvedArgs);
  const items = objectives.map((objective, chainSequence) => enqueueControlRequest(context, objective.text, {
    publicInput,
    chainId,
    chainSequence,
    skillName: skill.name,
    skillExecution: skill.execution === 'direct' ? 'direct' : 'orchestrated',
    skillStack: nestedStack,
    ...(selectionKind ? { selectionKind } : {}),
    optional: objective.optional,
    continueOnFailure: objective.continueOnFailure,
  }));
  void drainControlQueue(context);
  return {
    chainId,
    skill: skill.name,
    objectives: objectives.length,
    items,
    deprecatedPlaceholders: legacy.deprecatedPlaceholders,
  };
}

export function formatPublicSkillInvocation(name, args = {}) {
  const values = Object.entries(args ?? {})
    .filter(([, value]) => String(value ?? '').trim())
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`);
  return `/${String(name ?? '').trim()}${values.length ? ` ${values.join(' ')}` : ''}`;
}

function argumentError(message) {
  const error = new Error(message);
  error.code = 'skill_arguments_invalid';
  return error;
}
