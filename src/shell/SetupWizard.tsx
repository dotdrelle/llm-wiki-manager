/** @jsxImportSource @opentui/solid */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { useKeyboard, usePaste } from '@opentui/solid';
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { fallbackModels, normalizeProvider } from '../core/modelFetch.js';
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

type Gap = { kind: 'agents' | 'workspace' | 'llm' | 'vector'; context?: Record<string, any> };
type Mode = 'startup' | 'setup';
type Step =
  | { kind: 'menu'; title: string; items: Array<{ label: string; value: string; muted?: boolean }> }
  | { kind: 'confirm'; title: string; message: string; yesLabel: string; noLabel: string }
  | { kind: 'select'; title: string; label: string; options: string[]; note?: string }
  | { kind: 'text'; title: string; label: string; note?: string; placeholder?: string; prefill?: string; secret?: boolean }
  | { kind: 'done' };
type LogEntry = { icon: string; label: string; detail?: string };

const PROVIDERS = ['OpenAI', 'Anthropic', 'Ollama (local)', 'Other (OpenAI-compatible)'];
const PLACEHOLDER_MODEL_RE = /YOUR_|<your/i;
const MAIN_MENU = ['Agents', 'Workspaces', 'LLM configuration', 'Vector search', '---', 'Close'];

function defaultBaseUrl(provider: string) {
  if (provider === 'ollama') return 'http://localhost:11434';
  if (provider === 'anthropic') return 'https://api.anthropic.com';
  if (provider === 'openai') return 'https://api.openai.com';
  if (provider === 'openai-compatible') return 'http://localhost:8000';
  return '';
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
  const dialogWidth = () => Math.max(44, Math.min(72, Math.floor(props.width * 0.72)));
  const dialogHeight = () => Math.max(22, Math.min(30, Math.floor(props.height * 0.72)));
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
          ? `${context.configError} Select a provider after creating or fixing the config:`
          : `No LLM configured${context?.workspaceName ? ` for ${context.workspaceName}` : ''}. Select a provider:`,
        options: PROVIDERS,
      };
    }
    if (currentRoute === 'llm-baseurl') {
      const example = defaultBaseUrl(llm().provider);
      return {
        kind: 'text',
        title: 'LLM configuration',
        label: `Base URL${example ? ` (example: ${example})` : ''}`,
        prefill: llm().baseUrl || '',
      };
    }
    if (currentRoute === 'llm-apikey') {
      return { kind: 'text', title: 'LLM configuration', label: 'API key (required)', secret: true };
    }
    if (currentRoute === 'llm-model') {
      const example = fallbackModels(llm().provider)[0] || 'provider-agentic-model';
      return {
        kind: 'text',
        title: 'LLM configuration',
        label: `Model (example: ${example})`,
        note: 'Required: an agentic model with tool/function calling support.',
        prefill: llm().model || '',
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
      const hint = llm().apiKey ? '(leave empty to reuse LLM key)' : undefined;
      return { kind: 'text', title: 'Vector search', label: 'Vector API key', placeholder: hint, secret: true };
    }
    if (currentRoute === 'vector-model') {
      const defaultEmbedding = vector().embeddingModel || fallbackModels(vector().provider || llm().provider, 'embedding')[0] || '';
      return { kind: 'text', title: 'Vector search', label: 'Embedding model', prefill: defaultEmbedding };
    }
    if (currentRoute === 'vector-rerank') {
      return { kind: 'confirm', title: 'Vector search', message: 'Enable reranking?', yesLabel: 'Enable', noLabel: 'Skip' };
    }
    if (currentRoute === 'vector-rerank-model') {
      const defaultReranker = vector().rerankerModel || 'BAAI/bge-reranker-v2-m3';
      return { kind: 'text', title: 'Vector search', label: 'Rerank model', prefill: defaultReranker };
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
    const items = (s as any).items ?? (s as any).options?.map((label: string) => ({ label })) ?? [{ label: 'x' }];
    let preferred = -1;
    if (route() === 'llm-provider' && llm().provider) {
      preferred = PROVIDERS.findIndex((p) => normalizeProvider(p) === normalizeProvider(llm().provider));
    }
    setSelected(preferred >= 0 ? preferred : firstSelectableIndex(items));
  });

  function preloadWikirc(context: any) {
    const workspacePath = context?.workspacePath;
    if (!workspacePath) return;
    try {
      const { config } = loadWikircProfile(workspacePath, context?.profileName ?? 'default');
      if (config?.language) setLanguage(String(config.language));
      if (config?.llm?.provider) {
        const model = config.llm.model;
        setLlm({
          provider: normalizeProvider(config.llm.provider),
          baseUrl: config.llm.baseUrl,
          apiKey: config.llm.apiKey,
          model: (model && !PLACEHOLDER_MODEL_RE.test(model)) ? model : null,
        });
      }
      if (config?.retrieval?.vector) {
        setVector({
          provider: config.retrieval.vector.provider,
          baseUrl: config.retrieval.vector.baseUrl,
          apiKey: config.retrieval.vector.apiKey,
          embeddingModel: config.retrieval.vector.embeddingModel,
          rerankEnabled: config.retrieval.vector.rerankEnabled,
          rerankerModel: config.retrieval.vector.rerankerModel,
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
      setLlm((old: any) => {
        const asksForBaseUrl = provider === 'ollama' || provider === 'openai-compatible';
        const baseUrl = (old.provider === provider && old.baseUrl)
          ? old.baseUrl
          : asksForBaseUrl ? '' : defaultBaseUrl(provider);
        return { ...old, provider, baseUrl, ...(provider === 'ollama' && !old.apiKey ? { apiKey: 'ollama' } : {}) };
      });
      if (provider === 'ollama' || provider === 'openai-compatible') return navigate('llm-baseurl');
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
    if (currentRoute === 'workspace-confirm') return navigate('workspace-name');
    if (currentRoute === 'vector-rerank') return navigate('vector-rerank-model');
    if (currentRoute === 'vector-confirm') {
      setVector((old: any) => ({
        ...old,
        provider: old.provider || llm().provider,
        baseUrl: old.baseUrl || llm().baseUrl || defaultBaseUrl(llm().provider),
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
      if (llm().provider === 'ollama') return navigate('llm-model');
      return navigate('llm-apikey');
    }
    if (currentRoute === 'llm-apikey') {
      if (!value) return setError('API key is required.');
      setLlm((old: any) => ({ ...old, apiKey: value }));
      return navigate('llm-model');
    }
    if (currentRoute === 'vector-baseurl') {
      const baseUrl = value || vector().baseUrl || llm().baseUrl;
      if (!baseUrl) return setError('Embeddings/rerank base URL is required.');
      setVector((old: any) => ({ ...old, provider: llm().provider, baseUrl }));
      return navigate('vector-apikey');
    }
    if (currentRoute === 'vector-apikey') {
      const apiKey = value || llm().apiKey || undefined;
      if (!apiKey) return setError('API key is required (or set LLM key first).');
      setVector((old: any) => ({ ...old, apiKey }));
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
        if (pasted) setInput((value) => value + pasted);
        return;
      }
      // Explicit clipboard paste (Ctrl+V or Cmd+V on macOS)
      if (isPaste) {
        const pasted = readClipboard();
        if (pasted) setInput((value) => value + pasted);
        return;
      }
      if (isEnter) {
        void submitText();
        return;
      }
      if (keyName === 'backspace') {
        setInput((value) => value.slice(0, -1));
        return;
      }
      if (sequence.length >= 1 && !sequence.startsWith('\x1b') && sequence >= ' ') {
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
    const value = input();
    return value || (s.secret ? (s.placeholder ?? '') : '');
  };
  const inputHasValue = () => step().kind === 'text' && input().length > 0;
  const lineWidth = () => Math.max(10, dialogWidth() - 10);
  const displayLine1 = () => displayValue().slice(0, lineWidth());
  const displayLine2 = () => displayValue().slice(lineWidth(), lineWidth() * 2);
  const displayLine3 = () => displayValue().slice(lineWidth() * 2);
  const showLine2 = () => displayValue().length > lineWidth();
  const showLine3 = () => displayValue().length > lineWidth() * 2;
  const contextPath = () => targetWorkspace()?.workspacePath ?? (currentGap()?.context?.workspacePath ?? null);

  const contextSummary = createMemo(() => {
    const parts: string[] = [];
    const wp = targetWorkspace()?.workspacePath ?? (currentGap()?.context?.workspacePath ?? null);
    if (wp) parts.push(wp);
    if (language()) parts.push(`lang:${language()}`);
    const p = llm().provider;
    if (p) parts.push(p);
    if (llm().baseUrl) parts.push(llm().baseUrl);
    if (llm().apiKey) parts.push('key:***');
    const model = llm().model;
    if (model) parts.push(model);
    if (vector().baseUrl && vector().baseUrl !== llm().baseUrl) parts.push(`vec:${vector().baseUrl}`);
    if (vector().embeddingModel) parts.push(vector().embeddingModel);
    return parts.join('  ');
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
      <For each={logs().slice(-4)}>
        {(entry) => <text height={1} fg={entry.icon === '✓' ? '#8BD5CA' : '#9CA3AF'}>{entry.icon} {entry.label}{entry.detail ? ` - ${entry.detail}` : ''}</text>}
      </For>
      <text height={1} fg="#FBBF24">{busy() ? `${stepTitle(step())} - working...` : stepTitle(step())}</text>
      <text height={1}>{''}</text>
      <Show when={(step() as any).message || (step() as any).label}>
        <text height={1} fg="#D6DEE8">{(step() as any).message ?? (step() as any).label}</text>
      </Show>
      <Show when={(step() as any).note}>
        <text height={1} fg="#9CA3AF">{(step() as any).note}</text>
      </Show>
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
      <Show when={step().kind !== 'text'}>
        <For each={currentItems()}>
          {(item, index) => (
            <text
              height={1}
              fg={(item as any).muted ? '#4B5563' : index() === selected() ? '#111318' : '#D6DEE8'}
              bg={index() === selected() && !(item as any).muted ? '#8BD5CA' : '#111318'}
            >
              {(item as any).muted ? '  ---' : `${index() === selected() ? '> ' : '  '}${item.label}`}
            </text>
          )}
        </For>
      </Show>

      <Show when={error()}>
        {(message) => <text height={6} fg="#F87171">{message()}</text>}
      </Show>
      <box flexGrow={1} />
      <Show when={contextSummary()}>
        <text height={1} fg="#374151">{contextSummary()}</text>
      </Show>
      <text height={1}>{''}</text>
      <box height={1} flexDirection="row">
        <text fg="#7F8C8D">{step().kind === 'text' ? 'Enter Confirm   Esc Skip' : 'Up/Down   Enter Select   Esc Skip'}</text>
        <box flexGrow={1} />
        <Show when={routeHistory().length > 0}>
          <text fg="#7F8C8D">Ctrl+Z ←</text>
        </Show>
      </box>
    </box>
  );
}
