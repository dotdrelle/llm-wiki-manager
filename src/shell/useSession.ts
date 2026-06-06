import { writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createMemo, createSignal, onCleanup } from 'solid-js';
import { formatMcpToolResult, callMcpTool } from '../core/mcp.js';
import { parseJsonText, rememberActivityFromPayload, sessionActivities } from '../core/activity.js';
import { matchCompletedToPlan, formatPlanStatus, formatCompletedActivities } from '../core/plan.js';
import type { ActiveFileEditor } from './FileEditorDialog';
import {
  completionContext,
  completionDescription,
  conversationMessages,
  createSession,
  promptFor,
} from './repl.js';
import { useAgent } from './useAgent';

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

export function useSession(props: { agent: unknown; packageJson: Record<string, unknown> }) {
  const session = createSession();
  const [version, setVersion] = createSignal(0);
  const [logs, setLogs] = createSignal<string[]>([]);
  const [input, setInput] = createSignal('');
  const [dismissedSlashInput, setDismissedSlashInput] = createSignal<string | null>(null);
  const [history, setHistory] = createSignal<string[]>([]);
  const [historyIndex, setHistoryIndex] = createSignal<number | null>(null);
  const [selectedCompletion, setSelectedCompletion] = createSignal(0);
  const [conversationScroll, setConversationScroll] = createSignal(0);
  const [showWelcome, setShowWelcome] = createSignal(true);
  const [activeEditor, setActiveEditor] = createSignal<ActiveFileEditor | null>(null);
  const pollBusy = new Set<string>();
  const matchedActivityKeys = new Set<string>();
  const lastActivityLines = new Map<string, string>();

  const refresh = () => setVersion((value) => value + 1);
  (session as any)._onPlanUpdate = refresh;
  (session as any)._onOpenEditor = (editor: ActiveFileEditor) => {
    setShowWelcome(false);
    setActiveEditor(editor);
  };
  const addLog = (line: string) => {
    setLogs((items) => [...items, `${new Date().toLocaleTimeString()} ${line}`].slice(-200));
  };
  const agent = useAgent({ agent: props.agent, packageJson: props.packageJson, session, refresh, addLog });

  const messages = createMemo(() => {
    version();
    return [...conversationMessages(session)];
  });
  const prompt = createMemo(() => {
    version();
    return promptFor(session);
  });
  const title = createMemo(() => {
    version();
    const workspace = session.workspace ?? 'myspace';
    const profile = session.wikirc?.profile ?? 'dot';
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
    ].join('  ');
  });
  const slash = createMemo(() => {
    if (input() === dismissedSlashInput()) return null;
    const context = completionContext(input(), session);
    if (!context) return null;
    return {
      ...context,
      selected: Math.min(selectedCompletion(), Math.max(0, context.matches.length - 1)),
      items: context.matches.slice(0, 10).map((value: string) => ({
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
  const activities = createMemo(() => {
    version();
    return sessionActivities(session);
  });
  const plan = createMemo(() => {
    version();
    const p = (session as any).headlessPlan as Array<{ step: number; description: string; status: string }> | null;
    return p ? p.map((s) => ({ ...s })) : null;
  });

  const activityPollTimer = setInterval(() => {
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
          if (rememberActivityFromPayload(session, payload, {
            server: activity.poll.server,
            tool: activity.poll.tool,
          })) {
            refresh();
            const updated = sessionActivities(session).find((a) => a.key === key);
            if (updated) {
              const line = `${updated.label ?? key} -> ${updated.status}${updated.error ? ` (${updated.error})` : ''}`;
              if (lastActivityLines.get(key) !== line) {
                lastActivityLines.set(key, line);
                addLog(`activity: ${line}`);
              }
            }
            if (updated?.terminal && !matchedActivityKeys.has(key)) {
              matchedActivityKeys.add(key);
              const plan = (session as any).headlessPlan;
              if (plan) {
                matchCompletedToPlan(plan, [updated]);
                (session as any)._onPlanUpdate?.();
              }
              const stillRunning = sessionActivities(session).filter((a) => !a.terminal && a.poll);
              const pendingSteps = (plan ?? []).filter((s: any) => s.status === 'pending');
              if (stillRunning.length === 0 && pendingSteps.length > 0 && !agent.busy()) {
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
  onCleanup(() => clearInterval(activityPollTimer));

  async function submitInput(submittedValue?: string) {
    const line = typeof submittedValue === 'string' && submittedValue.trim() ? submittedValue : input();
    if (agent.busy()) return { exit: false, busy: true };
    setInput('');
    setConversationScroll(0);
    if (line.trim()) {
      setShowWelcome(false);
      setHistory((items) => [...items, line].slice(-100));
    }
    setHistoryIndex(null);
    const result = await agent.submit(line);
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
    if (!context || context.items.length === 0) return;
    const selected = context.items[context.selected]?.value;
    if (!selected) return;
    const lastSpace = input().lastIndexOf(' ');
    const base = input().endsWith(' ') ? input() : input().slice(0, lastSpace + 1);
    setInput(`${base}${selected} `);
    setSelectedCompletion(0);
  }

  function moveCompletion(delta: number) {
    const count = slash()?.items.length ?? 0;
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

  return {
    session,
    messages,
    logs,
    input,
    setInput: updateInput,
    title,
    statusLine,
    showWelcome,
    activeEditor,
    prompt,
    slash,
    mcpServers,
    activities,
    plan,
    conversationScroll,
    scrollConversation,
    busy: agent.busy,
    abort: agent.abort,
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
