import { For, Show } from 'solid-js';

function wrapLine(value: string, width: number) {
  const max = Math.max(8, width);
  const text = String(value);
  if (text.length <= max) return [text];
  const lines = [];
  let rest = text;
  while (rest.length > max) {
    const slice = rest.slice(0, max + 1);
    const breakAt = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\t'));
    const index = breakAt > Math.floor(max * 0.45) ? breakAt : max;
    lines.push(rest.slice(0, index).trimEnd());
    rest = rest.slice(index).trimStart();
  }
  if (rest) lines.push(rest);
  return lines;
}

function fit(value: string, width: number) {
  const max = Math.max(1, width);
  if (value.length <= max) return value;
  if (max <= 1) return '…';
  return value.slice(0, max - 1) + '…';
}

function statusGlyph(status: string) {
  if (status === 'connected') return '●';
  if (status === 'configured') return '◐';
  return '○';
}

function statusColor(status: string) {
  if (status === 'connected') return '#8BD5CA';
  if (status === 'configured') return '#9CA3AF';
  return '#7F8C8D';
}

export function McpPanel(props: { servers: Array<{ name: string; status: string; detail?: string }>; width: number }) {
  const lineWidth = () => Math.max(8, props.width - 2);
  return (
    <box flexShrink={0} flexDirection="column" padding={1}>
      <text width={lineWidth()} fg="#D6DEE8">MCP Servers</text>
      <Show when={props.servers.length > 0} fallback={<text width={lineWidth()} fg="#7F8C8D">○ no workspace</text>}>
        <For each={props.servers}>
          {(server) => (
            <text width={lineWidth()} fg={statusColor(server.status)}>
              {fit(`${statusGlyph(server.status)} ${server.name} ${server.detail ?? ''}`, lineWidth())}
            </text>
          )}
        </For>
      </Show>
    </box>
  );
}

export function LogPanel(props: { logs: string[]; width: number }) {
  const lineWidth = () => Math.max(8, props.width - 2);
  const visibleLines = () => props.logs.slice(-12).flatMap((line) => wrapLine(line, lineWidth()));
  return (
    <box flexGrow={1} flexDirection="column" padding={1}>
      <text width={lineWidth()} fg="#D6DEE8">Logs / Trace</text>
      <box flexGrow={1} flexDirection="column" overflow="hidden">
        <For each={visibleLines().slice(-24)}>
          {(line) => <text width={lineWidth()} fg="#AAB7C4">{line}</text>}
        </For>
      </box>
    </box>
  );
}

export function RightPane(props: { width: number; servers: Array<{ name: string; status: string; detail?: string }>; logs: string[] }) {
  return (
    <box width={props.width} height="100%" flexDirection="column" gap={1} padding={1} overflow="hidden">
      <McpPanel width={props.width} servers={props.servers} />
      <LogPanel width={props.width} logs={props.logs} />
    </box>
  );
}
