/** @jsxImportSource @opentui/solid */
import { For, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
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
    const spaceAt = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\t'));
    const slashAt = slice.lastIndexOf('/');
    const threshold = Math.floor(max * 0.45);
    let index: number;
    if (spaceAt > threshold && (slashAt < 0 || spaceAt <= slashAt)) {
      index = spaceAt;
    } else if (slashAt > threshold) {
      index = slashAt + 1;
    } else if (spaceAt > threshold) {
      index = spaceAt;
    } else {
      index = max;
    }
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
  copyContent?: string;
};
const STATUS_COLUMN_GAP = 2;
type HelpCard = { title: string; text: string; example: string };

const HELP_CARDS: HelpCard[] = [
  { title: '/use', text: 'Load one workspace.', example: 'Ex: /use <workspace>' },
  { title: '/new', text: 'Create/configure a workspace.', example: 'Ex: /new <name> [path]' },
  { title: '/config', text: 'Modify LLM configuration.', example: 'Ex: /config edit <profile>' },
  { title: '/mcp', text: 'View MCP.', example: 'Ex: /mcp status' },
  { title: 'configure CME', text: 'Add type, URL, PAT, email.', example: 'Ask to donna to set credentials' },
  { title: '/status', text: 'Check config.', example: 'Ex: /status' },
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

const COPY_BTN = ' [ copy ]';

function messageHeaderSegments(role: string, columns: number): Segment[] {
  const label = `[${roleLabel(role)}]`;
  const left = '── ';
  const rightLength = Math.max(2, columns - left.length - label.length - 1 - COPY_BTN.length);
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

function isMarkdownTableRow(line: string) {
  const trimmed = line.trim();
  return trimmed.includes('|') && !/^(`{2,3}|~{2,3})/.test(trimmed);
}

function isMarkdownTableSeparator(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function parseMarkdownTableRow(line: string) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  return text.split('|').map((cell) => renderPlainMarkdown(cell.trim()));
}

function wrapCellText(text: string, width: number) {
  return wrapLine(text || ' ', Math.max(4, width));
}

function tableCellColor(text: string, header: boolean) {
  if (header) return '#FBBF24';
  if (/[❌✗]/.test(text)) return '#F38BA8';
  if (/[⚠!]/.test(text)) return '#FBBF24';
  if (/[✅✓]/.test(text)) return '#8BD5CA';
  return '#D6DEE8';
}

function tableColumnWidths(rows: string[][], columns: number) {
  // rows is already normalized (uniform length) by the caller
  const columnCount = rows[0]?.length ?? 1;
  const separatorWidth = Math.max(0, columnCount - 1) * 3;
  const available = Math.max(columnCount * 5, columns - separatorWidth);
  const natural = Array.from({ length: columnCount }, (_, i) =>
    rows.reduce((m, row) => Math.max(m, row[i].length), 4),
  );
  const totalNatural = natural.reduce((sum, width) => sum + width, 0);
  if (totalNatural <= available) return natural;

  const minWidth = columnCount >= 5 ? 6 : 8;
  let remaining = Math.max(columnCount * minWidth, available);
  const widths = Array.from({ length: columnCount }, () => minWidth);
  remaining -= widths.reduce((sum, width) => sum + width, 0);
  const extraNatural = natural.map((width) => Math.max(0, width - minWidth));
  let extraTotal = extraNatural.reduce((sum, width) => sum + width, 0);
  for (let i = 0; i < columnCount && remaining > 0 && extraTotal > 0; i += 1) {
    const add = Math.min(extraNatural[i], Math.floor((extraNatural[i] / extraTotal) * remaining));
    widths[i] += add;
    remaining -= add;
  }
  for (let i = 0; remaining > 0; i = (i + 1) % columnCount) {
    widths[i] += 1;
    remaining -= 1;
  }
  return widths;
}

function renderMarkdownTable(tableLines: string[], columns: number): RenderedLine[] {
  const rows = tableLines
    .filter((line) => !isMarkdownTableSeparator(line))
    .map(parseMarkdownTableRow)
    .filter((row) => row.length > 0);
  if (rows.length === 0) return [];

  const columnCount = rows.reduce((m, row) => Math.max(m, row.length), 1);
  const normalized = rows.map((row) => Array.from({ length: columnCount }, (_, i) => row[i] ?? ''));
  const widths = tableColumnWidths(normalized, columns);
  const output: RenderedLine[] = [];

  normalized.forEach((row, rowIndex) => {
    const wrapped = row.map((cell, index) => wrapCellText(cell, widths[index]));
    const height = wrapped.reduce((m, cell) => Math.max(m, cell.length), 1);
    for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
      const segments: Segment[] = [];
      row.forEach((cell, cellIndex) => {
        if (cellIndex > 0) segments.push({ text: ' │ ', color: '#4B5563' });
        const piece = wrapped[cellIndex][lineIndex] ?? '';
        segments.push({
          text: piece.slice(0, widths[cellIndex]).padEnd(widths[cellIndex]),
          color: tableCellColor(cell, rowIndex === 0),
        });
      });
      output.push({ segments });
    }
    if (rowIndex === 0 && normalized.length > 1) {
      output.push({
        segments: widths.flatMap((width, index) => [
          ...(index > 0 ? [{ text: '─┼─', color: '#4B5563' }] : []),
          { text: '─'.repeat(width), color: '#4B5563' },
        ]),
      });
    }
  });
  return output;
}

function renderMarkdownLines(lines: Array<{ text: string; isCode: boolean }>, role: string, columns: number): RenderedLine[] {
  const output: RenderedLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const { text, isCode } = lines[index];
    if (isCode) {
      const blockStarts = index === 0 || !lines[index - 1].isCode;
      const blockEnds = index === lines.length - 1 || !lines[index + 1].isCode;
      // Blank line before/after the block + 2-space inner padding: fenced
      // blocks used to render as a dense background slab glued to the text.
      if (blockStarts) output.push({ segments: [{ text: ' ', color: '#D6DEE8' }] });
      const innerWidth = Math.max(8, columns - 4);
      output.push(...wrapLine(text || ' ', innerWidth).map((piece) => ({
        segments: [{ text: `  ${(piece || ' ').padEnd(innerWidth)}  `, color: '#D6DEE8', bg: '#1A2235' }],
      })));
      if (blockEnds) output.push({ segments: [{ text: ' ', color: '#D6DEE8' }] });
      continue;
    }

    if (isMarkdownTableRow(text) && isMarkdownTableSeparator(lines[index + 1]?.text ?? '')) {
      const tableLines = [text, lines[index + 1].text];
      let next = index + 2;
      while (next < lines.length && !lines[next].isCode && isMarkdownTableRow(lines[next].text)) {
        tableLines.push(lines[next].text);
        next += 1;
      }
      index = next - 1;
      output.push(...renderMarkdownTable(tableLines, columns));
      continue;
    }

    const rendered = renderPlainMarkdown(text);
    const isCmdDesc = splitCmdDesc(rendered) !== null;
    const fallback = isCmdDesc ? '#FFFFFF' : colorForRenderedLine(rendered, role);
    output.push(...wrapLine(rendered, columns).map((piece, idx) => ({
      segments: idx === 0
        ? segmentsForLine(piece, role, columns)
        : [{ text: piece || ' ', color: fallback }],
    })));
  }
  return output;
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
        { segments: messageHeaderSegments(message.role, columns), copyContent: raw },
        { segments: [{ text: ' ', color: '#D6DEE8' }] },
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
      // LLM responses often indent fenced blocks as part of a list. Accept
      // leading whitespace so ```bash / ~~~ fences are rendered as code
      // instead of leaking their Markdown markers into the conversation.
      if (/^\s*(`{3,}|~{3,})/.test(line)) { inFence = !inFence; continue; }
      lines.push({ text: line, isCode: inFence });
    }
    return [
      { segments: messageHeaderSegments(message.role, columns), copyContent: raw },
      { segments: [{ text: ' ', color: '#D6DEE8' }] },
      ...renderMarkdownLines(lines, message.role, columns),
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
  onCopy?: (content: string) => void;
}) {
  const allLines = createMemo(() => conversationLines(props.messages, props.columns));
  const visibleLines = () => {
    const lines = allLines();
    const rows = Math.max(1, props.rows - 2);
    const maxScroll = Math.max(0, lines.length - rows);
    const scroll = Math.min(props.scroll, maxScroll);
    const end = lines.length - scroll;
    const start = Math.max(0, end - rows);
    return lines.slice(start, end);
  };
  const scrollHint = () => {
    const lines = allLines();
    const rows = Math.max(1, props.rows - 2);
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
          line.copyContent !== undefined ? (
            <box height={1} flexDirection="row" overflow="hidden">
              <For each={line.segments}>
                {(seg: Segment) => <text width={seg.width} fg={seg.color} bg={seg.bg}>{seg.text}</text>}
              </For>
              <text fg="#4B5563" content={COPY_BTN} onMouseUp={() => props.onCopy?.(line.copyContent!)} />
            </box>
          ) : line.status ? (
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
      <text height={1} />
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
  let disposed = false;
  const idleColor = () => props.chatMode ? '#22C55E' : '#06B6D4';
  const promptText = () => props.busy ? `${props.spinnerFrame} ` : props.prompt;
  const boxHeight = () => textareaRows() + 2;
  const inputColumns = () => Math.max(8, props.width - promptText().length - 6);
  const textareaColumns = () => {
    const measured = Number(textareaRef?.width ?? 0);
    const bounded = Math.min(inputColumns(), Number.isFinite(measured) && measured > 0 ? measured : inputColumns());
    return Math.max(8, bounded - 1);
  };
  const estimatedVisualRows = (value: string) => {
    const columns = textareaColumns();
    return Math.max(1, value.split('\n').reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / columns)), 0));
  };
  const measuredVisualRows = (value: string) => {
    try {
      const virtualRows = Number(textareaRef?.virtualLineCount ?? 0);
      const logicalRows = Number(textareaRef?.lineCount ?? 0);
      const scrollRows = Number(textareaRef?.scrollHeight ?? 0);
      return Math.max(
        estimatedVisualRows(value),
        Number.isFinite(virtualRows) ? virtualRows : 0,
        Number.isFinite(logicalRows) ? logicalRows : 0,
        Number.isFinite(scrollRows) ? scrollRows : 0,
      );
    } catch {
      return estimatedVisualRows(value);
    }
  };
  const applyHeight = (rows: number) => {
    const height = rows + 2;
    if (textareaRef) textareaRef.height = rows;
    if (containerRef) containerRef.height = height;
    props.onHeightChange(height);
  };
  const safePlainText = () => {
    try {
      return String(textareaRef?.plainText ?? props.value ?? '');
    } catch {
      return String(props.value ?? '');
    }
  };
  const updateRows = (value?: string) => {
    if (disposed) return;
    const text = value ?? safePlainText();
    const rows = Math.min(maxRows, Math.max(minRows, measuredVisualRows(text)));
    setTextareaRows(rows);
    applyHeight(rows);
  };
  const queueUpdateRows = (value?: string) => {
    queueMicrotask(() => {
      if (!disposed) updateRows(value);
    });
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
    queueUpdateRows(value);
  };
  const handleContentChange = () => {
    const value = safePlainText();
    props.onInput(value);
    updateRows(value);
    queueUpdateRows(value);
  };
  const submitCurrentValue = () => {
    props.onSubmit(safePlainText());
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
    queueUpdateRows();
  });
  onCleanup(() => {
    disposed = true;
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
        width={inputColumns()}
        height={textareaRows()}
        focused={props.focused && !props.busy}
        initialValue={props.value}
        wrapMode="word"
        placeholder={props.busy ? 'Thinking' : 'Type a message or /command'}
        keyBindings={[
          { name: 'return', action: 'submit' },
          { name: 'kpenter', action: 'submit' },
          { name: 'linefeed', action: 'submit' },
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
  onCopy?: (content: string) => void;
}) {
  const modeColor = () => props.chatMode ? '#22C55E' : '#06B6D4';
  const modeLabel = () => props.chatMode ? 'CHAT MODE  direct LLM, no tools' : 'AGENTIC MODE  LangGraph + MCP tools';
  const showWelcome = () => props.showWelcome && props.messages.length === 0;
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
      {showWelcome() ? (
        <WelcomeHelpPanels width={props.conversationColumns} />
      ) : (
        <ConversationView
          messages={props.messages}
          rows={props.conversationRows}
          columns={props.conversationColumns}
          scroll={props.conversationScroll}
          onScroll={props.scrollConversation}
          spinnerFrame={props.spinnerFrame}
          onCopy={props.onCopy}
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
