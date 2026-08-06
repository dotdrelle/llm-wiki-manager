import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Config a freshly created workspace inherits from an existing one.
 *
 * A new workspace was scaffolded with placeholder values only
 * (`YOUR_MODEL_NAME`, `https://mon-provider.example.com/v1`…), so the operator
 * had to redo the whole LLM setup by hand — reachable endpoint, gateway key,
 * model name, vector settings — every single time, for values they had already
 * proven working next door. `/new` now carries them over.
 *
 * Two rules make this safe rather than merely convenient:
 *
 *   - Only ABSENT or PLACEHOLDER target values are filled. Anything the
 *     scaffold or the operator already set for real is left alone, so this can
 *     never overwrite a deliberate choice.
 *   - `mcp.accessKey` is never inherited. It is the workspace's own credential
 *     and `initializeWorkspaceWikirc` has already written the right one.
 */

// Kept identical to SetupWizard.tsx on purpose — the wizard applies the same
// "a scaffolded value is not an answer" rule. `workspaceInherit.test.js`
// asserts the two literals stay in sync.
export const PLACEHOLDER_VALUE_RE = /YOUR_|<your|example\.com|infinity\.local/i;

const INHERITED_LLM_KEYS = ['baseUrl', 'model', 'apiKey', 'temperature', 'timeoutMs'];

// `provider` and `engine` describe HOW the endpoint in `baseUrl` behaves, so
// they are bound to it rather than inherited on their own merit.
//
// The scaffold ships `provider: openai-compatible` / `engine: generic` as
// defaults, and those are real values — not placeholders the fill rule would
// replace. Inheriting a gateway's `baseUrl` while leaving them behind produced
// a config claiming a direct openai-compatible server against an AI gateway:
// exactly the conflation the provider/engine split was introduced to end.
const ENDPOINT_BOUND_KEYS = ['provider', 'engine'];

// `retrieval.vector` stays independent from `llm` but inherits provider/engine/
// baseUrl/apiKey when absent, so only keys the source states EXPLICITLY are
// worth carrying: copying an inherited value would freeze it and break the
// link the source deliberately left open.
const INHERITED_VECTOR_KEYS = [
  'enabled',
  'provider',
  'engine',
  'baseUrl',
  'apiKey',
  'embeddingModel',
  'rerankerModel',
];

/** A value the operator actually chose, as opposed to scaffold filler. */
export function isRealValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean' || typeof value === 'number') return true;
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return text.length > 0 && !PLACEHOLDER_VALUE_RE.test(text);
}

function inheritSection(sourceSection, targetSection, keys, prefix, patch, inherited) {
  for (const key of keys) {
    const from = sourceSection?.[key];
    if (!isRealValue(from)) continue;
    // Present AND real on the target: a deliberate value, never overwritten.
    if (isRealValue(targetSection?.[key])) continue;
    patch[key] = from;
    inherited.push(`${prefix}.${key}`);
  }
}

/**
 * @param sourceConfig parsed `.wikirc.yaml` of the workspace to copy from
 * @param targetConfig parsed `.wikirc.yaml` of the freshly created workspace
 * @returns `{ patch, inherited }` — `patch` is shaped for `patchWikircProfile`
 *   and is `{}` when there is nothing to carry over.
 */
export function buildInheritedWikircPatch(sourceConfig, targetConfig) {
  const inherited = [];
  const llm = {};
  const vector = {};

  inheritSection(sourceConfig?.llm, targetConfig?.llm, INHERITED_LLM_KEYS, 'llm', llm, inherited);
  // Only once the endpoint itself has been taken over.
  if (llm.baseUrl) {
    for (const key of ENDPOINT_BOUND_KEYS) {
      const from = sourceConfig?.llm?.[key];
      if (!isRealValue(from) || from === targetConfig?.llm?.[key]) continue;
      llm[key] = from;
      inherited.push(`llm.${key}`);
    }
  }

  inheritSection(
    sourceConfig?.retrieval?.vector,
    targetConfig?.retrieval?.vector,
    INHERITED_VECTOR_KEYS,
    'retrieval.vector',
    vector,
    inherited,
  );

  // The gateway key unlocks every provider behind it. If the vector endpoint
  // ends up on a different host than the LLM one, an inherited apiKey would be
  // sent there — the exact leak the wizard already refuses to create. Drop the
  // inherited baseUrl rather than the key: staying on the LLM endpoint is the
  // conservative default, and the operator can still point it elsewhere.
  const effectiveLlmBaseUrl = llm.baseUrl ?? targetConfig?.llm?.baseUrl ?? sourceConfig?.llm?.baseUrl;
  const effectiveVectorBaseUrl = vector.baseUrl ?? targetConfig?.retrieval?.vector?.baseUrl;
  const hasOwnVectorKey = isRealValue(vector.apiKey ?? targetConfig?.retrieval?.vector?.apiKey);
  if (effectiveVectorBaseUrl && effectiveVectorBaseUrl !== effectiveLlmBaseUrl && !hasOwnVectorKey) {
    delete vector.baseUrl;
    const index = inherited.indexOf('retrieval.vector.baseUrl');
    if (index >= 0) inherited.splice(index, 1);
  }

  const patch = {};
  if (Object.keys(llm).length > 0) patch.llm = llm;
  if (Object.keys(vector).length > 0) patch.retrieval = { vector };
  return { patch, inherited };
}

export function cmeCredentialsPath(agentsDataDir, workspaceName) {
  return join(agentsDataDir, 'cme', workspaceName, 'cme', 'app_data.json');
}

/**
 * Carry the Confluence credentials of an existing workspace over to a new one.
 *
 * `app_data.json` only — NOT `sources-manifest.yaml`. The credentials are a
 * property of the operator's Confluence account and are identical everywhere;
 * which spaces and pages a workspace exports is precisely what makes it a
 * different workspace, and copying that would silently re-export someone
 * else's scope on the first run.
 */
export async function copyCmeCredentials(agentsDataDir, sourceWorkspace, targetWorkspace) {
  if (!agentsDataDir || !sourceWorkspace || !targetWorkspace) return null;
  if (sourceWorkspace === targetWorkspace) return null;
  const from = cmeCredentialsPath(agentsDataDir, sourceWorkspace);
  const to = cmeCredentialsPath(agentsDataDir, targetWorkspace);
  if (!existsSync(from)) return null;
  // An existing target file is a real configuration; never clobber it.
  if (existsSync(to)) return null;
  await mkdir(join(agentsDataDir, 'cme', targetWorkspace, 'cme'), { recursive: true });
  await copyFile(from, to);
  return to;
}
