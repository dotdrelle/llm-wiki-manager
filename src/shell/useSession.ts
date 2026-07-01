import { writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createMemo, createSignal, onCleanup } from 'solid-js';
import { formatMcpToolResult, callMcpTool } from '../core/mcp.js';
import { extractActivity, parseJsonText, sessionActivities } from '../core/activity.js';
import { formatPlanStatus, formatCompletedActivities } from '../core/plan.js';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { projectQueue, queueCounts, startNextQueuedJob, syncQueueWithActivity } from '../core/jobQueue.js';
import { queueStoreFor } from '../core/queueStore.js';
import { fetchRuntimeState, streamRuntimeEvents } from '../runtime/client.js';
import type { ActiveFileEditor } from './FileEditorDialog';
import {
  completionContext,
  completionDescription,
  conversationMessages,
  createSession,
} from './repl.js';
import { useAgent } from './useAgent';

function runtimeStatusText(status: 'disabled' | 'connected' | 'disconnected', runStatus: string): string {
  if (status === 'connected') return `runtime ${runStatus}`;
  if (status === 'disconnected') return 'runtime offline';
  return 'runtime off';
}

function nonEmptyRuntimeArray<T>(value: T[] | undefined | null): T[] | null {
  return Array.isArray(value) && value.length > 0 ? value : null;
}

function buildContinuationPrompt(session: any, completed: any[]): string {
  const originalTask = [...conversationMessages(session)]
    .reverse()
    .find((message: any) => message.role === 'user'
      && !String(message.content ?? '').startsWith('Completed activities:')
      && !String(message.content ?? '').startsWith('Original task:'))?.content;
  return [
    originalTask ? `Original task:\n${originalTask}\n` : null,
    'Completed activities:',
    formatCompletedActivities(completed) || '(none)',
    session.headlessPlan ? `\nPlan status:\n${formatPlanStatus(session.headlessPlan)}` : null,
    '\nContinue the plan. Start the next pending step only.',
    'If all steps are complete, provide a final summary.',
  ].filter(Boolean).join('\n');
}

export function useSession(props: { agent: unknown; packageJson: Record<string, unknown>; runtime?: any }) {
  const session = createSession();
  const [version, setVersion] = createSignal(0);
  const [logs, setLogs] = createSignal<string[]>([]);
  const [runtimeState, setRuntimeState] = createSignal<any | null>(null);
  const [runtimeStatus, setRuntimeStatus] = createSignal<'disabled' | 'connected' | 'disconnected'>(props.runtime ? 'disconnected' : 'disabled');
  const [input, setInput] = createSignal('');
  const [chatMode, setChatMode] = createSignal(true);
  (session as any).chatMode = true;
  const [dismissedSlashInput, setDismissedSlashInput] = createSignal<string | null>(null);
  const [history, setHistory] = createSignal<string[]>([]);
  const [historyIndex, setHistoryIndex] = createSignal<number | null>(null);
  const [selectedCompletion, setSelectedCompletion] = createSignal(0);
  const [conversationScroll, setConversationScroll] = createSignal(0);
  const [showWelcome, setShowWelcome] = createSignal(true);
  const [activeEditor, setActiveEditor] = createSignal<ActiveFileEditor | null>(null);
  const [rightTab, setRightTab] = createSignal<'plan' | 'queue'>('plan');
  const pollBusy = new Set<string>();
  const matchedActivityKeys = new Set<string>();
  const lastActivityLines = new Map<string, string>();
  const lastActivityDetails = new Map<string, string>();

  const refresh = () => setVersion((value) => value + 1);
  (session as any)._onPlanUpdate = refresh;
  (session as any)._onOpenEditor = (editor: ActiveFileEditor) => {
    setShowWelcome(false);
    setActiveEditor(editor);
  };
  const addLog = (line: string) => {
    setLogs((items) => [...items, `${new Date().toLocaleTimeString()} ${line}`].slice(-200));
  };
  if (props.runtime?.url) addLog(`runtime: connected ${props.runtime.url}${props.runtime.started ? ' (started)' : ''}`);
  const agent = useAgent({
    agent: props.agent,
    packageJson: props.packageJson,
    session,
    chatMode,
    runtimeUrl: props.runtime?.url ?? null,
    refresh,
    addLog,
    onRuntimeAccepted: () => {
      setRuntimeState((state) => ({ ...(state ?? {}), status: 'running' }));
      setRuntimeStatus('connected');
      refresh();
    },
  });
  const runtimeRunStatus = createMemo(() => String(runtimeState()?.status ?? 'idle'));
  const agentBusy = createMemo(() =>
    props.runtime?.url
      ? runtimeRunStatus() === 'running' || agent.busy()
      : agent.busy(),
  );
  const localFallbackActive = createMemo(() => !props.runtime?.url || runtimeStatus() === 'disconnected');

  const messages = createMemo(() => {
    version();
    const runtimeConversation = runtimeState()?.conversation;
    const localCommands = conversationMessages(session)
      .filter((message: any) => message.role === 'command')
      .map((message: any) => ({
        role: 'command',
        content: String(message.content ?? ''),
      }));
    if (Array.isArray(runtimeConversation) && runtimeConversation.length > 0) {
      const runtimeMessages = runtimeConversation.map((message: any) => ({
        role: message.role === 'assistant' ? 'donna' : message.role,
        content: String(message.content ?? ''),
      }));
      return [...runtimeMessages, ...localCommands].slice(-200);
    }
    return [...conversationMessages(session)];
  });
  const prompt = createMemo(() => {
    version();
    return chatMode() ? '[chat] › ' : '[agent] › ';
  });
  const title = createMemo(() => {
    version();
    const workspace = session.workspace ?? 'myspace';
    const profile = session.wikirc?.profile ?? 'donna';
    return `${workspace} > ${profile}`;
  });
  const statusLine = createMemo(() => {
    version();
    return [
      `wiki-manager ${props.packageJson.version ?? ''}`.trim(),
      session.workspace ? session.workspace : 'no workspace',
      session.wikirc?.profile ? session.wikirc.profile : 'no wikirc',
      session.language ? session.language : 'no language',
      session.llm ? 'llm ready' : 'llm limited',
      runtimeStatusText(runtimeStatus(), runtimeRunStatus()),
    ].join('  ');
  });
  const matchContext = createMemo(() => {
    if (input() === dismissedSlashInput()) return null;
    return completionContext(input(), session);
  });
  const slash = createMemo(() => {
    const context = matchContext();
    if (!context) return null;
    const selected = Math.min(selectedCompletion(), Math.max(0, context.matches.length - 1));
    const visibleCount = 10;
    const start = Math.max(0, Math.min(selected - Math.floor(visibleCount / 2), Math.max(0, context.matches.length - visibleCount)));
    const visibleMatches = context.matches.slice(start, start + visibleCount);
    return {
      ...context,
      selected,
      visibleSelected: selected - start,
      items: visibleMatches.map((value: string) => ({
        value,
        description: completionDescription(value, context.parts),
      })),
    };
  });
  const mcpServers = createMemo(() => {
    version();
    return Object.entries(session.mcp ?? {}).map(([name, value]: [string, any]) => ({
      name,
      status: value?.status ?? 'missing',
      detail: value?.detail ?? '',
    }));
  });
  let lastVisibleActivities: any[] = [];
  let lastVisiblePlan: Array<{ step: number; description: string; status: string }> | null = null;
  const activities = createMemo(() => {
    version();
    const runtimeActivities = nonEmptyRuntimeArray(runtimeState()?.activities);
    if (runtimeActivities) {
      return runtimeActivities.map((activity: any) => ({ ...activity, _runtime: true }));
    }
    const current = sessionActivities(session);
    if (current.length > 0) {
      lastVisibleActivities = current.map((activity) => ({ ...activity }));
      return current;
    }
    return agentBusy() && lastVisibleActivities.length > 0
      ? lastVisibleActivities.map((activity) => ({ ...activity }))
      : current;
  });
  const queueItems = createMemo(() => {
    version();
    const runtimeQueue = nonEmptyRuntimeArray(runtimeState()?.queue);
    if (runtimeQueue) return runtimeQueue.map((item: any) => ({ ...item, _runtime: true }));
    return projectQueue((session as any).headlessPlan, (session as any).jobQueue ?? [], { workspace: (session as any).workspace ?? null })
      .map((item: any) => ({ ...item }));
  });
  const queueInfo = createMemo(() => {
    version();
    const runtimeQueue = runtimeState()?.queue;
    if (Array.isArray(runtimeQueue)) {
      return {
        active: runtimeQueue.filter((item: any) => ['waiting', 'starting', 'running', 'queued', 'pending'].includes(String(item.status ?? '').toLowerCase())).length,
        current: runtimeQueue.filter((item: any) => ['starting', 'running'].includes(String(item.status ?? '').toLowerCase())).length,
        frozen: 0,
      };
    }
    return queueCounts(session);
  });
  const plan = createMemo(() => {
    version();
    const runtimePlan = nonEmptyRuntimeArray(runtimeState()?.plan);
    if (runtimePlan) {
      return runtimePlan.map((step: any, index: number) => ({
        step: Number(step.step ?? index + 1),
        description: String(step.description ?? step.label ?? step.name ?? `Step ${index + 1}`),
        status: String(step.status ?? 'pending'),
      }));
    }
    const p = (session as any).headlessPlan as Array<{ step: number; description: string; status: string }> | null;
    const current = p ? p.map((s) => ({ ...s })) : null;
    if (current && current.length > 0) {
      lastVisiblePlan = current.map((step) => ({ ...step }));
      return current;
    }
    return agentBusy() && lastVisiblePlan && lastVisiblePlan.length > 0
      ? lastVisiblePlan.map((step) => ({ ...step }))
      : current;
  });
  const visibleLogs = createMemo(() => {
    version();
    const runtimeLogs = runtimeState()?.logs;
    if (!Array.isArray(runtimeLogs) || runtimeLogs.length === 0) return logs();
    const tagged = runtimeLogs.slice(-80).map((line: any) => `runtime ${String(line)}`);
    return [...logs(), ...tagged].slice(-200);
  });

  function syncRuntimeState() {
    void fetchRuntimeState({ url: props.runtime.url, workspace: (session as any).workspace ?? null })
      .then((state) => {
        setRuntimeState(state);
        setRuntimeStatus('connected');
        refresh();
      })
      .catch(() => {
        setRuntimeStatus('disconnected');
        refresh();
      });
  }
  let runtimeStreamAbort: AbortController | null = null;
  let runtimeSyncDebounce: ReturnType<typeof setTimeout> | null = null;
  let runtimeReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let runtimeStreamStopped = false;

  function debouncedSyncRuntimeState() {
    if (runtimeSyncDebounce) clearTimeout(runtimeSyncDebounce);
    runtimeSyncDebounce = setTimeout(syncRuntimeState, 200);
  }

  async function subscribeRuntimeEvents() {
    if (!props.runtime?.url || runtimeStreamStopped) return;
    runtimeStreamAbort = new AbortController();
    try {
      for await (const _event of streamRuntimeEvents({
        url: props.runtime.url,
        signal: runtimeStreamAbort.signal,
        workspace: (session as any).workspace ?? null,
      })) {
        setRuntimeStatus('connected');
        debouncedSyncRuntimeState();
      }
    } catch {
      // stream dropped or errored — fall through to reconnect below
    }
    if (runtimeStreamStopped) return;
    setRuntimeStatus('disconnected');
    refresh();
    runtimeReconnectTimer = setTimeout(() => { void subscribeRuntimeEvents(); }, 1500);
  }

  if (props.runtime?.url) {
    syncRuntimeState();
    void subscribeRuntimeEvents();
  }
  onCleanup(() => {
    runtimeStreamStopped = true;
    runtimeStreamAbort?.abort();
    if (runtimeSyncDebounce) clearTimeout(runtimeSyncDebounce);
    if (runtimeReconnectTimer) clearTimeout(runtimeReconnectTimer);
  });

  const activityPollTimer = setInterval(() => {
    if (!localFallbackActive()) return;
    for (const activity of sessionActivities(session)) {
      if (activity.terminal || !activity.poll) continue;
      const key = activity.key ?? `${activity.poll.server}:${activity.id ?? activity.label}`;
      if (pollBusy.has(key)) continue;
      const endpoint = (session.mcp as any)?.[activity.poll.server];
      if (!endpoint || endpoint.status !== 'connected') continue;
      const intervalMs = activity.poll.intervalMs ?? 2500;
      const lastPolledAt = Date.parse((activity as any).lastPolledAt ?? '0');
      if (Date.now() - lastPolledAt < intervalMs) continue;
      pollBusy.add(key);
      (activity as any).lastPolledAt = new Date().toISOString();
      void callMcpTool(session.mcp, activity.poll.server, activity.poll.tool, activity.poll.args ?? {})
        .then((result) => {
          const payload = parseJsonText(formatMcpToolResult(result));
          const polledActivity = extractActivity(payload, {
            server: activity.poll.server,
            tool: activity.poll.tool,
          });
          if (polledActivity) {
            dispatchAgentEvent(session, createAgentEvent('activity_upserted', {
              origin: 'poll',
              payload: { activity: polledActivity },
            }));
            syncQueueWithActivity(session, polledActivity);
            refresh();
            const updated = sessionActivities(session).find((a) => a.key === key);
            if (updated) {
              const line = `${updated.label ?? key} -> ${updated.status}${updated.error ? ` (${updated.error})` : ''}`;
              if (lastActivityLines.get(key) !== line) {
                lastActivityLines.set(key, line);
                addLog(`activity: ${line}`);
              }
              const detail = (updated as any).progress?.detail ?? null;
              if (detail && lastActivityDetails.get(key) !== detail) {
                lastActivityDetails.set(key, detail);
                const shortLabel = (updated as any).progress?.label ?? updated.label ?? key;
                addLog(`${shortLabel}: ${detail}`);
              }
            }
            if (updated?.terminal && !matchedActivityKeys.has(key)) {
              matchedActivityKeys.add(key);
              void startNextQueuedJob(session, { addLog, refresh });
              const plan = (session as any).headlessPlan;
              const stillRunning = sessionActivities(session).filter((a) => !a.terminal && a.poll);
              const pendingSteps = (plan ?? []).filter((s: any) => s.status === 'pending');
              if (stillRunning.length === 0 && pendingSteps.length > 0 && !agentBusy()) {
                const completedAll = sessionActivities(session).filter((a) => a.terminal);
                const prompt = buildContinuationPrompt(session, completedAll);
                void agent.submit(prompt);
              }
            }
          }
        })
        .catch((err) => {
          addLog(`activity poll error: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          pollBusy.delete(key);
        });
    }
  }, 1000);
  onCleanup(() => {
    if (activityPollTimer) clearInterval(activityPollTimer);
  });

  const queueFallbackTimer = setInterval(() => {
    if (!localFallbackActive()) return;
    if (queueStoreFor(session).list().some((item: any) => item.status === 'waiting')) {
      void startNextQueuedJob(session, { addLog, refresh });
    }
  }, 10000);
  onCleanup(() => {
    if (queueFallbackTimer) clearInterval(queueFallbackTimer);
  });

  async function submitInput(submittedValue?: string) {
    const line = typeof submittedValue === 'string' && submittedValue.trim() ? submittedValue : input();
    if (agentBusy()) return { exit: false, busy: true };
    setInput('');
    setConversationScroll(0);
    if (line.trim()) {
      setShowWelcome(false);
      setHistory((items) => [...items, line].slice(-100));
    }
    setHistoryIndex(null);
    matchedActivityKeys.clear();
    lastActivityLines.clear();
    lastActivityDetails.clear();
    const result = await agent.submit(line);
    if ((result as any)?.setMode === 'chat') {
      setChatMode(true);
      (session as any).chatMode = true;
      refresh();
    } else if ((result as any)?.setMode === 'agent') {
      setChatMode(false);
      (session as any).chatMode = false;
      refresh();
    }
    return result;
  }

  function updateInput(value: string) {
    setInput(value);
    if (value !== dismissedSlashInput()) setDismissedSlashInput(null);
  }

  function dismissSlash() {
    if (slash()) setDismissedSlashInput(input());
  }

  function completeSelected() {
    const context = slash();
    if (!context || context.matches.length === 0) return;
    const selected = context.matches[context.selected];
    if (!selected) return;
    const lastSpace = input().lastIndexOf(' ');
    const base = input().endsWith(' ') ? input() : input().slice(0, lastSpace + 1);
    setInput(`${base}${selected} `);
    setSelectedCompletion(0);
  }

  function moveCompletion(delta: number) {
    const count = slash()?.matches.length ?? 0;
    if (!count) return;
    setSelectedCompletion((value) => (value + delta + count) % count);
  }

  function historyUp() {
    const items = history();
    if (!items.length) return;
    const next = historyIndex() === null ? items.length - 1 : Math.max(0, historyIndex()! - 1);
    setHistoryIndex(next);
    setInput(items[next] ?? '');
  }

  function historyDown() {
    const items = history();
    const current = historyIndex();
    if (current === null) return;
    const next = current + 1;
    if (next >= items.length) {
      setHistoryIndex(null);
      setInput('');
      return;
    }
    setHistoryIndex(next);
    setInput(items[next] ?? '');
  }

  function scrollConversation(delta: number) {
    setConversationScroll((value) => Math.max(0, value + delta));
  }

  function toggleRightTab() {
    setRightTab((value) => value === 'plan' ? 'queue' : 'plan');
  }

  function selectRightTab(tab: 'plan' | 'queue') {
    setRightTab(tab);
  }

  function closeEditor() {
    setActiveEditor(null);
  }

  function saveEditor(content: string) {
    const editor = activeEditor();
    if (!editor) return { ok: false as const, error: 'No active editor.' };
    if (!session.workspacePath) return { ok: false as const, error: 'No workspace loaded.' };
    const workspaceRoot = resolve(session.workspacePath);
    const targetPath = resolve(editor.filePath);
    const rel = relative(workspaceRoot, targetPath);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return { ok: false as const, error: 'Refusing to save outside the workspace.' };
    }
    try {
      writeFileSync(targetPath, content, 'utf8');
      conversationMessages(session).push({ role: 'command', content: `Saved file: ${editor.displayPath}` });
      setActiveEditor(null);
      refresh();
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }

  function abort() {
    agent.abort();
    dispatchAgentEvent(session, createAgentEvent('plan_set', {
      origin: 'system',
      payload: { steps: null },
    }));
    matchedActivityKeys.clear();
    refresh();
  }

  return {
    session,
    messages,
    logs: visibleLogs,
    input,
    setInput: updateInput,
    title,
    statusLine,
    chatMode,
    showWelcome,
    activeEditor,
    prompt,
    slash,
    mcpServers,
    activities,
    queueItems,
    queueInfo,
    rightTab,
    toggleRightTab,
    selectRightTab,
    plan,
    conversationScroll,
    scrollConversation,
    busy: agentBusy,
    abort,
    submitInput,
    completeSelected,
    dismissSlash,
    moveCompletion,
    historyUp,
    historyDown,
    closeEditor,
    saveEditor,
  };
}
