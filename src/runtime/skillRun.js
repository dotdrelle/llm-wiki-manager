import { say } from './donnaVoice.js';
import { randomUUID } from 'node:crypto';
import { applyLegacySkillPlaceholders, parseSkillArguments } from '../core/skillInvocation.js';
import { compileSkillObjectives, createSkillCompilerFallback } from '../core/skillCompiler.js';
import { emitRuntimeLog } from './supervisor.js';

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
  conversationId = null,
  /**
   * Skills already executing above this one. Each queued item carries it,
   * extended by the current skill: that is what lets the nested run — which
   * starts long after its parent — recognise a cycle.
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
  // A declared capability takes the deterministic route: a run carrying a
  // capabilityPlan is resolved by looking the id up in the registry directly
  // (cli/wiki-manager.js), with no alias matching and no LLM resolver.
  //
  // Only when the body stayed a single intention. A body that split may target
  // a different capability per step, and stamping one declaration onto all of
  // them would route the wrong work confidently. When that happens the
  // declaration is dropped — and says so, because a skill silently losing its
  // deterministic routing is exactly the kind of degradation that hides itself.
  // Two conditions, each protecting something the invariant used to protect
  // wholesale:
  //
  // - ONE objective. A body that split may target a different capability per
  //   step, and stamping one declaration onto all of them would route the wrong
  //   work confidently.
  // - Every declared parameter is mapped explicitly by the skill frontmatter
  //   to a capability argument or operation. That keeps the direct route
  //   bounded to the user's selected files while avoiding a second model call
  //   to infer structured arguments from the compiled objective.
  //
  // What the old invariant ALSO forbade, and no longer needs to: it assumed
  // pre-resolving a capability would take planning away from the agent. It does
  // not — the capabilityPlan route honours `canPlan` and calls agent_plan, so
  // the production capability keeps its own DAG and its own concurrency.
  const declaresCapability = Boolean(skill.capability);
  const hasParams = Array.isArray(skill.params) && skill.params.length > 0;
  const paramsRouted = !hasParams || skill.params.every((param) => (
    Object.hasOwn(skill.capabilityArguments ?? {}, param) || param === skill.operationParam
  ));
  const capabilityArguments = {};
  for (const [param, target] of Object.entries(skill.capabilityArguments ?? {})) {
    const value = String(resolvedArgs[param] ?? '').trim();
    if (!value) continue;
    const isArray = target.endsWith('[]');
    const name = isArray ? target.slice(0, -2) : target;
    capabilityArguments[name] = isArray ? [value] : value;
  }
  const selectedOperation = skill.operationParam && String(resolvedArgs[skill.operationParam] ?? '').trim()
    ? skill.operationParam
    : skill.operation;
  const declaredPlan = declaresCapability && objectives.length === 1 && paramsRouted
    ? {
      capability: skill.capability,
      ...(selectedOperation ? { operation: selectedOperation } : {}),
      ...(Object.keys(capabilityArguments).length ? { arguments: capabilityArguments } : {}),
    }
    : undefined;
  if (declaresCapability && !declaredPlan) {
    const reason = objectives.length > 1
      ? `the body compiled into ${objectives.length} objectives`
      : 'one or more declared parameters have no capability mapping';
    emitRuntimeLog(
      context.session,
      `Skill ${skill.name}: declared capability ${skill.capability} not applied — ${reason}; the objective is resolved from its text instead.`,
    );
  }
  const items = objectives.map((objective, chainSequence) => enqueueControlRequest(context, objective.text, {
    publicInput,
    chainId,
    chainSequence,
    skillName: skill.name,
    skillExecution: skill.execution === 'direct' ? 'direct' : 'orchestrated',
    skillStack: nestedStack,
    ...(conversationId ? { conversationId } : {}),
    ...(selectionKind ? { selectionKind } : {}),
    ...(declaredPlan ? { capabilityPlan: declaredPlan } : {}),
    optional: objective.optional,
    continueOnFailure: objective.continueOnFailure,
  }));
  void drainControlQueue(context);
  return {
    chainId,
    skill: skill.name,
    objectives: objectives.length,
    items,
    publicInput,
    deprecatedPlaceholders: legacy.deprecatedPlaceholders,
  };
}

export function formatPublicSkillInvocation(name, args = {}) {
  const values = Object.entries(args ?? {})
    .filter(([, value]) => String(value ?? '').trim())
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`);
  return `/${String(name ?? '').trim()}${values.length ? ` ${values.join(' ')}` : ''}`;
}

/**
 * Donna's launch acknowledgement for an executable skill.
 *
 * The reply is user-facing and echoes the caller's own arguments (a source, a
 * file, a deliverable), so it must be generated by Donna in the session's
 * configured language — a hardcoded fr/en catalog cannot cover every language
 * and would drop the very parameters the user asked for. This is the single
 * place that turns a compiled skill chain into a conversational reply; the
 * browser and the shell both read the resulting `explanation`, never a
 * language-specific string of their own.
 *
 * Degrades honestly (donnaVoice.js): without a model, or when it fails, the
 * launch facts are shown as data and the runtime log says why.
 */
export async function generateSkillAcknowledgment(session, { publicInput, objectives }) {
  return say(session, {
    kind: 'skill_launched',
    facts: { skill: publicInput, steps: Number(objectives) || 1, state: 'queued' },
    rules: [
      'Confirm the launch, echo the skill and its arguments, and say progress will be reported.',
      'Do not claim the work is running, executing or done: a mutating step waits for the user\'s approval before it runs.',
      'Do not ask a question, do not propose options, and do not offer to check, monitor or cancel anything: the runtime reports progress on its own and this acknowledgement is not a decision point.',
    ],
  });
}

function argumentError(message) {
  const error = new Error(message);
  error.code = 'skill_arguments_invalid';
  return error;
}
