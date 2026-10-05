/** @jsxImportSource @opentui/solid */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { useKeyboard, usePaste } from '@opentui/solid';
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import {
  DISCOVERY_TIMEOUT_MS,
  defaultBaseUrl,
  fallbackModels,
  fetchGatewayCatalog,
  fetchServerCatalog,
  normalizeEngine,
  normalizeProvider,
  requiresBaseUrl,
  transportSummary,
} from '../core/modelFetch.js';
import { checkInternetConnectivity } from '../core/startupCheck.js';
import {
  createNewWorkspace,
  deleteWorkspaceAndFiles,
  renameWorkspace,
  startAgents,
  unregisterWorkspace,
  writeLanguageConfig,
  writeLlmConfig,
  writeVectorConfig,
} from '../core/wikiSetup.js';
import { listWorkspaces, workspacesDir } from '../core/workspaces.js';
import { loadWikircProfile } from '../core/wikirc.js';
import { wrapText } from './wrapText.js';

type Gap = { kind: 'agents' | 'network' | 'workspace' | 'llm' | 'vector'; context?: Record<string, any> };
type Mode = 'startup' | 'setup';
type Step =
  | { kind: 'menu'; title: string; items: Array<{ label: string; value: string; muted?: boolean }> }
  | { kind: 'confirm'; title: string; message: string; yesLabel: string; noLabel: string }
  | { kind: 'select'; title: string; label: string; options: string[]; note?: string }
  | {
      kind: 'text';
      title: string;
      label: string;
      note?: string;
      placeholder?: string;
      prefill?: string;
      secret?: boolean;
      /**
       * Discovered catalog. Purely indicative: the text field is authoritative,
       * which keeps the step usable when the endpoint is unreachable or when the
       * intended model is not in it.
       */
      suggestions?: string[];
      /** Configured value dropped because it is absent from the discovered catalog. */
      stale?: string | null;
    }
  | { kind: 'done' };
type LogEntry = { icon: string; label: string; detail?: string };

// Two axes, two questions. `provider` says where requests are sent, `engine`
// says how the server on the other end behaves. Merging them was precisely
// what prevented a gateway from being described.
const PROVIDERS = [
  'Direct server (OpenAI-compatible)',
  'AI gateway (LiteLLM, Bifrost, Portkey…)',
];
const ENGINE_OPTIONS = [
  'OpenAI',
  'Ollama (local)',
  'vLLM (local)',
  'MLX (local)',
  'Albert',
  'Other (generic OpenAI-compatible)',
];
// The scaffolded .wikirc.yaml ships fake endpoints and secrets so the file
// documents its own shape (`https://mon-provider.example.com/v1`,
// `http://infinity.local:7997/v1`, `YOUR_LLM_API_KEY`…). Preloading them into
// the wizard turned every field into a plausible-looking answer the operator
// had to notice and delete — and a skipped step silently wrote the fake value
// to the real config. Treat them as "not configured" instead.
const PLACEHOLDER_VALUE_RE = /YOUR_|<your|example\.com|infinity\.local/i;

function configuredValue(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && !PLACEHOLDER_VALUE_RE.test(text) ? text : null;
}
const MAIN_MENU = ['Agents', 'Workspaces', 'LLM configuration', 'Vector search', '---', 'Close'];

// The defaults and the question "should a baseUrl be requested?" live in
// core/modelFetch.js, the single source shared with discovery.
function exampleBaseUrl(provider: string, engine: string) {
  return defaultBaseUrl(provider, engine);
}

function currentWorkspaceContext(session: any, fallback?: any) {
  if (fallback?.workspacePath) {
    return {
      workspaceName: fallback.workspaceName ?? fallback.name ?? fallback.workspace ?? null,
      workspacePath: fallback.workspacePath,
      profileName: fallback.profileName ?? fallback.profile ?? 'default',
      configError: fallback.configError ?? null,
    };
  }
  if (session?.workspacePath) {
    return {
      workspaceName: session.workspace,
      workspacePath: session.workspacePath,
      profileName: session.wikirc?.profile ?? 'default',
    };
  }
  const workspace = listWorkspaces()[0];
  if (!workspace) return null;
  return {
    workspaceName: workspace.name,
    workspacePath: workspace.workspacePath,
    profileName: 'default',
  };
}

function selectable(items: string[]) {
  return items.map((label) => ({ label, value: label, muted: label === '---' }));
}

function workspaceItems() {
  const workspaces = listWorkspaces();
  return [
    { label: 'Create new workspace', value: 'create' },
    { label: '---', value: '---', muted: true },
    ...workspaces.map((workspace) => ({
      label: workspace.name,
      value: `workspace:${workspace.name}`,
    })),
    { label: '---', value: '---', muted: true },
    { label: '<- Back', value: 'back' },
  ];
}

function defaultWorkspacePath(name: string) {
  return join(workspacesDir(), name || 'my-project');
}

function firstSelectableIndex(items: Array<{ muted?: boolean }>, from = 0, delta = 1) {
  if (items.length === 0) return 0;
  let index = from;
  for (let i = 0; i < items.length; i += 1) {
    index = (index + items.length) % items.length;
    if (!items[index]?.muted) return index;
    index += delta;
  }
  return 0;
}

function stepTitle(step: Step) {
  return step.kind === 'done' ? 'Setup complete' : step.title;
}

/**
 * "Field" part of a model step: prefill, hint, catalog.
 *
 * The prefill only takes back what is *already configured*. Choosing the first
 * discovered model for the operator filtered the list on itself right away —
 * the list only showed one entry out of ten — and proposed an answer that had
 * no reason to be the right one. When nothing is configured, the field stays
 * empty and the grey hint shows the expected shape.
 */
function suggestionField(discovered: string[], configured?: string | null, example = '') {
  // A model absent from the catalog must not be prefilled: it would filter
  // the list down to zero results, and the screen would show "No match" in
  // front of ten available models. This is exactly the case of the scaffold's
  // `BAAI/bge-m3` facing a server that names the same model differently.
  const usable = configured && (discovered.length === 0 || discovered.includes(configured))
    ? configured
    : null;
  return {
    // Without a catalog there is no list to hide: the example becomes a
    // useful prefill again rather than an imposed choice.
    prefill: usable ?? (discovered.length === 0 ? example : ''),
    placeholder: discovered.length > 0 ? '↑↓ to browse the list, or type a name' : example,
    suggestions: discovered,
    /** Reminder shown when the configured value was dropped. */
    stale: configured && !usable ? configured : null,
  };
}


export function SetupWizard(props: {
  mode: Mode;
  session?: any;
  gaps?: Gap[];
  width: number;
  height: number;
  initialRoute?: string;
  initialWorkspaceName?: string;
  initialWorkspacePath?: string | null;
  closeOnDone?: boolean;
  onComplete: () => void;
  onClose: () => void;
}) {
  const [route, setRoute] = createSignal(props.initialRoute ?? 'startup');
  const [routeHistory, setRouteHistory] = createSignal<string[]>([]);
  const [stepIndex, setStepIndex] = createSignal(0);
  const [selected, setSelected] = createSignal(0);
  const [input, setInput] = createSignal('');
  /**
   * Entry hovered in the model list, `-1` when typing freely.
   *
   * The list was only a reminder: navigating it was impossible, so the wizard
   * prefilled the first discovered model so that there would be at least one
   * answer. That prefill filtered the list on itself — only one model out of
   * ten remained visible, and rarely the right one.
   */
  const [highlight, setHighlight] = createSignal(-1);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const [logs, setLogs] = createSignal<LogEntry[]>([]);
  const [targetWorkspace, setTargetWorkspace] = createSignal<any>(null);
  const [creationFlow, setCreationFlow] = createSignal(false);
  const [language, setLanguage] = createSignal('');
  const [llm, setLlm] = createSignal<any>({});
  const [vector, setVector] = createSignal<any>({});

  const startupGaps = createMemo(() => props.gaps ?? []);
  createEffect(() => {
    if (props.mode === 'startup' && startupGaps().length === 0) props.onComplete();
  });

  const currentGap = () => startupGaps()[stepIndex()];
  // The dialog now occupies most of the terminal. Labels, notes and error
  // causes are sentences, not tags: at 72 columns and 30 lines they overflowed,
  // while the lower half of the frame stayed empty.
  const dialogWidth = () => Math.max(50, Math.min(110, Math.floor(props.width * 0.86)));
  const dialogHeight = () => Math.max(24, Math.min(40, Math.floor(props.height * 0.86)));
  /** Usable width: border (1) + padding (1) on each side. */
  const textWidth = () => Math.max(20, dialogWidth() - 4);
  const left = () => Math.max(1, Math.floor((props.width - dialogWidth()) / 2));
  const top = () => Math.max(1, Math.floor((props.height - dialogHeight()) / 2));

  const step = createMemo<Step>(() => {
    const currentRoute = route();
    if (props.mode === 'setup' && currentRoute === 'main') {
      return { kind: 'menu', title: 'wiki-manager - Setup', items: selectable(MAIN_MENU) };
    }
    if (currentRoute === 'workspaces') {
      return { kind: 'menu', title: 'Manage workspaces', items: workspaceItems() };
    }
    if (currentRoute.startsWith('workspace:')) {
      const workspace = listWorkspaces().find((item) => item.name === currentRoute.slice('workspace:'.length));
      if (!workspace) return { kind: 'menu', title: 'Workspace not found', items: selectable(['<- Back']) };
      return {
        kind: 'menu',
        title: workspace.name,
        items: [
          { label: 'Edit LLM configuration', value: 'llm' },
          { label: 'Edit vector search', value: 'vector' },
          { label: 'Rename', value: 'rename' },
          { label: 'Unregister', value: 'unregister' },
          { label: 'Delete all files', value: 'delete' },
          { label: '<- Back', value: 'back' },
        ],
      };
    }
    if (currentRoute === 'agents') {
      const agentContext = props.mode === 'startup' ? currentGap()?.context : null;
      if (agentContext?.dockerMissing) {
        return {
          kind: 'confirm',
          title: 'Docker not installed',
          message: 'Docker is required to run agents.\nInstall Docker Desktop and restart wiki-manager.',
          yesLabel: 'Try anyway',
          noLabel: 'Skip',
        };
      }
      if (agentContext?.dockerUnavailable) {
        return {
          kind: 'confirm',
          title: 'Docker not responding',
          message: 'Docker daemon is not running.\nStart Docker Desktop, then retry.',
          yesLabel: 'Retry',
          noLabel: 'Skip',
        };
      }
      const serviceList = agentContext?.downServices?.join(', ');
      return {
        kind: 'confirm',
        title: 'Agents',
        message: serviceList
          ? `Agents not running: ${serviceList}.\nStart them now?`
          : 'Start external agents?',
        yesLabel: 'Start',
        noLabel: 'Skip',
      };
    }
    if (currentRoute === 'network') {
      const context = currentGap()?.context ?? {};
      const transport = context.proxyUrl
        ? `Proxy: ${context.proxyEnabled ? context.proxyUrl : `${context.proxyUrl} (NODE_USE_ENV_PROXY is not enabled)`}`
        : 'Proxy: direct connection';
      const certificate = context.cacertPath ? `CA: ${context.cacertPath}` : 'CA: system trust store';
      return {
        kind: 'confirm',
        title: 'Internet connectivity',
        message: `Could not reach ${context.url ?? 'the connectivity endpoint'}.\n${transport}\n${certificate}\n${context.error ?? ''}`.trim(),
        yesLabel: 'Retry',
        noLabel: 'Skip',
      };
    }
    if (currentRoute === 'workspace-confirm') {
      return { kind: 'confirm', title: 'Workspace', message: 'No workspace configured.', yesLabel: 'Create', noLabel: 'Skip' };
    }
    if (currentRoute === 'workspace-name') {
      return { kind: 'text', title: 'Workspace', label: 'Workspace name', prefill: props.initialWorkspaceName ?? '' };
    }
    if (currentRoute === 'language') {
      return { kind: 'text', title: 'Workspace', label: 'Language (2 chars, e.g. fr, en)', prefill: language() };
    }
    if (currentRoute === 'workspace-rename') {
      return { kind: 'text', title: 'Rename workspace', label: 'New workspace name', prefill: targetWorkspace()?.name ?? '' };
    }
    if (currentRoute === 'llm-provider') {
      const context = currentWorkspaceContext(props.session, currentGap()?.context ?? targetWorkspace());
      return {
        kind: 'select',
        title: 'LLM configuration',
        label: context?.configError
          ? `${context.configError} Select how requests are routed after creating or fixing the config:`
          : `No LLM configured${context?.workspaceName ? ` for ${context.workspaceName}` : ''}. How are requests routed?`,
        options: PROVIDERS,
        note: 'A gateway is external infrastructure you deploy yourself; llm-wiki only reads its model catalog.',
      };
    }
    if (currentRoute === 'llm-engine') {
      return {
        kind: 'select',
        title: 'LLM configuration',
        label: 'Which server is answering?',
        options: ENGINE_OPTIONS,
        note: 'Drives request-shaping workarounds and the `wiki doctor` calibration.',
      };
    }
    if (currentRoute === 'llm-baseurl') {
      const isGateway = llm().provider === 'ai-gateway';
      const example = exampleBaseUrl(llm().provider, llm().engine);
      return {
        kind: 'text',
        title: 'LLM configuration',
        label: isGateway ? 'Gateway base URL' : 'Base URL',
        note: isGateway
          ? 'Example: http://gateway:4000/v1'
          : example
            ? `Example: ${example}`
            : undefined,
        prefill: llm().baseUrl || '',
      };
    }
    if (currentRoute === 'llm-apikey') {
      return {
        kind: 'text',
        title: 'LLM configuration',
        label: 'API key',
        note: 'Required. The model catalog is read in the background right after.',
        secret: true,
      };
    }
    if (currentRoute === 'llm-model') {
      const discovered = catalog()?.chat ?? [];
      return {
        kind: 'text',
        title: 'LLM configuration',
        // The example lives in the field hint and in the discovered list;
        // repeating it in the label made it the longest line on the
        // screen, for information already visible twice.
        label: 'Chat model',
        note: 'Required: an agentic model with tool/function calling support.',
        // Prefilling with the first discovered model filtered the list on
        // itself: nine models out of ten became invisible, and the proposed
        // answer was arbitrary. Only an already configured model is taken back.
        ...suggestionField(discovered, llm().model, fallbackModels(llm().engine)[0] ?? 'provider-agentic-model'),
      };
    }
    if (currentRoute === 'vector-confirm') {
      return { kind: 'confirm', title: 'Vector search', message: 'Configure vector search?', yesLabel: 'Enable', noLabel: 'Skip' };
    }
    if (currentRoute === 'vector-baseurl') {
      const baseUrl = vector().baseUrl || llm().baseUrl;
      return { kind: 'text', title: 'Vector search', label: 'Embeddings/rerank base URL', prefill: baseUrl, placeholder: baseUrl };
    }
    if (currentRoute === 'vector-apikey') {
      // Inheritance is only offered as long as the URL has not diverged:
      // otherwise the LLM key — the gateway's, which unlocks every provider —
      // would go to another host.
      const diverged = vectorBaseUrlDiverged();
      const hint = !diverged && llm().apiKey ? '(leave empty to reuse LLM key)' : undefined;
      return {
        kind: 'text',
        title: 'Vector search',
        label: diverged ? 'Vector API key (required: different host)' : 'Vector API key',
        placeholder: hint,
        secret: true,
      };
    }
    if (currentRoute === 'vector-model') {
      const discovered = catalog()?.embedding ?? [];
      return {
        kind: 'text',
        title: 'Vector search',
        label: 'Embedding model',
        note: 'Model exposed by the embeddings endpoint.',
        ...suggestionField(
          discovered,
          vector().embeddingModel,
          fallbackModels(llm().engine, 'embedding')[0] ?? '',
        ),
      };
    }
    if (currentRoute === 'vector-rerank') {
      return { kind: 'confirm', title: 'Vector search', message: 'Enable reranking?', yesLabel: 'Enable', noLabel: 'Skip' };
    }
    if (currentRoute === 'vector-rerank-model') {
      const discovered = catalog()?.rerank ?? [];
      return {
        kind: 'text',
        title: 'Vector search',
        label: 'Rerank model',
        note: 'Leave reranking disabled if no rerank model is available.',
        ...suggestionField(discovered, vector().rerankerModel, 'BAAI/bge-reranker-v2-m3'),
      };
    }
    if (currentRoute === 'unregister-confirm') {
      const workspace = targetWorkspace();
      return {
        kind: 'select',
        title: 'Unregister workspace',
        label: `Remove ${workspace?.name ?? 'workspace'} from registry. Source files at ${workspace?.workspacePath ?? '-'} are kept.`,
        options: ['Cancel', 'Confirm'],
      };
    }
    if (currentRoute === 'delete-confirm') {
      const workspace = targetWorkspace();
      return {
        kind: 'select',
        title: 'Delete workspace files',
        label: `Permanently delete ${workspace?.workspacePath ?? '-'} and remove from registry. This cannot be undone.`,
        options: ['Cancel', 'Confirm'],
      };
    }
    return { kind: 'done' };
  });

  createEffect(() => {
    const s = step();
    setError(null);
    setInput((s as any).prefill ?? '');
    setHighlight(-1);
    const items = (s as any).items ?? (s as any).options?.map((label: string) => ({ label })) ?? [{ label: 'x' }];
    let preferred = -1;
    // The routing question is asked again on every pass — that is simpler
    // and more honest than remembering it in a dedicated field. We merely
    // preselect what the wikirc already declares.
    if (route() === 'llm-provider' && llm().provider) {
      preferred = PROVIDERS.findIndex(
        (p) => normalizeProvider(p) === normalizeProvider(llm().provider),
      );
    }
    if (route() === 'llm-engine' && llm().engine) {
      preferred = ENGINE_OPTIONS.findIndex(
        (e) => normalizeEngine(e) === normalizeEngine(llm().engine),
      );
    }
    setSelected(preferred >= 0 ? preferred : firstSelectableIndex(items));
  });

  /**
   * Catalog discovered from the server or the gateway. It only serves to
   * prefill: the text field remains the truth, which keeps the wizard
   * usable when the endpoint is unreachable or when the intended model is
   * not in it.
   */
  const [catalog, setCatalog] = createSignal<any>(null);
  const [catalogError, setCatalogError] = createSignal<string | null>(null);
  /** URL being queried while discovery is in flight, otherwise `null`. */
  const [discovering, setDiscovering] = createSignal<string | null>(null);
  /**
   * Number of the current discovery.
   *
   * Discovery no longer blocks the next step: a late response can therefore
   * come back after the operator has already corrected the URL or the key and
   * restarted a discovery. Without this counter, the old response would
   * overwrite the new one.
   */
  let discoveryRun = 0;

  /**
   * Starts discovery **without waiting for it**.
   *
   * This was the real cause of the freeze: the key entry went into a silent
   * `await`, and the next screen only appeared once the network settled. A
   * catalog is only prefill after all — the text field is authoritative. The
   * step is therefore displayed right away, and the list fills in when it
   * arrives.
   */
  function startDiscovery(target?: {
    provider?: string;
    engine?: string;
    baseUrl?: string;
    apiKey?: string;
  }) {
    const source = target ?? llm();
    const { provider, engine, baseUrl, apiKey } = source as any;
    setCatalog(null);
    setCatalogError(null);
    if (!baseUrl) return;
    discoveryRun += 1;
    const run = discoveryRun;
    setDiscovering(baseUrl);

    const isGateway = normalizeProvider(provider) === 'ai-gateway';
    // A direct server exposes a single, untyped catalog: querying chat then
    // embeddings hit the same URL twice with the same headers, for the same
    // response — and paid the delay twice.
    const promise = isGateway
      ? fetchGatewayCatalog(baseUrl, apiKey, {
          // The flat list arrives first and is enough to choose: it is
          // displayed right away, then replaced by the typed catalog
          // while the operator reads their options.
          onPartial: (partial: any) => {
            if (run === discoveryRun) setCatalog(partial);
          },
        })
      : fetchServerCatalog(provider, baseUrl, apiKey, { engine });

    promise
      .then((found: any) => {
        if (run !== discoveryRun) return;
        if (!found.ok) setCatalogError(found.error ?? 'endpoint unreachable');
        else setCatalog(found);
      })
      .catch((err) => {
        if (run !== discoveryRun) return;
        setCatalogError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (run === discoveryRun) setDiscovering(null);
      });
  }

  function modelCount(found: any) {
    return new Set([...(found?.chat ?? []), ...(found?.embedding ?? []), ...(found?.rerank ?? [])]).size;
  }

  /**
   * Discovery status block, rendered under the input field.
   *
   * It occupies the free space in the middle of the dialog, where there was
   * nothing: what is being attempted, against which URL, with which transport,
   * and what came of it.
   */
  const discoveryLines = createMemo<Array<{ text: string; fg: string }>>(() => {
    const width = textWidth();
    const rows: Array<{ text: string; fg: string }> = [];
    // Indentation is applied to every line: `wrapText` normalizes spaces, and
    // a prefix passed in the text would be lost on the first line.
    const indent = '  ';
    const push = (text: string, fg: string, maxLines = 3) => {
      for (const line of wrapText(text, width - indent.length, maxLines)) {
        rows.push({ text: `${indent}${line}`, fg });
      }
    };
    const pending = discovering();
    const partial = catalog();
    if (pending && partial) {
      // The flat list is already usable; only typing is still missing.
      rows.push({ text: `✓ ${modelCount(partial)} model(s) available`, fg: '#8BD5CA' });
      rows.push({ text: '⟳ Refining chat/embedding/rerank types…', fg: '#FBBF24' });
      return rows;
    }
    if (pending) {
      rows.push({ text: '⟳ Reading the model catalog…', fg: '#FBBF24' });
      push(pending, '#7F8C8D', 2);
      push(transportSummary(), '#7F8C8D', 2);
      return rows;
    }
    const failure = catalogError();
    if (failure) {
      rows.push({ text: '⚠ Model catalog unavailable', fg: '#FBBF24' });
      push(`Cause: ${failure}`, '#F87171', 3);
      push(`Transport: ${transportSummary()}`, '#7F8C8D', 2);
      push('Type the model name below; it is used as-is.', '#7F8C8D', 2);
      return rows;
    }
    const found = partial;
    if (found) {
      rows.push({ text: `✓ ${modelCount(found)} model(s) available`, fg: '#8BD5CA' });
      push(
        found.typed
          ? 'Typed catalog: chat, embedding and rerank lists are filtered.'
          : 'Untyped catalog: the server does not say which model does what, so the three lists are identical.',
        '#7F8C8D',
        3,
      );
    }
    const stale = (step() as any).stale;
    if (stale) {
      push(`Configured "${stale}" is not in this catalog — pick one below.`, '#FBBF24', 2);
    }
    return rows;
  });

  /** Discovery steps: the status block only makes sense there. */
  const DISCOVERY_ROUTES = new Set(['llm-apikey', 'llm-model', 'vector-model', 'vector-rerank-model']);
  const showDiscoveryPanel = () => discovering() !== null || DISCOVERY_ROUTES.has(route());

  /**
   * Position within the current phase, displayed at the top right.
   *
   * The sequence is rebuilt from the choices already made, because it is
   * genuinely variable: a gateway skips the engine question, a hosted engine
   * skips the URL, Ollama skips the key. Announcing a fixed total would be
   * wrong.
   */
  function llmFlow() {
    const provider = llm().provider;
    const engine = llm().engine;
    const steps = ['llm-provider'];
    if (normalizeProvider(provider) !== 'ai-gateway') steps.push('llm-engine');
    if (requiresBaseUrl(provider, engine)) steps.push('llm-baseurl');
    if (normalizeProvider(provider) === 'ai-gateway' || normalizeEngine(engine) !== 'ollama') {
      steps.push('llm-apikey');
    }
    steps.push('llm-model');
    return steps;
  }

  function vectorFlow() {
    const steps = ['vector-confirm', 'vector-baseurl', 'vector-apikey', 'vector-model', 'vector-rerank'];
    if (vector().rerankEnabled) steps.push('vector-rerank-model');
    return steps;
  }

  function progressLabel() {
    const current = route();
    for (const flow of [llmFlow(), vectorFlow()]) {
      const index = flow.indexOf(current);
      if (index >= 0) return `Step ${index + 1} of ${flow.length}`;
    }
    return '';
  }

  /** True when the vector URL no longer points at the same host as the LLM. */
  function vectorBaseUrlDiverged() {
    const vectorUrl = vector().baseUrl;
    const llmUrl = llm().baseUrl;
    if (!vectorUrl || !llmUrl) return false;
    return vectorUrl.replace(/\/+$/, '') !== llmUrl.replace(/\/+$/, '');
  }

  function preloadWikirc(context: any) {
    const workspacePath = context?.workspacePath;
    if (!workspacePath) return;
    try {
      const { config } = loadWikircProfile(workspacePath, context?.profileName ?? 'default');
      if (config?.language) setLanguage(String(config.language));
      if (config?.llm?.provider) {
        setLlm({
          provider: normalizeProvider(config.llm.provider),
          // A pre-0.16 wikirc carries the engine in `provider`
          // (`ollama`, `openai`; the former `anthropic` falls back to `generic`).
          // Without this deduction, the engine
          // step preselects nothing and proposes OpenAI first — at the
          // risk of overwriting a configuration that worked.
          engine: config.llm.engine
            ? normalizeEngine(config.llm.engine)
            : normalizeProvider(config.llm.provider) === 'ai-gateway'
              ? null
              : normalizeEngine(config.llm.provider),
          baseUrl: configuredValue(config.llm.baseUrl),
          apiKey: configuredValue(config.llm.apiKey),
          model: configuredValue(config.llm.model),
        });
      }
      if (config?.retrieval?.vector) {
        setVector({
          provider: config.retrieval.vector.provider,
          // Null here is what makes the embeddings step fall back to the base
          // URL the operator just entered, instead of the scaffold's fake one.
          baseUrl: configuredValue(config.retrieval.vector.baseUrl),
          apiKey: configuredValue(config.retrieval.vector.apiKey),
          // Model names were the only two fields escaping the
          // filter: the scaffold's `BAAI/bge-m3` therefore arrived in the wizard
          // as a chosen answer, and served as a filter on a catalog
          // that names the same model differently.
          embeddingModel: configuredValue(config.retrieval.vector.embeddingModel),
          rerankEnabled: config.retrieval.vector.rerankEnabled,
          rerankerModel: configuredValue(config.retrieval.vector.rerankerModel),
        });
      }
    } catch { /* ignore — new workspace or unreadable profile */ }
  }

  createEffect(() => {
    if (props.mode === 'setup') setRoute(props.initialRoute ?? 'main');
    if (props.mode === 'startup') {
      const gap = startupGaps()[0];
      if (gap?.kind === 'llm' || gap?.kind === 'vector') {
        preloadWikirc(currentWorkspaceContext(props.session, gap.context));
      }
      setRoute(startupRoute(gap));
    }
  });

  function startupRoute(gap?: Gap) {
    if (!gap) return 'done';
    if (gap.kind === 'agents') return 'agents';
    if (gap.kind === 'network') return 'network';
    if (gap.kind === 'workspace') return 'workspace-confirm';
    if (gap.kind === 'llm') return 'llm-provider';
    if (gap.kind === 'vector') return 'vector-confirm';
    return 'done';
  }

  function nextStartup(label?: string) {
    if (label) setLogs((items) => [...items, { icon: '✓', label }]);
    setRouteHistory([]);
    if (props.mode !== 'startup') {
      if (props.closeOnDone) {
        props.onComplete();
        return;
      }
      setRoute('main');
      return;
    }
    const next = stepIndex() + 1;
    setStepIndex(next);
    const nextGap = startupGaps()[next];
    if (!nextGap) props.onComplete();
    else {
      if (nextGap.kind === 'llm' || nextGap.kind === 'vector') {
        preloadWikirc(currentWorkspaceContext(props.session, nextGap.context));
      }
      setRoute(startupRoute(nextGap));
    }
  }

  function skipCurrent() {
    const s = step();
    setRouteHistory([]);
    if (props.mode === 'setup') {
      if (props.closeOnDone) {
        props.onClose();
        return;
      }
      if (route() === 'main') props.onClose();
      else setRoute(route().startsWith('workspace:') ? 'workspaces' : 'main');
      return;
    }
    setLogs((items) => [...items, { icon: '->', label: stepTitle(s), detail: 'skipped' }]);
    nextStartup();
  }

  async function runAction(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function navigate(newRoute: string) {
    setRouteHistory((h) => [...h, route()]);
    setRoute(newRoute);
  }

  function jumpTo(newRoute: string) {
    setRouteHistory([]);
    setRoute(newRoute);
  }

  function goBack() {
    const history = routeHistory();
    if (!history.length) { props.onClose(); return; }
    setRouteHistory(history.slice(0, -1));
    setError(null);
    setRoute(history[history.length - 1]);
  }

  async function commitLlmModel(value: string) {
    const context = currentWorkspaceContext(props.session, currentGap()?.context ?? targetWorkspace());
    if (!context?.workspacePath) return setError('No workspace available.');
    await runAction(async () => {
      writeLlmConfig(context.workspacePath, context.profileName ?? 'default', { ...llm(), model: value });
      setLogs((items) => [...items, { icon: '✓', label: 'LLM configured', detail: value }]);
      if (creationFlow()) navigate('vector-confirm');
      else nextStartup();
    });
  }

  async function commitVectorRerank(rerankerModel: string) {
    const context = currentWorkspaceContext(props.session, currentGap()?.context ?? targetWorkspace());
    if (!context?.workspacePath) return setError('No workspace available.');
    await runAction(async () => {
      writeVectorConfig(context.workspacePath, context.profileName ?? 'default', {
        ...vector(),
        rerankEnabled: true,
        rerankerModel,
      });
      setCreationFlow(false);
      nextStartup('Vector search configured');
    });
  }

  async function submitSelect(value: string) {
    const currentRoute = route();
    if (currentRoute === 'main') {
      if (value === 'Close') return props.onClose();
      if (value === 'Agents') return navigate('agents');
      if (value === 'Workspaces') return navigate('workspaces');
      if (value === 'LLM configuration') return navigate('llm-provider');
      if (value === 'Vector search') return navigate('vector-confirm');
      return;
    }
    if (currentRoute === 'workspaces') {
      if (value === 'back') return goBack();
      if (value === 'create') return navigate('workspace-name');
      if (value.startsWith('workspace:')) return navigate(value);
      return;
    }
    if (currentRoute.startsWith('workspace:')) {
      if (value === 'back') return goBack();
      const workspace = listWorkspaces().find((item) => item.name === currentRoute.slice('workspace:'.length));
      setTargetWorkspace(workspace);
      if (value === 'llm') {
        preloadWikirc(currentWorkspaceContext(props.session, targetWorkspace()));
        return navigate('llm-provider');
      }
      if (value === 'vector') {
        preloadWikirc(currentWorkspaceContext(props.session, targetWorkspace()));
        return navigate('vector-confirm');
      }
      if (value === 'rename') return navigate('workspace-rename');
      if (value === 'unregister') return navigate('unregister-confirm');
      if (value === 'delete') return navigate('delete-confirm');
      return;
    }
    if (currentRoute === 'llm-provider') {
      const provider = normalizeProvider(value);
      setLlm((old: any) => ({
        ...old,
        provider,
        // Behind a gateway there is no engine: the endpoint is opaque
        // and each model may have a different one.
        engine: provider === 'ai-gateway' ? null : old.engine,
        baseUrl: old.provider === provider ? old.baseUrl : '',
      }));
      // The gateway always requires a baseUrl, and has no engine to choose.
      if (provider === 'ai-gateway') return navigate('llm-baseurl');
      return navigate('llm-engine');
    }
    if (currentRoute === 'llm-engine') {
      const engine = normalizeEngine(value);
      setLlm((old: any) => {
        const asksForBaseUrl = requiresBaseUrl(old.provider, engine);
        const baseUrl = (old.engine === engine && old.baseUrl)
          ? old.baseUrl
          : asksForBaseUrl ? '' : defaultBaseUrl(old.provider, engine);
        return { ...old, engine, baseUrl, ...(engine === 'ollama' && !old.apiKey ? { apiKey: 'ollama' } : {}) };
      });
      if (requiresBaseUrl(llm().provider, engine)) return navigate('llm-baseurl');
      return navigate('llm-apikey');
    }
    if (currentRoute === 'unregister-confirm') {
      if (value === 'Cancel') return goBack();
      await runAction(async () => {
        await unregisterWorkspace(targetWorkspace()?.name);
        setLogs((items) => [...items, { icon: '✓', label: 'Workspace unregistered', detail: targetWorkspace()?.name }]);
        jumpTo('workspaces');
      });
      return;
    }
    if (currentRoute === 'delete-confirm') {
      if (value === 'Cancel') return goBack();
      await runAction(async () => {
        const deleted = await deleteWorkspaceAndFiles(
          targetWorkspace()?.name,
          targetWorkspace()?.workspacePath,
          { runtimeUrl: props.session?.runtime?.url ?? null },
        );
        setLogs((items) => [...items, { icon: '✓', label: 'Workspace deleted', detail: targetWorkspace()?.name }]);
        // The files are gone either way; a memory purge the runtime could not
        // confirm is a degradation and must be said, not swallowed — a
        // recreated workspace under the same name would inherit the facts.
        if (deleted?.memoryCleanup && deleted.memoryCleanup.removed === false) {
          setLogs((items) => [...items, { icon: '!', label: 'Workspace memory cleanup was not confirmed', detail: deleted.memoryCleanup.error ?? '' }]);
        }
        jumpTo('workspaces');
      });
    }
  }

  async function submitConfirm(yes: boolean) {
    const currentRoute = route();
    if (!yes && currentRoute === 'vector-rerank') {
      const context = currentWorkspaceContext(props.session, currentGap()?.context ?? targetWorkspace());
      if (!context?.workspacePath) return setError('No workspace available.');
      await runAction(async () => {
        writeVectorConfig(context.workspacePath, context.profileName ?? 'default', {
          ...vector(),
          rerankEnabled: false,
        });
        setCreationFlow(false);
        nextStartup('Vector search configured');
      });
      return;
    }
    if (!yes) {
      if (currentRoute === 'vector-confirm') setCreationFlow(false);
      return skipCurrent();
    }
    if (currentRoute === 'agents') {
      await runAction(async () => {
        await startAgents();
        nextStartup('Agents running');
      });
      return;
    }
    if (currentRoute === 'network') {
      await runAction(async () => {
        const result = await checkInternetConnectivity();
        if (!result.ok) throw new Error(result.context?.error ?? 'Internet connectivity check failed.');
        nextStartup('Internet connectivity verified');
      });
      return;
    }
    if (currentRoute === 'workspace-confirm') return navigate('workspace-name');
    if (currentRoute === 'vector-rerank') return navigate('vector-rerank-model');
    if (currentRoute === 'vector-confirm') {
      setVector((old: any) => ({
        ...old,
        provider: old.provider || llm().provider,
        baseUrl: old.baseUrl || llm().baseUrl || defaultBaseUrl(llm().provider, llm().engine),
      }));
      return navigate('vector-baseurl');
    }
  }

  async function submitText() {
    const currentRoute = route();
    const value = input().trim();
    if (currentRoute === 'language') {
      const lang = value.toLowerCase().replace(/[^a-z]/g, '').slice(0, 2);
      if (lang.length < 2) return setError('Please enter a 2-character language code (e.g. fr, en).');
      const context = currentWorkspaceContext(props.session, currentGap()?.context ?? targetWorkspace());
      if (context?.workspacePath) writeLanguageConfig(context.workspacePath, context.profileName ?? 'default', lang);
      // Without this line, the summary kept displaying the language read
      // from the scaffold at workspace creation time (`en`) instead of the
      // one just entered and written.
      setLanguage(lang);
      navigate('llm-provider');
      return;
    }
    if (currentRoute === 'workspace-name') {
      if (!value) return setError('Workspace name is required.');
      await runAction(async () => {
        const created = await createNewWorkspace(value, props.initialWorkspacePath ?? null);
        const workspacePath = created.workspace?.workspacePath ?? defaultWorkspacePath(value);
        const newTarget = { workspaceName: value, workspacePath, profileName: 'default' };
        setTargetWorkspace(newTarget);
        preloadWikirc(newTarget);
        setCreationFlow(true);
        setLogs((items) => [...items, { icon: '✓', label: `Workspace: ${value}` }]);
        navigate('language');
      });
      return;
    }
    if (currentRoute === 'workspace-rename') {
      if (!value) return setError('Workspace name is required.');
      await runAction(async () => {
        const renamed = await renameWorkspace(targetWorkspace()?.name, value);
        setLogs((items) => [...items, { icon: '✓', label: 'Workspace renamed', detail: `${renamed.previousName} -> ${renamed.name}` }]);
        jumpTo('workspaces');
      });
      return;
    }
    if (currentRoute === 'llm-baseurl') {
      if (!value) return setError('Base URL is required.');
      setLlm((old: any) => ({ ...old, baseUrl: value }));
      // Ollama does not require a key: discovery can start right away.
      if (llm().engine === 'ollama') {
        startDiscovery({ ...llm(), baseUrl: value });
        return navigate('llm-model');
      }
      return navigate('llm-apikey');
    }
    if (currentRoute === 'llm-apikey') {
      if (!value) return setError('API key is required.');
      setLlm((old: any) => ({ ...old, apiKey: value }));
      // No `await`: the model step is displayed immediately and the list
      // fills in on its own.
      startDiscovery({ ...llm(), apiKey: value });
      return navigate('llm-model');
    }
    if (currentRoute === 'vector-baseurl') {
      const baseUrl = value || vector().baseUrl || llm().baseUrl;
      if (!baseUrl) return setError('Embeddings/rerank base URL is required.');
      setVector((old: any) => ({
        ...old,
        provider: llm().provider,
        engine: llm().engine,
        baseUrl,
      }));
      return navigate('vector-apikey');
    }
    if (currentRoute === 'vector-apikey') {
      if (vectorBaseUrlDiverged() && !value) {
        return setError(
          'API key is required: the vector base URL differs from the LLM one, so the LLM key is not reused.',
        );
      }
      const apiKey = value || llm().apiKey || undefined;
      if (!apiKey) return setError('API key is required (or set LLM key first).');
      setVector((old: any) => ({ ...old, apiKey }));
      // The catalog shown at the embeddings and rerank steps must come from
      // the vector endpoint, not the LLM: they are two distinct servers as
      // soon as the URL diverges, and offering one's chat models for the
      // other's embeddings makes no sense.
      if (vectorBaseUrlDiverged()) {
        startDiscovery({ ...vector(), apiKey });
      }
      return navigate('vector-model');
    }
    if (currentRoute === 'llm-model') {
      if (!value) return setError('Model name is required.');
      await commitLlmModel(value);
      return;
    }
    if (currentRoute === 'vector-model') {
      if (!value) return setError('Model name is required.');
      setVector((old: any) => ({ ...old, embeddingModel: value }));
      return navigate('vector-rerank');
    }
    if (currentRoute === 'vector-rerank-model') {
      if (!value) return setError('Model name is required.');
      await commitVectorRerank(value);
      return;
    }
  }

  function readClipboard(): string {
    try {
      if (process.platform === 'darwin') return execFileSync('pbpaste', [], { encoding: 'utf8' }).replace(/\n$/, '');
      if (process.platform === 'win32') return execFileSync('powershell', ['-command', 'Get-Clipboard'], { encoding: 'utf8' }).trimEnd();
      try { return execFileSync('wl-paste', ['--no-newline'], { encoding: 'utf8' }); } catch { /**/ }
      return execFileSync('xclip', ['-selection', 'clipboard', '-o'], { encoding: 'utf8' });
    } catch { return ''; }
  }

  // Terminal paste (Cmd+V/middle-click) arrives as a bracketed-paste block.
  // openTUI's key parser swallows the \x1b[200~/\x1b[201~ markers and emits a
  // dedicated `paste` event instead of key events — the text NEVER reaches
  // useKeyboard, so the legacy bracketed-paste branch below can't fire.
  usePaste((event: any) => {
    if (busy() || step().kind !== 'text') return;
    const raw = event?.text
      ?? (event?.bytes != null ? Buffer.from(event.bytes).toString('utf8') : '');
    const pasted = String(raw).replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').join(' ');
    if (pasted) setInput((value) => value + pasted);
  });

  useKeyboard((key: any) => {
    // Discovery deliberately blocks nothing: the model name can be typed
    // and validated before the catalog even arrives.
    if (busy()) return;
    const s = step();
    const keyName = String(key.name ?? '').toLowerCase();
    const sequence = String(key.sequence ?? '');
    const lowerSequence = sequence.toLowerCase();
    const isCopyExit = ((key.ctrl || key.meta) && keyName === 'c') || sequence === '\x03' || (key.meta && lowerSequence === '\x1bc');
    const isPaste = ((key.ctrl || key.meta) && keyName === 'v') || (key.meta && lowerSequence === '\x1bv');
    const isBack = key.ctrl && keyName === 'z';
    const isEnter = keyName === 'return' || keyName === 'enter' || keyName === 'linefeed';
    if (isCopyExit) {
      props.onClose();
      return;
    }
    if (isBack && routeHistory().length > 0) {
      goBack();
      return;
    }
    if (keyName === 'escape') {
      skipCurrent();
      return;
    }
    if (s.kind === 'menu') {
      if (keyName === 'up') setSelected((value) => firstSelectableIndex(s.items, value - 1, -1));
      else if (keyName === 'down') setSelected((value) => firstSelectableIndex(s.items, value + 1, 1));
      else if (isEnter) void submitSelect(s.items[selected()]?.value);
      return;
    }
    if (s.kind === 'select') {
      if (keyName === 'up') setSelected((value) => (value + s.options.length - 1) % s.options.length);
      else if (keyName === 'down') setSelected((value) => (value + 1) % s.options.length);
      else if (isEnter) void submitSelect(s.options[selected()]);
      return;
    }
    if (s.kind === 'confirm') {
      if (keyName === 'up' || keyName === 'down' || keyName === 'tab') setSelected((value) => value === 0 ? 1 : 0);
      else if (isEnter) void submitConfirm(selected() === 0);
      return;
    }
    if (s.kind === 'text') {
      // Bracketed paste: ESC[200~...text...ESC[201~
      if (sequence.startsWith('\x1b[200~')) {
        let pasted = sequence.slice(6);
        const closeIdx = pasted.indexOf('\x1b[201~');
        if (closeIdx !== -1) pasted = pasted.slice(0, closeIdx);
        pasted = pasted.split('\r').join('');
        if (pasted) { setHighlight(-1); setInput((value) => value + pasted); }
        return;
      }
      // Explicit clipboard paste (Ctrl+V or Cmd+V on macOS)
      if (isPaste) {
        const pasted = readClipboard();
        if (pasted) { setHighlight(-1); setInput((value) => value + pasted); }
        return;
      }

      // Catalog navigation. The field remains the truth: the arrows
      // only hover, and validation is required to write into the field.
      const matches = filteredSuggestions().matches;
      if (matches.length > 0 && (keyName === 'down' || keyName === 'up')) {
        setHighlight((value) => {
          if (keyName === 'down') return value + 1 >= matches.length ? -1 : value + 1;
          return value <= -1 ? matches.length - 1 : value - 1;
        });
        return;
      }
      const hovered = highlight() >= 0 ? matches[highlight()] : null;
      // Two deliberate beats: the first Enter drops the hovered model into the
      // field, the second validates the step. One can therefore re-read, correct
      // or complete what was just chosen.
      if (hovered && (isEnter || keyName === 'tab')) {
        setInput(hovered);
        setHighlight(-1);
        return;
      }
      if (isEnter) {
        void submitText();
        return;
      }
      if (keyName === 'backspace') {
        setHighlight(-1);
        setInput((value) => value.slice(0, -1));
        return;
      }
      if (sequence.length >= 1 && !sequence.startsWith('\x1b') && sequence >= ' ') {
        setHighlight(-1);
        setInput((value) => value + sequence);
      }
    }
  });

  const currentItems = () => {
    const s = step();
    if (s.kind === 'menu') return s.items;
    if (s.kind === 'select') return s.options.map((label) => ({ label, value: label }));
    if (s.kind === 'confirm') return [{ label: s.yesLabel, value: 'yes' }, { label: s.noLabel, value: 'no' }];
    return [];
  };

  const displayValue = () => {
    const s = step();
    if (s.kind !== 'text') return '';
    // The empty field shows its hint in grey, whatever the step
    // kind: this is what allows an arbitrary model to no longer be prefilled
    // while still showing what a valid answer looks like.
    return input() || (s.placeholder ?? '');
  };
  const inputHasValue = () => step().kind === 'text' && input().length > 0;

  /**
   * Suggestions filtered by what is typed.
   *
   * A properly filled gateway exposes several hundred models: a raw list is
   * unusable, and a classic select would forbid typing a model absent from the
   * catalog. The text field is therefore kept as the only truth and only a
   * filtered reminder is displayed — which settles all three cases at once:
   * huge list, absent model, unreachable endpoint.
   */
  const SUGGESTION_ROWS = 6;
  const filteredSuggestions = createMemo(() => {
    const current = step() as any;
    const all: string[] = current?.suggestions ?? [];
    if (all.length === 0) {
      return { matches: [] as string[], rows: [] as string[], offset: 0, total: 0, matched: 0 };
    }
    const needle = input().trim().toLowerCase();
    const matches = needle
      ? all.filter((item) => item.toLowerCase().includes(needle))
      : all;

    // Sliding window around the hovered element: without it, only the
    // first entries were reachable and a catalog of 200 models
    // stayed invisible past the sixth line.
    const cursor = highlight();
    const offset =
      cursor < SUGGESTION_ROWS
        ? 0
        : Math.min(cursor - SUGGESTION_ROWS + 1, Math.max(0, matches.length - SUGGESTION_ROWS));
    return {
      matches,
      rows: matches.slice(offset, offset + SUGGESTION_ROWS),
      offset,
      total: all.length,
      matched: matches.length,
    };
  });
  const lineWidth = () => Math.max(10, dialogWidth() - 10);
  const displayLine1 = () => displayValue().slice(0, lineWidth());
  const displayLine2 = () => displayValue().slice(lineWidth(), lineWidth() * 2);
  const displayLine3 = () => displayValue().slice(lineWidth() * 2);
  const showLine2 = () => displayValue().length > lineWidth();
  const showLine3 = () => displayValue().length > lineWidth() * 2;
  const contextPath = () => targetWorkspace()?.workspacePath ?? (currentGap()?.context?.workspacePath ?? null);

  /**
   * Bottom-of-frame summary, in `label  value` lines.
   *
   * It used to be concatenated into a single line, cut off from the second field
   * on: the workspace path ate the room, and the URL — the information just
   * entered — never appeared in full.
   */
  const CONTEXT_LABEL_WIDTH = 11;
  const contextLines = createMemo(() => {
    const rows: Array<[string, string]> = [];
    const workspacePath = targetWorkspace()?.workspacePath ?? currentGap()?.context?.workspacePath ?? null;
    if (workspacePath) {
      rows.push(['Workspace', language() ? `${workspacePath}  ·  lang ${language()}` : workspacePath]);
    }
    // Three lines at most, and only those of the current phase: this
    // summary must never push the frame footer out of the box.
    if (route().startsWith('vector-')) {
      const vectorUrl = vector().baseUrl || llm().baseUrl;
      if (vectorUrl) rows.push(['Vector', vectorUrl]);
      if (vector().embeddingModel) rows.push(['Embedding', vector().embeddingModel]);
    } else {
      const routing = [llm().provider, llm().engine].filter(Boolean).join('  ·  ');
      if (routing) rows.push(['Routing', routing]);
      if (llm().baseUrl) {
        rows.push(['Endpoint', llm().apiKey ? `${llm().baseUrl}  ·  key set` : llm().baseUrl]);
      }
    }

    const width = textWidth() - CONTEXT_LABEL_WIDTH;
    const lines: string[] = [];
    for (const [label, value] of rows.slice(0, 3)) {
      wrapText(value, width, 2).forEach((line, index) => {
        lines.push(`${(index === 0 ? label : '').padEnd(CONTEXT_LABEL_WIDTH)}${line}`);
      });
    }
    return lines;
  });

  return (
    <box
      position="absolute"
      left={left()}
      top={top()}
      width={dialogWidth()}
      height={dialogHeight()}
      zIndex={40}
      border
      borderStyle="rounded"
      borderColor="#8BD5CA"
      backgroundColor="#111318"
      padding={1}
      flexDirection="column"
      overflow="hidden"
    >
      <Show when={logs().length > 0}>
        <For each={logs().slice(-3)}>
          {(entry) => <text height={1} fg={entry.icon === '✓' ? '#8BD5CA' : '#9CA3AF'}>{entry.icon} {entry.label}{entry.detail ? ` - ${entry.detail}` : ''}</text>}
        </For>
        <text height={1}>{''}</text>
      </Show>

      {/* Header: phase on the left, progress within the phase on the right. */}
      <box height={1} flexDirection="row">
        <text fg="#8BD5CA">{stepTitle(step())}</text>
        <box flexGrow={1} />
        <text fg="#4B5563">{busy() ? 'working…' : progressLabel()}</text>
      </box>
      <text height={1} fg="#2A3441">{'─'.repeat(textWidth())}</text>
      <text height={1}>{''}</text>

      <Show when={(step() as any).message || (step() as any).label}>
        <For each={wrapText((step() as any).message ?? (step() as any).label, textWidth(), 5)}>
          {(line) => <text height={1} fg="#D6DEE8">{line}</text>}
        </For>
      </Show>
      <Show when={(step() as any).note}>
        <For each={wrapText((step() as any).note, textWidth(), 4)}>
          {(line) => <text height={1} fg="#9CA3AF">{line}</text>}
        </For>
      </Show>
      <text height={1}>{''}</text>

      <Show when={step().kind === 'text'}>
        <box
          height={5}
          border
          borderStyle="single"
          borderColor="#8BD5CA"
          backgroundColor="#0B1220"
          padding={1}
          flexDirection="column"
          overflow="hidden"
        >
          <box flexDirection="row" height={1}>
            <text fg="#8BD5CA">{'> '}</text>
            <text fg={inputHasValue() ? '#D6DEE8' : '#7F8C8D'}>{displayLine1()}</text>
            <Show when={!showLine2()}>
              <text fg="#111318" bg="#8BD5CA"> </text>
            </Show>
          </box>
          <box flexDirection="row" height={1}>
            <text fg="#8BD5CA">{'  '}</text>
            <text fg={inputHasValue() ? '#D6DEE8' : '#7F8C8D'}>{displayLine2()}</text>
            <Show when={showLine2() && !showLine3()}>
              <text fg="#111318" bg="#8BD5CA"> </text>
            </Show>
          </box>
          <box flexDirection="row" height={1}>
            <text fg="#8BD5CA">{'  '}</text>
            <text fg={inputHasValue() ? '#D6DEE8' : '#7F8C8D'}>{displayLine3()}</text>
            <Show when={showLine3()}>
              <text fg="#111318" bg="#8BD5CA"> </text>
            </Show>
          </box>
        </box>
      </Show>
      <Show when={step().kind === 'text' && filteredSuggestions().total > 0}>
        <text height={1}>{''}</text>
        <For
          each={wrapText(
            filteredSuggestions().matched === 0
              ? `No match among ${filteredSuggestions().total} model(s) — the typed value is used as-is.`
              : `${filteredSuggestions().matched} of ${filteredSuggestions().total} model(s) — ↑↓ to browse, Enter picks, the typed value wins.`,
            textWidth(),
            2,
          )}
        >
          {(line) => <text height={1} fg="#7F8C8D">{line}</text>}
        </For>
        <For each={filteredSuggestions().rows}>
          {(suggestion, index) => {
            const position = () => filteredSuggestions().offset + index();
            const hovered = () => position() === highlight();
            const chosen = () => suggestion === input().trim();
            return (
              <text
                height={1}
                fg={hovered() ? '#111318' : chosen() ? '#8BD5CA' : '#9CA3AF'}
                bg={hovered() ? '#8BD5CA' : '#111318'}
              >
                {`${hovered() ? ' > ' : chosen() ? ' ● ' : ' · '}${suggestion}`.slice(0, textWidth())}
              </text>
            );
          }}
        </For>
        <Show when={filteredSuggestions().matched > filteredSuggestions().rows.length}>
          <text height={1} fg="#7F8C8D">
            {`   … ${filteredSuggestions().matched - filteredSuggestions().rows.length} more (↑↓ to scroll)`}
          </text>
        </Show>
      </Show>
      <Show when={step().kind !== 'text'}>
        <For each={currentItems()}>
          {(item, index) => (
            <text
              height={1}
              fg={(item as any).muted ? '#4B5563' : index() === selected() ? '#111318' : '#D6DEE8'}
              bg={index() === selected() && !(item as any).muted ? '#8BD5CA' : '#111318'}
            >
              {(item as any).muted ? '  ───' : `${index() === selected() ? '> ' : '  '}${item.label}`}
            </text>
          )}
        </For>
      </Show>

      {/* Discovery status: occupies the free space left in the middle. */}
      <Show when={showDiscoveryPanel() && discoveryLines().length > 0}>
        <text height={1}>{''}</text>
        <For each={discoveryLines()}>
          {(row) => <text height={1} fg={row.fg}>{row.text}</text>}
        </For>
      </Show>

      <Show when={error()}>
        {(message) => (
          <>
            <text height={1}>{''}</text>
            <For each={wrapText(message(), textWidth(), 5)}>
              {(line) => <text height={1} fg="#F87171">{line}</text>}
            </For>
          </>
        )}
      </Show>

      <box flexGrow={1} />
      <Show when={contextLines().length > 0}>
        <text height={1} fg="#2A3441">{'─'.repeat(textWidth())}</text>
        <For each={contextLines()}>
          {(line) => <text height={1} fg="#4B5563">{line}</text>}
        </For>
      </Show>
      <text height={1}>{''}</text>
      <box height={1} flexDirection="row">
        <text fg="#7F8C8D">
          {step().kind !== 'text'
            ? '↑↓  Move    Enter  Select    Esc  Skip'
            : filteredSuggestions().matched > 0
              ? '↑↓  Browse    Enter  Pick / Confirm    Esc  Skip'
              : 'Enter  Confirm    Esc  Skip'}
        </text>
        <box flexGrow={1} />
        <Show when={routeHistory().length > 0}>
          <text fg="#7F8C8D">Ctrl+Z  Back</text>
        </Show>
      </box>
    </box>
  );
}
