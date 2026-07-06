/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, For, untrack } from 'solid-js';
import { fit } from './textFit';

export type StartupAction =
  | 'new-conversation'
  | 'open-workspace'
  | 'run-workflow'
  | 'init-workspace';

type StartupItem = {
  action: StartupAction;
  label: string;
  detail: string;
};

const DONNA_LOGO = `
██████╗  ██████╗ ███╗   ██╗███╗   ██╗ █████╗
██╔══██╗██╔═══██╗████╗  ██║████╗  ██║██╔══██╗
██║  ██║██║   ██║██╔██╗ ██║██╔██╗ ██║███████║
██║  ██║██║   ██║██║╚██╗██║██║╚██╗██║██╔══██║
██████╔╝╚██████╔╝██║ ╚████║██║ ╚████║██║  ██║
╚═════╝  ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═══╝╚═╝  ╚═╝
`.trim();

function statusDot(ready: boolean) {
  return ready ? '●' : '○';
}

function initWorkspaceItem(detail: string): StartupItem {
  return { action: 'init-workspace', label: 'Initialize workspace', detail };
}

function keyNameOf(key: any) {
  return String(key?.name ?? key?.key ?? '').toLowerCase();
}

function keySequenceOf(key: any) {
  return String(key?.sequence ?? key?.raw ?? key?.seq ?? key?.input ?? '');
}

function isEnterKey(key: any) {
  const keyName = keyNameOf(key);
  const sequence = keySequenceOf(key);
  return Boolean(
    key?.return ||
    key?.enter ||
    key?.linefeed ||
    keyName === 'return' ||
    keyName === 'enter' ||
    keyName === 'linefeed' ||
    keyName === 'kpenter' ||
    keyName === 'keypadenter' ||
    keyName === 'numenter' ||
    (key?.ctrl && keyName === 'm') ||
    sequence === '\r' ||
    sequence === '\n' ||
    sequence === '\r\n' ||
    sequence === '\x1bOM' ||
    /^\x1b\[13(?:;\d+)?u$/.test(sequence),
  );
}

function isEscapeKey(key: any) {
  const keyName = keyNameOf(key);
  return keyName === 'escape' || keySequenceOf(key) === '\x1b';
}

function isUpKey(key: any) {
  const keyName = keyNameOf(key);
  const sequence = keySequenceOf(key);
  return keyName === 'up' || keyName === 'arrow_up' || sequence === '\x1b[A' || /^\x1b\[57352(?:;\d+)?u$/.test(sequence);
}

function isDownKey(key: any) {
  const keyName = keyNameOf(key);
  const sequence = keySequenceOf(key);
  return keyName === 'down' || keyName === 'arrow_down' || sequence === '\x1b[B' || /^\x1b\[57353(?:;\d+)?u$/.test(sequence);
}

function consumeKey(key: any) {
  key?.preventDefault?.();
  key?.stopPropagation?.();
}

export function StartupScreen(props: {
  version: string;
  model: string;
  connectedMcpServers: number;
  wikiReady: boolean;
  workspaceName?: string | null;
  profileName?: string | null;
  workspaces: string[];
  hasWorkspace: boolean;
  width: number;
  height: number;
  keyboardEvent?: { id: number; key: any } | null;
  onSelect: (action: StartupAction, workspaceName?: string) => void;
  onQuit: () => void;
}) {
  const [mode, setMode] = createSignal<'home' | 'workspace-select'>('home');
  const [selected, setSelected] = createSignal(0);
  let lastKeyboardEventId = 0;
  const panelWidth = createMemo(() => Math.max(70, Math.min(96, props.width - 4)));
  const panelHeight = createMemo(() => Math.max(27, Math.min(35, props.height - 2)));
  const left = createMemo(() => Math.max(1, Math.floor((props.width - panelWidth()) / 2)));
  const top = createMemo(() => Math.max(1, Math.floor((props.height - panelHeight()) / 2)));

  const items = createMemo<StartupItem[]>(() => {
    if (!props.hasWorkspace) {
      return [initWorkspaceItem('Create and configure the default workspace')];
    }
    return [
      {
        action: 'new-conversation',
        label: 'Start a new conversation',
        detail: props.workspaceName ? `Load ${props.workspaceName} with default .wikirc` : 'Load default .wikirc',
      },
      {
        action: 'open-workspace',
        label: 'Open workspace',
        detail: 'Select, load, then start agents and services',
      },
      initWorkspaceItem('Create and configure a new workspace'),
      {
        action: 'run-workflow',
        label: 'Run a workflow',
        detail: 'Switch to Agent mode after loading the workspace',
      },
    ];
  });
  const workspaceItems = createMemo(() => props.workspaces.map((name) => ({
    label: name,
    detail: name === props.workspaceName ? 'default workspace' : 'available workspace',
  })));
  const currentLength = createMemo(() => mode() === 'workspace-select' ? workspaceItems().length : items().length);

  const move = (delta: number) => {
    const length = currentLength();
    if (length <= 0) {
      setSelected(0);
      return;
    }
    setSelected((value) => (value + delta + length) % length);
  };

  createEffect(() => {
    const length = currentLength();
    if (length <= 0) {
      setSelected(0);
      return;
    }
    if (selected() >= length) setSelected(length - 1);
  });

  const choose = (index = selected()) => {
    if (mode() === 'workspace-select') {
      const item = workspaceItems()[index];
      if (item) props.onSelect('open-workspace', item.label);
      return;
    }
    const item = items()[index];
    if (!item) return;
    if (item.action === 'open-workspace') {
      setMode('workspace-select');
      setSelected(0);
      return;
    }
    props.onSelect(item.action);
  };

  const handleKey = (key: any) => {
    const keyName = keyNameOf(key);
    const sequence = keySequenceOf(key);
    if ((key.ctrl || key.meta) && keyName === 'c') {
      consumeKey(key);
      props.onQuit();
      return;
    }
    if (isEscapeKey(key) && mode() === 'workspace-select') {
      consumeKey(key);
      setMode('home');
      setSelected(0);
      return;
    }
    if (isEscapeKey(key)) {
      consumeKey(key);
      props.onQuit();
      return;
    }
    if (isEnterKey(key)) {
      consumeKey(key);
      choose();
      return;
    }
    if (isUpKey(key)) {
      consumeKey(key);
      move(-1);
      return;
    }
    if (isDownKey(key)) {
      consumeKey(key);
      move(1);
      return;
    }
    const numeric = Number.parseInt(sequence, 10);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= currentLength()) {
      consumeKey(key);
      choose(numeric - 1);
    }
  };

  createEffect(() => {
    const event = props.keyboardEvent;
    if (!event || event.id === lastKeyboardEventId) return;
    lastKeyboardEventId = event.id;
    untrack(() => handleKey(event.key));
  });

  const status = createMemo(() => {
    if (!props.hasWorkspace) return 'Setup needed';
    return props.wikiReady ? 'Ready' : 'Default .wikirc missing';
  });

  const subtitle = createMemo(() => {
    const workspace = props.workspaceName ?? 'no workspace';
    const profile = props.profileName ?? 'default';
    return `${workspace} / ${profile}`;
  });

  const innerWidth = createMemo(() => Math.max(40, panelWidth() - 6));
  const shortcutHint = createMemo(() => {
    const count = currentLength();
    const quick = count === 1 ? '1 quick select' : `1-${count} quick select`;
    return mode() === 'workspace-select'
      ? `↑/↓ select  Enter open  ${quick}  Esc back`
      : `↑/↓ select  Enter choose  ${quick}  Esc quit`;
  });
  const menuTitle = createMemo(() => mode() === 'workspace-select' ? 'Select workspace' : '');

  return (
    <box width="100%" height="100%" backgroundColor="#0B0D12">
      <box
        position="absolute"
        left={left()}
        top={top()}
        width={panelWidth()}
        height={panelHeight()}
        border
        borderStyle="rounded"
        borderColor="#8BD5CA"
        backgroundColor="#111318"
        padding={2}
        flexDirection="column"
        overflow="hidden"
      >
        <box height={1} flexDirection="row">
          <text fg="#8BD5CA" content={fit(`DONNA v${props.version}`, Math.floor(innerWidth() * 0.5))} />
          <text fg={props.wikiReady ? '#8BD5CA' : '#FBBF24'} content={fit(` ${statusDot(props.wikiReady)} ${status()}`, Math.floor(innerWidth() * 0.45))} />
        </box>
        <text height={1} fg="#7F8C8D" content={fit(subtitle(), innerWidth())} />
        <text height={1}>{''}</text>
        <box height={8} flexDirection="column" alignItems="center" overflow="hidden">
          <For each={DONNA_LOGO.split('\n')}>
            {(line) => <text height={1} fg="#d6a85f">{line}</text>}
          </For>
          <text height={1} fg="#888888" content="Intelligent workspace" />
        </box>
        <text height={1}>{''}</text>
        <text height={1} fg="#7F8C8D" content={menuTitle()} />
        <box height={Math.max(1, currentLength())} flexDirection="column">
          <For each={mode() === 'workspace-select' ? workspaceItems() : items()}>
            {(item, index) => {
              const active = () => index() === selected();
              return (
                <box
                  height={1}
                  flexDirection="row"
                  onMouseUp={() => choose(index())}
                >
                  <text width={4} fg={active() ? '#111318' : '#7F8C8D'} bg={active() ? '#8BD5CA' : undefined}>
                    {active() ? '›' : ' '} {index() + 1}
                  </text>
                  <text width={28} fg={active() ? '#8BD5CA' : '#D6DEE8'} content={fit(item.label, 27)} />
                  <text fg="#7F8C8D" content={fit(item.detail, Math.max(8, innerWidth() - 34))} />
                </box>
              );
            }}
          </For>
        </box>
        <text height={1}>{''}</text>
        <box height={3} flexDirection="column" border={['left']} borderStyle="heavy" borderColor="#5DADE2" paddingX={1}>
          <text height={1} fg="#D6DEE8" content={fit(`LLM  ${statusDot(Boolean(props.model))} ${props.model || 'not configured'}`, innerWidth() - 2)} />
          <text height={1} fg="#D6DEE8" content={fit(`MCP  ${statusDot(props.connectedMcpServers > 0)} ${props.connectedMcpServers} server(s) configured`, innerWidth() - 2)} />
          <text height={1} fg="#D6DEE8" content={fit(`Wiki ${statusDot(props.wikiReady)} ${props.wikiReady ? 'default profile ready' : 'init required'}`, innerWidth() - 2)} />
        </box>
        <text height={1}>{''}</text>
        <text height={1} fg="#7F8C8D" content={shortcutHint()} />
      </box>
    </box>
  );
}
