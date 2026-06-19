/** @jsxImportSource @opentui/solid */
import { For, createEffect, createMemo, createSignal } from 'solid-js';
import { colorForRenderedLine, helpCommandParts, keyValueParts, renderPlainMarkdown } from './renderer';

const LEGACY_DONNA_ROLE = 'do' + 't';

function isDonnaRole(role: string) {
  return role === 'donna' || role === LEGACY_DONNA_ROLE;
}

function roleLabel(role: string) {
  if (role === 'user') return 'user';
  if (role === 'command') return 'shell';
  return 'donna';
}

function roleColor(role: string) {
  if (role === 'user') return '#5DADE2';
  if (role === 'command') return '#AAB7C4';
  return '#8BD5CA';
}

function wrapLine(line: string, width: number) {
  const max = Math.max(12, width);
  if (line.length <= max) return [line];
  const out = [];
  let rest = line;
  while (rest.length > max) {
    const slice = rest.slice(0, max + 1);
    const breakAt = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\t'));
    const index = breakAt > Math.floor(max * 0.45) ? breakAt : max;
    out.push(rest.slice(0, index).trimEnd());
    rest = rest.slice(index).trimStart();
  }
  out.push(rest);
  return out;
}

type Segment = { text: string; color: string; width?: number; bg?: string };
type RenderedLine = {
  segments: Segment[];
  status?: boolean;
  statusLeft?: string;
  statusRight?: string;
};
const STATUS_COLUMN_GAP = 2;
type HelpCard = { title: string; text: string; example: string };

const HELP_CARDS: HelpCard[] = [
  { title: '/new', text: 'Create/configure a workspace.', example: 'Ex: /new <name> [path]' },
  { title: 'modify wikirc', text: 'Action: edit file.', example: 'File: .wikirc.yaml' },
  { title: 'configure CME', text: 'Add type, URL, PAT, email.', example: 'Provide source credentials' },
  { title: 'add MCP', text: 'Inspect and use MCP endpoints.', example: 'Ex: /mcp endpoints' },
  { title: '/use', text: 'Load one workspace and its tools.', example: 'Ex: /use <workspace>' },
  { title: 'llm call action', text: 'Ask to LLM.', example: 'Ex: ask to LLM to run an action' },
];

function HelpCardPanel(props: { card: HelpCard; width: number }) {
  return (
    <box
      width={props.width}
      height={4}
      flexDirection="column"
      border={['left']}
      borderStyle="heavy"
      borderColor="#5DADE2"
      backgroundColor="#111318"
      paddingX={1}
      overflow="hidden"
    >
      <text height={1} fg="#FBBF24">{props.card.title}</text>
      <text height={1} fg="#D6DEE8">{props.card.text}</text>
      <text height={1} fg="#7F8C8D">{props.card.example}</text>
    </box>
  );
}

function WelcomeHelpPanels(props: { width: number }) {
  const cardWidth = Math.max(24, Math.floor((props.width - 6) / 2));
  const rows = [
    HELP_CARDS.slice(0, 2),
    HELP_CARDS.slice(2, 4),
    HELP_CARDS.slice(4, 6),
  ];

  return (
    <box flexGrow={1} flexDirection="column" padding={1} overflow="hidden">
      <text height={1} fg="#8BD5CA">Orchestrator agent ready.</text>
      <text height={1} />
      <text height={1} fg="#7F8C8D">Quick help</text>
      <text height={1} />
      <For each={rows}>
        {(row) => (
          <box height={5} flexDirection="row" gap={2} overflow="hidden">
            <For each={row}>
              {(card) => <HelpCardPanel card={card} width={cardWidth} />}
            </For>
          </box>
        )}
      </For>
      <text height={1} fg="#7F8C8D">Load a workspace with /use &lt;workspace&gt;, then chat or use commands.</text>
      <text height={1} fg="#7F8C8D">Type /help for all commands.</text>
    </box>
  );
}

function messageHeaderSegments(role: string, columns: number): Segment[] {
  const label = `[${roleLabel(role)}]`;
  const left = '── ';
  const rightLength = Math.max(2, columns - left.length - label.length - 1);
  return [
    { text: left, color: '#4B5563' },
    { text: label, color: roleColor(role) },
    { text: ' ' + '─'.repeat(rightLength), color: '#4B5563' },
  ];
}

// Split "  /cmd [<arg>...]  description" into two segments.
// Uses non-greedy to stop at the first double-space separator.
function splitCmdDesc(line: string): [string, string] | null {
  const m = line.match(/^(\s*\/\S+(?:\s+\S+)*?)\s{2,}(.+)$/);
  return m ? [m[1], m[2]] : null;
}

function helpSegments(line: string, columns: number): Segment[] | null {
  const parts = helpCommandParts(line);
  if (!parts) return null;
  const commandWidth = Math.max(14, Math.min(22, Math.floor(columns * 0.27)));
  const descriptionWidth = Math.max(12, Math.min(24, Math.floor(columns * 0.31)));
  const secondCommandWidth = Math.max(12, Math.min(20, Math.floor(columns * 0.24)));
  return [
    { text: parts[0] ?? '', color: '#FBBF24', width: commandWidth },
    { text: parts[1] ?? '', color: '#FFFFFF', width: parts[2] ? descriptionWidth : undefined },
    ...(parts[2] ? [{ text: parts[2], color: '#FBBF24', width: secondCommandWidth }] : []),
    ...(parts[3] ? [{ text: parts[3], color: '#FFFFFF' }] : []),
  ];
}

function segmentsForLine(line: string, role: string, columns: number): Segment[] {
  const help = role === 'command' ? helpSegments(line, columns) : null;
  if (help) return help;
  const keyValue = keyValueParts(line);
  if (keyValue) {
    const segs: Segment[] = [];
    if (keyValue.prefix) segs.push({ text: keyValue.prefix, color: '#D6DEE8' });
    segs.push({ text: keyValue.key, color: '#8BD5CA' });
    segs.push({ text: keyValue.value, color: '#FFFFFF' });
    return segs;
  }
  const cmdDesc = splitCmdDesc(line);
  if (cmdDesc) {
    return [
      { text: cmdDesc[0], color: '#FBBF24' },
      { text: '  ' + cmdDesc[1], color: '#FFFFFF' },
    ];
  }
  return [{ text: line || ' ', color: colorForRenderedLine(line, role) }];
}

function isStatusOutput(message: { role: string; content: string }) {
  const content = String(message.content ?? '');
  return message.role === 'command'
    && content.startsWith('Workspace')
    && content.includes('Config')
    && content.includes('MCP');
}

function statusTextColor(value: string) {
  return /^[A-Za-z].*$/.test(value.trimStart()) && !/^\s/.test(value) ? '#D6DEE8' : '#AAB7C4';
}

function statusValueColor(value: string) {
  const text = String(value ?? '').toLowerCase();
  if (/\b(running|connected|configured|ok)\b/.test(text)) return '#8BD5CA';
  if (/\b(missing|failed|error|cancelled|canceled)\b/.test(text)) return '#F38BA8';
  return '#FFFFFF';
}

function statusSegments(value: string): Segment[] {
  const text = value || ' ';
  const trimmed = text.trim();
  if (trimmed && !text.startsWith(' ') && !trimmed.includes(':') && !/^[●◐○-]/.test(trimmed)) {
    return [{ text, color: '#FBBF24' }];
  }
  if (trimmed && !text.startsWith(' ') && /^[A-Za-z].*:\s+/.test(trimmed)) {
    const index = text.indexOf(':');
    return [
      { text: text.slice(0, index + 1), color: '#FBBF24' },
      { text: text.slice(index + 1), color: '#AAB7C4' },
    ];
  }
  if (/^[●◐○]/.test(trimmed)) {
    return [{ text, color: colorForRenderedLine(trimmed, 'command') }];
  }
  const keyValue = keyValueParts(text);
  if (keyValue) {
    const segs: Segment[] = [];
    if (keyValue.prefix) segs.push({ text: keyValue.prefix, color: '#AAB7C4' });
    segs.push({ text: keyValue.key, color: '#8BD5CA' });
    segs.push({ text: keyValue.value, color: statusValueColor(keyValue.value) });
    return segs;
  }
  return [{ text, color: statusTextColor(text) }];
}

function statusColumns(line: string): { left: string; right: string } {
  if (line.includes('\t')) {
    const [left, ...rest] = line.split('\t');
    return { left: left || ' ', right: rest.join('\t') };
  }
  const left = line.trimEnd();
  const right = '';
  return { left: left || ' ', right };
}

function conversationLines(messages: Array<{ role: string; content: string }>, columns: number): RenderedLine[] {
  return messages.flatMap((message) => {
    const raw = String(message.content || '');
    if (isStatusOutput(message)) {
      return [
        { segments: messageHeaderSegments(message.role, columns) },
        ...raw.split('\n').map((line) => {
          const { left, right } = statusColumns(line || ' ');
          return { status: true, statusLeft: left, statusRight: right, segments: [] };
        }),
        { segments: [{ text: ' ', color: '#D6DEE8' }] },
      ];
    }
    let inFence = false;
    const lines: Array<{ text: string; isCode: boolean }> = [];
    for (const line of raw.split('\n')) {
      if (/^(`{2,3}|~{2,3})/.test(line)) { inFence = !inFence; continue; }
      lines.push({ text: line, isCode: inFence });
    }
    return [
      { segments: messageHeaderSegments(message.role, columns) },
      ...lines.flatMap(({ text, isCode }) => {
        if (isCode) {
          return wrapLine(text || ' ', columns).map((piece) => ({
            segments: [{ text: piece || ' ', color: '#D6DEE8', bg: '#1A2235' }],
          }));
        }
        const rendered = renderPlainMarkdown(text);
        const help = message.role === 'command' ? helpSegments(rendered, columns) : null;
        if (help) return [{ segments: help }];
        const isCmdDesc = splitCmdDesc(rendered) !== null;
        const fallback = isCmdDesc ? '#FFFFFF' : colorForRenderedLine(rendered, message.role);
        return wrapLine(rendered, columns).map((piece, idx) => ({
          segments: idx === 0
            ? segmentsForLine(piece, message.role, columns)
            : [{ text: piece || ' ', color: fallback }],
        }));
      }),
      { segments: [{ text: ' ', color: '#D6DEE8' }] },
    ];
  });
}

export function ConversationView(props: {
  messages: Array<{ role: string; content: string }>;
  rows: number;
  columns: number;
  scroll: number;
  onScroll: (delta: number) => void;
  spinnerFrame: string;
}) {
  const allLines = createMemo(() => conversationLines(props.messages, props.columns));
  const visibleLines = () => {
    const lines = allLines();
    const rows = Math.max(1, props.rows - 1);
    const maxScroll = Math.max(0, lines.length - rows);
    const scroll = Math.min(props.scroll, maxScroll);
    const end = lines.length - scroll;
    const start = Math.max(0, end - rows);
    return lines.slice(start, end);
  };
  const scrollHint = () => {
    const lines = allLines();
    const rows = Math.max(1, props.rows - 1);
    const maxScroll = Math.max(0, lines.length - rows);
    const scroll = Math.min(props.scroll, maxScroll);
    if (maxScroll === 0) return '';
    if (scroll === 0) return `↑ ${maxScroll} lines`;
    if (scroll === maxScroll) return `↓ ${maxScroll} lines`;
    return `↑ ${maxScroll - scroll}  ↓ ${scroll}`;
  };

  return (
    <box
      flexGrow={1}
      flexDirection="column"
      padding={1}
      overflow="hidden"
      onMouseScroll={(event: any) => {
        const direction = event.scroll?.direction;
        if (direction === 'up') props.onScroll(3);
        if (direction === 'down') props.onScroll(-3);
        event.preventDefault?.();
        event.stopPropagation?.();
      }}
    >
      <text height={1} fg="#7F8C8D">{scrollHint()}</text>
      <For each={visibleLines()}>
        {(line) => (
          line.status ? (
            <box height={1} flexDirection="row" gap={2} overflow="hidden">
              <box
                height={1}
                width={Math.max(18, Math.floor((props.columns - STATUS_COLUMN_GAP) / 2))}
                flexDirection="row"
                border={['left']}
                borderStyle="heavy"
                borderColor="#5DADE2"
                backgroundColor="#111318"
                paddingX={1}
                overflow="hidden"
              >
                <For each={statusSegments(line.statusLeft ?? '')}>
                  {(seg) => <text width={seg.width} fg={seg.color} bg="#111318">{seg.text}</text>}
                </For>
              </box>
              {line.statusRight ? (
                <box
                  height={1}
                  width={Math.max(18, Math.floor((props.columns - STATUS_COLUMN_GAP) / 2))}
                  flexDirection="row"
                  border={['left']}
                  borderStyle="heavy"
                  borderColor="#5DADE2"
                  backgroundColor="#111318"
                  paddingX={1}
                  overflow="hidden"
                >
                  <For each={statusSegments(line.statusRight)}>
                    {(seg) => <text width={seg.width} fg={seg.color} bg="#111318">{seg.text}</text>}
                  </For>
                </box>
              ) : null}
            </box>
          ) : (
            <box height={1} flexDirection="row" overflow="hidden">
              <For each={line.segments}>
                {(seg: Segment) => <text width={seg.width} fg={seg.color} bg={seg.bg}>{seg.text}</text>}
              </For>
            </box>
          )
        )}
      </For>
    </box>
  );
}

export function ChatInput(props: {
  width: number;
  prompt: string;
  value: string;
  busy: boolean;
  chatMode: boolean;
  focused: boolean;
  spinnerFrame: string;
  onInput: (value: string) => void;
  onSubmit: (value?: string) => void;
  onHeightChange: (height: number) => void;
}) {
  let containerRef: any;
  let textareaRef: any;
  const minRows = 1;
  const maxRows = 5;
  const [textareaRows, setTextareaRows] = createSignal(minRows);
  const idleColor = () => props.chatMode ? '#22C55E' : '#06B6D4';
  const promptText = () => props.busy ? `${props.spinnerFrame} ` : props.prompt;
  const boxHeight = () => textareaRows() + 2;
  const textareaColumns = () => {
    const measured = Number(textareaRef?.width ?? 0);
    if (Number.isFinite(measured) && measured > 0) return Math.max(8, measured - 1);
    return Math.max(8, props.width - promptText().length - 7);
  };
  const estimatedVisualRows = (value: string) => {
    const columns = textareaColumns();
    return Math.max(1, value.split('\n').reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / columns)), 0));
  };
  const measuredVisualRows = (value: string) => {
    const virtualRows = Number(textareaRef?.virtualLineCount ?? 0);
    const logicalRows = Number(textareaRef?.lineCount ?? 0);
    const scrollRows = Number(textareaRef?.scrollHeight ?? 0);
    return Math.max(
      estimatedVisualRows(value),
      Number.isFinite(virtualRows) ? virtualRows : 0,
      Number.isFinite(logicalRows) ? logicalRows : 0,
      Number.isFinite(scrollRows) ? scrollRows : 0,
    );
  };
  const applyHeight = (rows: number) => {
    const height = rows + 2;
    if (textareaRef) textareaRef.height = rows;
    if (containerRef) containerRef.height = height;
    props.onHeightChange(height);
  };
  const updateRows = (value = String(textareaRef?.plainText ?? props.value ?? '')) => {
    const rows = Math.min(maxRows, Math.max(minRows, measuredVisualRows(value)));
    setTextareaRows(rows);
    applyHeight(rows);
  };
  const syncTextareaValue = (value: string) => {
    const current = String(textareaRef?.plainText ?? '');
    if (!textareaRef || current === value) return;
    if (value === '') textareaRef.clear?.();
    else textareaRef.setText?.(value);
    try {
      textareaRef.cursorOffset = value.length;
    } catch {
      // Some renderable states reject cursor movement while layout is settling.
    }
    updateRows(value);
    queueMicrotask(() => updateRows(value));
  };
  const handleContentChange = () => {
    const value = String(textareaRef?.plainText ?? '');
    props.onInput(value);
    updateRows(value);
    queueMicrotask(() => updateRows(value));
  };
  const submitCurrentValue = () => {
    props.onSubmit(String(textareaRef?.plainText ?? props.value ?? ''));
  };

  createEffect(() => {
    props.onHeightChange(boxHeight());
  });

  createEffect(() => {
    syncTextareaValue(props.value);
  });

  createEffect(() => {
    props.width;
    props.prompt;
    props.spinnerFrame;
    queueMicrotask(() => updateRows());
  });

  return (
    <box
      ref={containerRef}
      height={boxHeight()}
      paddingX={1}
      flexDirection="row"
      alignItems="flex-start"
      border
      borderStyle="single"
      borderColor={props.busy ? '#FBBF24' : idleColor()}
    >
      <text height={1} fg={props.busy ? '#FBBF24' : idleColor()}>{promptText()}</text>
      <textarea
        ref={textareaRef}
        flexGrow={1}
        height={textareaRows()}
        focused={props.focused && !props.busy}
        initialValue={props.value}
        wrapMode="word"
        placeholder={props.busy ? 'Thinking' : 'Type a message or /command'}
        keyBindings={[
          { name: 'return', action: 'submit' },
          { name: 'kpenter', action: 'submit' },
          { name: 'linefeed', action: 'newline' },
          { name: 'return', shift: true, action: 'newline' },
          { name: 'kpenter', shift: true, action: 'newline' },
          { name: 'linefeed', shift: true, action: 'newline' },
        ]}
        onSubmit={submitCurrentValue}
        onContentChange={handleContentChange}
      />
      <text width={1}> </text>
    </box>
  );
}

export function LeftPane(props: {
  width: number;
  title: string;
  statusLine: string;
  hintLine?: string | null;
  showWelcome: boolean;
  messages: Array<{ role: string; content: string }>;
  prompt: string;
  input: string;
  busy: boolean;
  chatMode: boolean;
  chatFocused: boolean;
  setInput: (value: string) => void;
  submit: (value?: string) => void;
  conversationRows: number;
  conversationColumns: number;
  conversationScroll: number;
  scrollConversation: (delta: number) => void;
  spinnerFrame: string;
  onInputHeightChange: (height: number) => void;
}) {
  const modeColor = () => props.chatMode ? '#22C55E' : '#06B6D4';
  const modeLabel = () => props.chatMode ? 'CHAT MODE  direct LLM, no tools' : 'AGENT MODE  LangGraph + MCP tools';
  return (
    <box width={props.width} height="100%" flexDirection="column" padding={1} overflow="hidden">
      <box height={3} flexDirection="column">
        <box height={1} flexDirection="row" backgroundColor={modeColor()} paddingX={1}>
          <text fg="#0B1020">{modeLabel()}</text>
        </box>
        <box height={1} flexDirection="row">
          <text fg="#D6DEE8">{props.title}</text>
          <text fg="#7F8C8D">  {props.statusLine}</text>
        </box>
        <box height={1} flexDirection="row">
          {props.hintLine ? <text fg="#FBBF24">[ {props.hintLine} ]</text> : null}
        </box>
      </box>
      {props.showWelcome ? (
        <WelcomeHelpPanels width={props.conversationColumns} />
      ) : (
        <ConversationView
          messages={props.messages}
          rows={props.conversationRows}
          columns={props.conversationColumns}
          scroll={props.conversationScroll}
          onScroll={props.scrollConversation}
          spinnerFrame={props.spinnerFrame}
        />
      )}
      <ChatInput
        width={props.width}
        prompt={props.prompt}
        value={props.input}
        busy={props.busy}
        chatMode={props.chatMode}
        focused={props.chatFocused}
        spinnerFrame={props.spinnerFrame}
        onInput={props.setInput}
        onSubmit={props.submit}
        onHeightChange={props.onInputHeightChange}
      />
    </box>
  );
}
