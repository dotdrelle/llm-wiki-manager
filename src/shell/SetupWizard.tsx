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
       * Catalogue découvert. Purement indicatif : le champ texte fait foi, ce
       * qui garde l'étape utilisable quand l'endpoint est injoignable ou quand
       * le modèle voulu n'y figure pas.
       */
      suggestions?: string[];
      /** Valeur configurée écartée parce qu'absente du catalogue découvert. */
      stale?: string | null;
    }
  | { kind: 'done' };
type LogEntry = { icon: string; label: string; detail?: string };

// Deux axes, deux questions. `provider` dit où l'on tape, `engine` dit
// comment se comporte le serveur en face. Les fusionner était précisément ce
// qui empêchait de décrire une gateway.
const PROVIDERS = [
  'Direct server (OpenAI-compatible)',
  'AI gateway (LiteLLM, Bifrost, Portkey…)',
];
const ENGINE_OPTIONS = [
  'OpenAI',
  'Anthropic',
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

// Les défauts et la question « faut-il demander une baseUrl ? » vivent dans
// core/modelFetch.js, source unique partagée avec la découverte.
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
 * Partie « champ » d'une étape modèle : préremplissage, indication, catalogue.
 *
 * Le préremplissage ne reprend que ce qui est *déjà configuré*. Choisir pour
 * l'opérateur le premier modèle découvert le filtrait aussitôt sur lui-même —
 * la liste n'affichait plus qu'une entrée sur dix — et proposait une réponse
 * qui n'avait aucune raison d'être la bonne. Quand rien n'est configuré, le
 * champ reste vide et c'est l'indication grisée qui montre la forme attendue.
 */
function suggestionField(discovered: string[], configured?: string | null, example = '') {
  // Un modèle absent du catalogue ne doit pas être préremplí : il filtrerait
  // la liste sur zéro résultat, et l'écran afficherait « No match » devant dix
  // modèles disponibles. C'est exactement le cas du `BAAI/bge-m3` du scaffold
  // face à un serveur qui nomme le même modèle autrement.
  const usable = configured && (discovered.length === 0 || discovered.includes(configured))
    ? configured
    : null;
  return {
    // Sans catalogue il n'y a pas de liste à masquer : l'exemple redevient un
    // préremplissage utile plutôt qu'un choix imposé.
    prefill: usable ?? (discovered.length === 0 ? example : ''),
    placeholder: discovered.length > 0 ? '↑↓ to browse the list, or type a name' : example,
    suggestions: discovered,
    /** Rappel affiché quand la valeur configurée a été écartée. */
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
   * Entrée survolée dans la liste des modèles, `-1` quand on tape librement.
   *
   * La liste n'était qu'un rappel : impossible d'y naviguer, donc le wizard
   * préremplissait le premier modèle découvert pour qu'il y ait au moins une
   * réponse. Ce préremplissage filtrait la liste sur lui-même — on ne voyait
   * plus qu'un modèle sur dix, et rarement le bon.
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
  // Le dialogue occupe désormais l'essentiel du terminal. Les libellés, notes
  // et causes d'erreur sont des phrases, pas des étiquettes : à 72 colonnes et
  // 30 lignes elles débordaient, alors que la moitié basse du cadre restait
  // vide.
  const dialogWidth = () => Math.max(50, Math.min(110, Math.floor(props.width * 0.86)));
  const dialogHeight = () => Math.max(24, Math.min(40, Math.floor(props.height * 0.86)));
  /** Largeur utile : bordure (1) + padding (1) de chaque côté. */
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
        // L'exemple vit dans l'indication du champ et dans la liste découverte ;
        // le répéter dans le libellé en faisait la ligne la plus longue de
        // l'écran, pour une information déjà visible deux fois.
        label: 'Chat model',
        note: 'Required: an agentic model with tool/function calling support.',
        // Préremplir avec le premier modèle découvert filtrait la liste sur
        // lui-même : neuf modèles sur dix devenaient invisibles, et la réponse
        // proposée était arbitraire. Seul un modèle déjà configuré est repris.
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
      // L'héritage n'est proposé que tant que l'URL n'a pas divergé : sinon la
      // clé du LLM — celle de la gateway, qui ouvre tous les providers —
      // partirait vers un autre hôte.
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
    // La question de routage est reposée à chaque passage — c'est plus simple
    // et plus honnête que de la mémoriser dans un champ dédié. On se contente
    // de présélectionner ce que le wikirc déclare déjà.
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
   * Catalogue découvert auprès du serveur ou de la gateway. Il ne sert qu'à
   * préremplir : le champ texte reste la vérité, ce qui garde le wizard
   * utilisable quand l'endpoint est injoignable ou quand le modèle voulu n'y
   * figure pas.
   */
  const [catalog, setCatalog] = createSignal<any>(null);
  const [catalogError, setCatalogError] = createSignal<string | null>(null);
  /** URL interrogée pendant que la découverte est en vol, sinon `null`. */
  const [discovering, setDiscovering] = createSignal<string | null>(null);
  /**
   * Numéro de la découverte en cours.
   *
   * La découverte ne bloque plus l'étape suivante : une réponse tardive peut
   * donc revenir alors que l'opérateur a déjà corrigé l'URL ou la clé et
   * relancé une découverte. Sans ce compteur, la vieille réponse écraserait la
   * neuve.
   */
  let discoveryRun = 0;

  /**
   * Lance la découverte **sans l'attendre**.
   *
   * C'était la vraie cause du gel : la saisie de la clé partait dans un
   * `await` muet, et l'écran suivant n'apparaissait qu'une fois le réseau
   * retombé. Un catalogue n'est pourtant que du préremplissage — le champ
   * texte fait foi. L'étape s'affiche donc tout de suite, et la liste se
   * remplit quand elle arrive.
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
    // Un serveur direct expose un seul catalogue, non typé : interroger chat
    // puis embeddings tapait deux fois la même URL avec les mêmes en-têtes,
    // pour la même réponse — et payait deux fois le délai.
    const promise = isGateway
      ? fetchGatewayCatalog(baseUrl, apiKey, {
          // La liste plate arrive la première et suffit à choisir : elle est
          // affichée tout de suite, puis remplacée par le catalogue typé
          // pendant que l'opérateur lit ses options.
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
   * Bloc d'état de la découverte, rendu sous le champ de saisie.
   *
   * Il occupe la place laissée libre au milieu du dialogue, là où il n'y avait
   * rien : ce qui est tenté, contre quelle URL, avec quel transport, et ce que
   * ça a donné.
   */
  const discoveryLines = createMemo<Array<{ text: string; fg: string }>>(() => {
    const width = textWidth();
    const rows: Array<{ text: string; fg: string }> = [];
    // L'indentation est appliquée à chaque ligne : `wrapText` normalise les
    // espaces, un préfixe passé dans le texte serait perdu sur la première.
    const indent = '  ';
    const push = (text: string, fg: string, maxLines = 3) => {
      for (const line of wrapText(text, width - indent.length, maxLines)) {
        rows.push({ text: `${indent}${line}`, fg });
      }
    };
    const pending = discovering();
    const partial = catalog();
    if (pending && partial) {
      // La liste plate est déjà utilisable ; seul le typage manque encore.
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

  /** Étapes de découverte : le bloc d'état n'a de sens que là. */
  const DISCOVERY_ROUTES = new Set(['llm-apikey', 'llm-model', 'vector-model', 'vector-rerank-model']);
  const showDiscoveryPanel = () => discovering() !== null || DISCOVERY_ROUTES.has(route());

  /**
   * Position dans la phase courante, affichée en haut à droite.
   *
   * La séquence est reconstruite depuis les choix déjà faits, parce qu'elle
   * est réellement variable : une gateway saute la question du moteur, un
   * moteur hébergé saute l'URL, Ollama saute la clé. Annoncer un total fixe
   * serait faux.
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

  /** Vrai quand l'URL vecteur ne pointe plus le même hôte que le LLM. */
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
          // Un wikirc pré-0.16 porte le moteur dans `provider`
          // (`ollama`, `anthropic`, `openai`). Sans cette déduction, l'étape
          // moteur ne présélectionne rien et propose OpenAI en tête — au
          // risque d'écraser une configuration qui marchait.
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
          // Les noms de modèles étaient les deux seuls champs à échapper au
          // filtre : le `BAAI/bge-m3` du scaffold arrivait donc dans le wizard
          // comme une réponse choisie, et servait de filtre sur un catalogue
          // qui nomme le même modèle autrement.
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
        // Derrière une gateway il n'y a pas de moteur : l'endpoint est opaque
        // et chaque modèle peut en avoir un différent.
        engine: provider === 'ai-gateway' ? null : old.engine,
        baseUrl: old.provider === provider ? old.baseUrl : '',
      }));
      // La gateway exige toujours une baseUrl, et n'a pas de moteur à choisir.
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
        await deleteWorkspaceAndFiles(targetWorkspace()?.name, targetWorkspace()?.workspacePath);
        setLogs((items) => [...items, { icon: '✓', label: 'Workspace deleted', detail: targetWorkspace()?.name }]);
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
      // Sans cette ligne, le récapitulatif continuait d'afficher la langue lue
      // dans le scaffold au moment de la création du workspace (`en`) au lieu
      // de celle qui vient d'être saisie et écrite.
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
      // Ollama n'exige pas de clé : on peut découvrir tout de suite.
      if (llm().engine === 'ollama') {
        startDiscovery({ ...llm(), baseUrl: value });
        return navigate('llm-model');
      }
      return navigate('llm-apikey');
    }
    if (currentRoute === 'llm-apikey') {
      if (!value) return setError('API key is required.');
      setLlm((old: any) => ({ ...old, apiKey: value }));
      // Pas de `await` : l'étape modèle s'affiche immédiatement et la liste
      // s'y remplit toute seule.
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
      // Le catalogue affiché aux étapes embeddings et rerank doit venir de
      // l'endpoint vecteur, pas du LLM : ce sont deux serveurs distincts dès
      // que l'URL diverge, et proposer les modèles de chat de l'un pour les
      // embeddings de l'autre n'a aucun sens.
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
    // La découverte ne bloque volontairement rien : on peut taper le nom du
    // modèle et valider avant même que le catalogue n'arrive.
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

      // Navigation dans le catalogue. Le champ reste la vérité : les flèches
      // ne font que survoler, et il faut valider pour écrire dans le champ.
      const matches = filteredSuggestions().matches;
      if (matches.length > 0 && (keyName === 'down' || keyName === 'up')) {
        setHighlight((value) => {
          if (keyName === 'down') return value + 1 >= matches.length ? -1 : value + 1;
          return value <= -1 ? matches.length - 1 : value - 1;
        });
        return;
      }
      const hovered = highlight() >= 0 ? matches[highlight()] : null;
      // Deux temps voulus : le premier Enter dépose le modèle survolé dans le
      // champ, le second valide l'étape. On peut donc relire, corriger ou
      // compléter ce qu'on vient de choisir.
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
    // Le champ vide affiche son indication en grisé, quel que soit le type
    // d'étape : c'est ce qui permet de ne plus préremplir un modèle arbitraire
    // tout en montrant à quoi ressemble une réponse valable.
    return input() || (s.placeholder ?? '');
  };
  const inputHasValue = () => step().kind === 'text' && input().length > 0;

  /**
   * Suggestions filtrées par ce qui est tapé.
   *
   * Une gateway correctement remplie expose plusieurs centaines de modèles :
   * une liste brute est inutilisable, et un select classique interdirait de
   * saisir un modèle absent du catalogue. On garde donc le champ texte comme
   * seule vérité et on n'affiche qu'un rappel filtré — ce qui règle d'un coup
   * les trois cas : liste énorme, modèle absent, endpoint injoignable.
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

    // Fenêtre glissante autour de l'élément survolé : sans elle, seules les
    // premières entrées étaient atteignables et un catalogue de 200 modèles
    // restait invisible au delà de la sixième ligne.
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
   * Récapitulatif de bas de cadre, en lignes `étiquette  valeur`.
   *
   * Il était concaténé en une seule ligne, coupée net dès le deuxième champ :
   * le chemin du workspace mangeait la place, et l'URL — l'information qu'on
   * vient justement de saisir — n'apparaissait jamais en entier.
   */
  const CONTEXT_LABEL_WIDTH = 11;
  const contextLines = createMemo(() => {
    const rows: Array<[string, string]> = [];
    const workspacePath = targetWorkspace()?.workspacePath ?? currentGap()?.context?.workspacePath ?? null;
    if (workspacePath) {
      rows.push(['Workspace', language() ? `${workspacePath}  ·  lang ${language()}` : workspacePath]);
    }
    // Trois lignes au plus, et seulement celles de la phase en cours : ce
    // récapitulatif ne doit jamais pousser le pied de cadre hors de la boîte.
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

      {/* En-tête : phase à gauche, progression dans la phase à droite. */}
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

      {/* État de la découverte : occupe l'espace laissé libre au milieu. */}
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
