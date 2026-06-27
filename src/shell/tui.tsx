/** @jsxImportSource @opentui/solid */
import { execFileSync } from 'node:child_process';
import { render, useKeyboard, useRenderer, useSelectionHandler, useTerminalDimensions } from '@opentui/solid';
import { createMemo, createSignal, onCleanup } from 'solid-js';
import { FileEditorDialog } from './FileEditorDialog';
import { LeftPane } from './LeftPane';
import { RightPane } from './RightPane';
import { SlashDialog } from './SlashDialog';
import { SetupWizard } from './SetupWizard';
import { useSession } from './useSession';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function copyToClipboard(text: string, renderer: unknown) {
  try {
    if ((renderer as any).copyToClipboardOSC52?.(text)) return true;
  } catch {
    // Fall through to platform clipboard tools.
  }
  try {
    if (process.platform === 'darwin') {
      execFileSync('pbcopy', [], { input: text });
      return true;
    }
    if (process.platform === 'win32') {
      execFileSync('clip', [], { input: text });
      return true;
    }
    try {
      execFileSync('wl-copy', [], { input: text });
      return true;
    } catch {
      execFileSync('xclip', ['-selection', 'clipboard'], { input: text });
      return true;
    }
  } catch {
    return false;
  }
}

function App(props: {
  agent: unknown;
  packageJson: Record<string, unknown>;
}) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [spinnerIndex, setSpinnerIndex] = createSignal(0);
  const [exitHint, setExitHint] = createSignal(false);
  const [copyHint, setCopyHint] = createSignal<string | null>(null);
  const [chatInputHeight, setChatInputHeight] = createSignal(3);
  let ctrlCTimer: ReturnType<typeof setTimeout> | null = null;
  let copyHintTimer: ReturnType<typeof setTimeout> | null = null;
  let selectionCopyTimer: ReturnType<typeof setTimeout> | null = null;
  let lastCopiedSelection = '';
  const state = useSession(props);
  const conversationRows = createMemo(() => Math.max(4, dimensions().height - 5 - chatInputHeight()));
  const rightColumns = createMemo(() => {
    const width = dimensions().width;
    return Math.max(26, Math.min(44, Math.floor(width * 0.32)));
  });
  const leftColumns = createMemo(() => Math.max(32, dimensions().width - rightColumns() - 1));
  const conversationColumns = createMemo(() => {
    return Math.max(24, leftColumns() - 4);
  });
  const submit = (value?: string) => {
    if (state.slash()) {
      state.completeSelected();
      return;
    }
    void state.submitInput(value).then((result) => {
      if (result?.exit) renderer.destroy();
    });
  };

  const showCopyHint = (message: string) => {
    setCopyHint(message);
    if (copyHintTimer) clearTimeout(copyHintTimer);
    copyHintTimer = setTimeout(() => { setCopyHint(null); copyHintTimer = null; }, 1400);
  };

  useSelectionHandler((selection: any) => {
    const text = String(selection?.getSelectedText?.() ?? '').trimEnd();
    if (!text.trim()) return;
    if (selectionCopyTimer) clearTimeout(selectionCopyTimer);
    selectionCopyTimer = setTimeout(() => {
      selectionCopyTimer = null;
      if (text === lastCopiedSelection) return;
      lastCopiedSelection = text;
      showCopyHint(copyToClipboard(text, renderer) ? 'Selection copied.' : 'Selection ready. Use terminal copy.');
    }, selection?.isDragging ? 700 : 80);
  });

  onCleanup(() => {
    if (copyHintTimer) clearTimeout(copyHintTimer);
    if (selectionCopyTimer) clearTimeout(selectionCopyTimer);
  });

  const spinnerTimer = setInterval(() => {
    if (state.busy()) setSpinnerIndex((value) => (value + 1) % 10);
  }, 90);
  onCleanup(() => {
    clearInterval(spinnerTimer);
    if (ctrlCTimer) clearTimeout(ctrlCTimer);
  });

  useKeyboard((key) => {
    const keyName = String(key.name ?? '').toLowerCase();
    if (state.activeEditor()) {
      if (keyName === 'escape') state.closeEditor();
      return;
    }
    if ((key.ctrl || key.meta) && keyName === 'c') {
      if (state.busy()) {
        state.abort();
        return;
      }
      if (exitHint()) {
        renderer.destroy();
        return;
      }
      setExitHint(true);
      if (ctrlCTimer) clearTimeout(ctrlCTimer);
      ctrlCTimer = setTimeout(() => {
        setExitHint(false);
        ctrlCTimer = null;
      }, 1600);
      return;
    }
    if (key.ctrl && keyName === 'q') {
      state.toggleRightTab();
      return;
    }
    if (state.busy()) return;
    if (keyName === 'tab') state.completeSelected();
    if (keyName === 'pageup') state.scrollConversation(conversationRows());
    else if (keyName === 'pagedown') state.scrollConversation(-conversationRows());
    if (keyName === 'up' && state.slash()) state.moveCompletion(-1);
    else if (keyName === 'down' && state.slash()) state.moveCompletion(1);
    else if (keyName === 'up' && !state.input().includes('\n')) state.historyUp();
    else if (keyName === 'down' && !state.input().includes('\n')) state.historyDown();
    else if (keyName === 'escape') {
      if (state.slash()) state.dismissSlash();
      else state.setInput('');
    }
  });

  const hintLine = () => {
    if (copyHint()) return copyHint();
    if (exitHint()) return 'Press Ctrl+C again to exit.';
    return null;
  };

  return (
    <box width="100%" height="100%" flexDirection="row">
      <LeftPane
        width={leftColumns()}
        title={state.title()}
        statusLine={state.statusLine()}
        hintLine={hintLine()}
        showWelcome={state.showWelcome()}
        messages={state.messages()}
        prompt={state.prompt()}
        input={state.input()}
        busy={state.busy()}
        chatMode={state.chatMode()}
        chatFocused={!state.activeEditor()}
        setInput={state.setInput}
        submit={submit}
        conversationRows={conversationRows()}
        conversationColumns={conversationColumns()}
        conversationScroll={state.conversationScroll()}
        scrollConversation={state.scrollConversation}
        spinnerFrame={SPINNER_FRAMES[spinnerIndex()] ?? SPINNER_FRAMES[0]}
        onInputHeightChange={setChatInputHeight}
        onCopy={(content) => showCopyHint(copyToClipboard(content, renderer) ? 'Copied.' : 'Copy failed.')}
      />
      <box width={1} height="100%" flexDirection="column">
        {Array.from({ length: dimensions().height }, () => (
          <text fg="#4B5563">│</text>
        ))}
      </box>
      <RightPane
        width={rightColumns()}
        activities={state.activities()}
        logs={state.logs()}
        plan={state.plan()}
        queueItems={state.queueItems()}
        queueInfo={state.queueInfo()}
        activeTab={state.rightTab()}
        onTabClick={state.selectRightTab}
      />
      <SlashDialog context={state.activeEditor() ? null : state.slash()} />
      <FileEditorDialog
        editor={state.activeEditor()}
        width={dimensions().width}
        height={dimensions().height}
        onSave={state.saveEditor}
        onCancel={state.closeEditor}
      />
    </box>
  );
}

export async function runOpenTuiShell({
  agent,
  packageJson,
}: {
  agent: unknown;
  packageJson: Record<string, unknown>;
}) {
  await render(() => <App agent={agent} packageJson={packageJson} />, {
    exitOnCtrlC: false,
    useMouse: true,
    targetFps: 30,
  });
  return {};
}

function WizardApp(props: {
  mode: 'startup' | 'setup';
  gaps?: any[];
  initialWorkspaceName?: string;
  initialWorkspacePath?: string | null;
  onDone: () => void;
}) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const close = () => {
    props.onDone();
    renderer.destroy();
  };
  return (
    <box width="100%" height="100%" backgroundColor="#0B0D12">
      <SetupWizard
        mode={props.mode}
        session={{}}
        gaps={props.gaps}
        width={dimensions().width}
        height={dimensions().height}
        initialRoute={props.mode === 'setup' ? 'workspace-name' : undefined}
        initialWorkspaceName={props.initialWorkspaceName}
        initialWorkspacePath={props.initialWorkspacePath ?? null}
        closeOnDone={props.mode === 'setup'}
        onComplete={close}
        onClose={close}
      />
    </box>
  );
}

export async function runStartupWizard(gaps: any[]) {
  if (!gaps.length) return;
  await new Promise<void>((resolve, reject) => {
    render(() => <WizardApp mode="startup" gaps={gaps} onDone={resolve} />, {
      exitOnCtrlC: false,
      useMouse: true,
      targetFps: 30,
    }).catch(reject);
  });
}

export async function runSetupWizard(options: { workspaceName?: string; workspacePath?: string | null } = {}) {
  await new Promise<void>((resolve, reject) => {
    render(() => (
      <WizardApp
        mode="setup"
        initialWorkspaceName={options.workspaceName}
        initialWorkspacePath={options.workspacePath ?? null}
        onDone={resolve}
      />
    ), {
      exitOnCtrlC: false,
      useMouse: true,
      targetFps: 30,
    }).catch(reject);
  });
}
