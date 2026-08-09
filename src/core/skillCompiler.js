const OPTIONAL_RE = /^(?:si disponible|si possible|optionnellement|if available|if possible|optionally)\b[\s,:-]*/i;
const STRONG_CONNECTOR_RE = /\n\s*(?=(?:puis|ensuite|après cela|après .{0,80}?terminé|then|next|after .{0,80}?complete|si disponible|si possible|optionnellement|if available|if possible|optionally)\b)/gi;
const FORBIDDEN_FIELDS = /\b(?:agent|capability|capabilityPlan|MCP|tool(?: name)?)\s*:/i;
const MAX_OBJECTIVES = 12;

export async function compileSkillObjectives(skill, args = {}, { llmFallback = null } = {}) {
  const body = String(skill?.body ?? '').trim();
  if (!body) throw compileError('Skill body is empty.');
  // Splitting must happen on the body alone. Appending the parameters first
  // makes them part of the last objective only — `/wiki-sync ESPACE` would hand
  // `source: ESPACE` to the ingest step and leave the export step, the one that
  // actually needs it, exporting everything. The compiler cannot know which
  // step consumes which parameter, so every objective carries them.
  const deterministic = deterministicObjectives(body);
  if (!deterministic.ambiguous) {
    return withNaturalArguments(validateCompiledObjectives(deterministic.objectives), args);
  }
  if (typeof llmFallback === 'function') {
    try {
      // Parameters do not influence workflow boundaries. Give the fallback the
      // authored body only, then append parameters exactly once to every
      // validated objective below.
      const compiled = normalizeFallback(await llmFallback({ skill, body, args, maxObjectives: MAX_OBJECTIVES }));
      return withNaturalArguments(validateCompiledObjectives(compiled), args);
    } catch { /* preserve the safe mono-intention fallback */ }
  }
  return withNaturalArguments(validateCompiledObjectives([objectiveFromText(body)]), args);
}

export function createSkillCompilerFallback(llm, { signal, timeoutMs = 8_000 } = {}) {
  if (typeof llm?.completeWithTools !== 'function') return null;
  return async ({ body, maxObjectives }) => {
    const system = [
      'Split workflow prose into delegable business intentions without naming agents, capabilities or tools.',
      `Return 1..${maxObjectives} ordered objectives. Preserve a complex single business capability as one objective.`,
    ].join('\n');
    const tool = {
      type: 'function',
      function: {
        name: 'compiled_skill_objectives',
        description: 'Return validated workflow objectives.',
        parameters: {
          type: 'object', required: ['objectives'], additionalProperties: false,
          properties: { objectives: { type: 'array', items: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, optional: { type: 'boolean' }, continueOnFailure: { type: 'boolean' } } } } },
        },
      },
    };
    const timeoutSignal = AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 8_000));
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      const preferred = await llm.completeWithTools({ system, tools: [tool], toolChoice: { type: 'function', function: { name: 'compiled_skill_objectives' } }, messages: [{ role: 'user', content: body }], signal: requestSignal });
      const call = preferred?.tool_calls?.find((item) => item?.function?.name === 'compiled_skill_objectives');
      if (call?.function?.arguments) return JSON.parse(call.function.arguments);
      if (preferred?.content) return preferred.content;
    } catch { /* retry through JSON text below */ }
    const plain = await llm.completeWithTools({
      system: `${system}\nReturn JSON only as {"objectives":[{"text":"...","optional":false,"continueOnFailure":false}]}.`,
      tools: [], messages: [{ role: 'user', content: body }], signal: requestSignal,
    });
    return plain?.content;
  };
}

export function deterministicObjectives(body) {
  const text = String(body ?? '').trim();
  const numbered = splitExplicitList(text, /^\s*\d+[.)]\s+/gm);
  if (numbered) return { objectives: numbered.map(objectiveFromText), ambiguous: false };
  const bullets = splitExplicitList(text, /^\s*[-*+]\s+/gm);
  if (bullets) return { objectives: bullets.map(objectiveFromText), ambiguous: false };
  const connected = text.split(STRONG_CONNECTOR_RE).map((part) => part.trim()).filter(Boolean);
  if (connected.length > 1) return { objectives: connected.map(objectiveFromText), ambiguous: false };
  return { objectives: [objectiveFromText(text)], ambiguous: looksAmbiguous(text) };
}

export function validateCompiledObjectives(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_OBJECTIVES) throw compileError(`A skill must compile to 1..${MAX_OBJECTIVES} objectives.`);
  return value.map((raw, index) => {
    const item = typeof raw === 'string' ? objectiveFromText(raw) : { ...raw };
    item.text = String(item.text ?? '').trim();
    if (!item.text) throw compileError(`Objective ${index + 1} is empty.`);
    if (FORBIDDEN_FIELDS.test(item.text) || Object.keys(item).some((key) => /^(?:agent|capability|capabilityPlan|mcp|tool)$/i.test(key))) throw compileError(`Objective ${index + 1} contains technical routing details.`);
    return { text: item.text, optional: item.optional === true, continueOnFailure: item.optional === true || item.continueOnFailure === true };
  });
}

function naturalArgumentBlock(args) {
  const suffix = Object.entries(args ?? {})
    .filter(([, value]) => String(value ?? '').trim())
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
  return suffix ? `\n\nUser parameters:\n${suffix}` : '';
}

// Applied after validation: a parameter named `agent` or `tool` would otherwise
// trip the routing-details guard, which must judge the authored intention, not
// what the caller typed on the command line.
function withNaturalArguments(objectives, args) {
  const block = naturalArgumentBlock(args);
  if (!block) return objectives;
  return objectives.map((objective) => ({ ...objective, text: `${objective.text}${block}` }));
}

function splitExplicitList(text, markerRe) {
  const matches = [...text.matchAll(markerRe)];
  if (matches.length < 2) return null;
  return matches.map((match, index) => text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length).trim()).filter(Boolean);
}

function objectiveFromText(raw) {
  const text = String(raw ?? '').trim();
  const optional = OPTIONAL_RE.test(text);
  return {
    text: capitalize(text.replace(OPTIONAL_RE, '').replace(/^(?:puis|ensuite|après cela|then|next)\b[\s,:-]*/i, '').trim()),
    optional,
    continueOnFailure: optional,
  };
}

function looksAmbiguous(text) {
  return (text.match(/(?:^|[.!?]\s+)[A-ZÀ-Ý][^.!?]{0,80}\b(?:export|ingest|build|send|create|delete|sync|publish|diagnos|analyse|constru|envoi|cré|supprim)/gi)?.length ?? 0) > 2;
}

function normalizeFallback(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.objectives)) return value.objectives;
  if (typeof value === 'string') {
    const parsed = JSON.parse(value.replace(/^```json\s*|\s*```$/gi, ''));
    return Array.isArray(parsed) ? parsed : parsed.objectives;
  }
  throw compileError('Invalid compiler fallback response.');
}

function compileError(message) { const error = new Error(message); error.code = 'skill_compile_failed'; return error; }

function capitalize(text) { return text ? `${text[0].toLocaleUpperCase()}${text.slice(1)}` : text; }
