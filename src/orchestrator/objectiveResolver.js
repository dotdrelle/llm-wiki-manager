// Distinguishes "nothing here can do that" from a genuine resolution failure:
// the first is a normal answer Donna gives the user, the second is a defect.
export class ObjectiveNotOrchestrableError extends Error {
  constructor(objective, candidates = [], reason = '') {
    const available = candidates.map((item) => item.id).join(', ') || 'none';
    super(
      `No connected agent can do that.${reason ? ` ${String(reason).trim()}` : ''}`
      + ` Available capabilities: ${available}.`,
    );
    this.name = 'ObjectiveNotOrchestrableError';
    this.objective = String(objective ?? '');
    this.candidates = candidates.map((item) => item.id);
  }
}

export async function resolveObjective(objective, session) {
  const candidates = capabilityCandidates(session);
  if (candidates.length === 0) throw new Error('No orchestrable capability is currently available.');
  // Resolution sees the primary intention only (notification + guardrails
  // stripped). The delegated agent still receives the full objective.
  const clean = objectiveForResolution(objective);
  const deterministic = resolveMentionedRegistryOperation(clean, candidates);
  if (deterministic) return selectionWithProvider(session, deterministic, candidates);
  const llm = session?.llm;
  if (!llm?.completeWithTools) throw new Error('Objective resolution requires the configured workspace LLM.');

  const result = await llm.completeWithTools({
    system: [
      'You resolve one user objective against a closed capability registry.',
      'Select exactly one listed capability and one of its supported operations.',
      'The aliases of a capability are the strongest signal: match them before the generic description.',
      // Without an explicit way out, the model has to pick SOMETHING: an
      // objective no listed capability covers ("authorize Gmail") came back as
      // workspace.diagnose/doctor and launched an unrelated job. Declining is
      // a valid answer and the caller turns it into a plain reply.
      'If no listed capability can achieve the objective, do not pick the closest one:',
      'return {"capability":null,"reason":"<short reason>"}.',
      'Never invent identifiers. Return JSON only: {"capability":"...","operation":"..."}.',
    ].join('\n'),
    tools: [],
    messages: [{
      role: 'user',
      content: `Objective:\n${clean}\n\nRegistry:\n${JSON.stringify(candidates, null, 2)}`,
    }],
    signal: session?._abortSignal,
  });
  const selection = parseJson(result?.content);
  if (selection?.capability === null) {
    throw new ObjectiveNotOrchestrableError(objective, candidates, selection?.reason);
  }
  const capability = String(selection?.capability ?? '');
  const operation = String(selection?.operation ?? '');
  const candidate = candidates.find((item) => item.id === capability);
  if (!candidate) throw new Error(`Objective resolver selected unknown capability "${capability}".`);
  if (!candidate.operations.includes(operation)) {
    throw new Error(`Objective resolver selected unsupported operation "${operation}" for ${capability}.`);
  }
  return selectionWithProvider(session, { capability, operation }, candidates);
}

// The best-effort notification sentence and the negative guardrails
// ("Do not …", "Never …") are execution constraints, not the thing being
// resolved. They are kept intact for the delegated agent (prepareDelegation
// passes the original objective), but stripped here so they cannot poison the
// lexical matcher or the LLM prompt.
const NOTIFICATION_RE = /\s*[^.!?]*\bnotification\b[^.!?]*[.!?]/g;
const GUARDRAIL_RE = /\s*\b(?:Do not|do not|Never|never)\b[^.]*\./g;

export function objectiveForResolution(objective) {
  return String(objective ?? '')
    .replace(NOTIFICATION_RE, ' ')
    .replace(GUARDRAIL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function normalizePhrase(value) {
  return normalizeText(value).replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function phraseIn(phrase, words, text) {
  if (!phrase) return false;
  if (!phrase.includes(' ')) return words.includes(phrase);
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(text);
}

// Deterministic fast path, safe by construction:
// - whole-word/phrase matching only — no sub-token split (so `ingest_plan`
//   never matches the generic word "plan") and no prefix stemming (so
//   "exported"/"builds" never match "export"/"build");
// - aliases (declared by each agent in agent_describe) are authoritative and
//   disambiguate overloaded verbs ("export" CME vs publish);
// - it fires only when exactly one capability is named, otherwise the LLM
//   resolver decides. A new external agent registers simply by declaring its
//   aliases; nothing here is hardcoded.
function resolveMentionedRegistryOperation(objective, candidates) {
  const words = normalizeText(objective).match(/[a-z0-9]+/g) ?? [];
  const text = normalizeText(objective);

  const aliasHits = candidates
    .map((candidate) => {
      const matchedAlias = (candidate.aliases ?? []).find((alias) =>
        phraseIn(normalizePhrase(alias), words, text));
      if (matchedAlias === undefined) return null;
      // A capability with more than one operation may declare
      // aliasOperations, mapping the specific alias phrase that matched to
      // the operation it actually names. Without it, operations[0]
      // (alphabetical) is a silent guess: for knowledge.concepts this always
      // picked the destructive grid-rebuild "concepts" operation, even when
      // the matched alias ("reclassify concepts", "file unclassified
      // concepts") named the safe, mechanical "reclassify-concepts" one —
      // making that operation structurally unreachable from natural language.
      const operation = candidate.aliasOperations?.[matchedAlias] ?? candidate.operations[0];
      return { capability: candidate.id, operation };
    })
    .filter(Boolean);
  if (aliasHits.length === 1) return aliasHits[0];
  if (aliasHits.length > 1) return null;

  const opHits = [];
  for (const candidate of candidates) {
    const matched = candidate.operations.filter((operation) =>
      phraseIn(normalizePhrase(operation), words, text));
    if (matched.length === 1) opHits.push({ capability: candidate.id, operation: matched[0] });
    else if (matched.length > 1) opHits.push({ capability: candidate.id, operation: matched[0], ambiguous: true });
  }
  if (opHits.length === 1 && !opHits[0].ambiguous) {
    const { capability, operation } = opHits[0];
    return { capability, operation };
  }
  return null;
}

function selectionWithProvider(session, selection, candidates) {
  const { capability, operation } = selection;
  const providers = providersFor(session, capability)
    .filter((provider) => !operation || (provider.capability?.supportedOperations ?? []).includes(operation))
    .sort((a, b) => String(a.agentInstanceId).localeCompare(String(b.agentInstanceId)));
  if (providers.length === 0) throw new Error(`No healthy agent provides ${capability}/${operation}.`);
  return { capability, operation, provider: providers[0], candidates };
}

export function capabilityCandidates(session) {
  const snapshot = registrySnapshot(session);
  const byId = new Map();
  for (const [versionedId, providers] of Object.entries(snapshot)) {
    const id = versionedId.includes('@') ? versionedId.slice(0, versionedId.lastIndexOf('@')) : versionedId;
    const operations = [...new Set((providers ?? []).flatMap((provider) => provider?.capability?.supportedOperations ?? []))].sort();
    const aliases = [...new Set((providers ?? []).flatMap((provider) => provider?.capability?.aliases ?? []))].sort();
    const aliasOperations = Object.assign(
      {},
      ...(providers ?? []).map((provider) => provider?.capability?.aliasOperations ?? {}),
    );
    const description = (providers ?? []).map((provider) => provider?.capability?.description).find(Boolean) ?? '';
    byId.set(id, { id, description, operations, aliases, aliasOperations });
  }
  return [...byId.values()].filter((item) => item.operations.length > 0).sort((a, b) => a.id.localeCompare(b.id));
}

function providersFor(session, capability) {
  if (session?.capabilityRegistry?.providersFor) return session.capabilityRegistry.providersFor(capability) ?? [];
  return Object.entries(registrySnapshot(session))
    .filter(([key]) => key === capability || key.startsWith(`${capability}@`))
    .flatMap(([, providers]) => providers ?? []);
}

function registrySnapshot(session) {
  const registry = session?.capabilityRegistry;
  if (registry?.snapshot) return registry.snapshot();
  if (registry && typeof registry === 'object') return registry;
  const agents = session?.agentRegistry?.snapshot?.() ?? session?.agentRegistrySnapshot ?? [];
  const snapshot = {};
  for (const agent of agents) {
    for (const capability of agent?.description?.capabilities ?? []) {
      const key = `${capability.id}@${capability.version ?? '1'}`;
      (snapshot[key] ??= []).push({
        agentInstanceId: agent.agentInstanceId,
        serverName: agent.serverName,
        capability,
        description: agent.description,
        health: agent.health,
      });
    }
  }
  return snapshot;
}

function parseJson(content) {
  const text = String(content ?? '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : text);
}
