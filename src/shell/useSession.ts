import { createMemo, createSignal } from 'solid-js';
import {
  completionContext,
  completionDescription,
  conversationMessages,
  createSession,
  promptFor,
} from './repl.js';
import { useAgent } from './useAgent';

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

  conversationMessages(session).push({
    role: 'dot',
    content: [
      'Orchestrator agent ready.',
      '',
      'Load a workspace with `/use <workspace>`, then chat or use commands.',
      'Type `/help` for all commands.',
    ].join('\n'),
  });

  const refresh = () => setVersion((value) => value + 1);
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

  async function submitInput(submittedValue?: string) {
    const line = typeof submittedValue === 'string' && submittedValue.trim() ? submittedValue : input();
    if (agent.busy()) return { exit: false, busy: true };
    setInput('');
    setConversationScroll(0);
    if (line.trim()) setHistory((items) => [...items, line].slice(-100));
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

  return {
    session,
    messages,
    logs,
    input,
    setInput: updateInput,
    title,
    statusLine,
    prompt,
    slash,
    mcpServers,
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
  };
}
