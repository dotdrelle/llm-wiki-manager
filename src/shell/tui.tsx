/** @jsxImportSource @opentui/solid */
import { execFileSync } from 'node:child_process';
import { render, useKeyboard, useRenderer, useSelectionHandler, useTerminalDimensions } from '@opentui/solid';
import { createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { FileEditorDialog } from './FileEditorDialog';
import { LeftPane } from './LeftPane';
import { RightPane } from './RightPane';
import { SlashDialog } from './SlashDialog';
import { SetupWizard } from './SetupWizard';
import { StartupScreen, type StartupAction } from './StartupScreen';
import { useSession } from './useSession';
import { buildMcpStatus } from '../core/mcp.js';
import { loadWikircProfile, summarizeWikircConfig } from '../core/wikirc.js';
import { listWorkspaces } from '../core/workspaces.js';
import { runPreflightChecks, withRuntimePreflight } from '../core/startupCheck.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function emptyStartupInfo(version: string, workspace: { name: string } | null, workspaces: { name: string }[]) {
  return {
    version,
    model: '',
    connectedMcpServers: 0,
    wikiReady: false,
    workspaceName: workspace?.name ?? null,
    profileName: 'default',
    workspaces: workspaces.map((item) => item.name),
    hasWorkspace: workspace != null,
  };
}

function startupInfo(packageJson: Record<string, unknown>, preferredWorkspaceName?: string | null) {
  // listWorkspaces() order is filesystem-dependent (readdirSync), not stable —
  // sort so "the default workspace" is deterministic across runs/platforms.
  const workspaces = [...listWorkspaces()].sort((a, b) => a.name.localeCompare(b.name));
  const workspace = preferredWorkspaceName
    ? workspaces.find((item) => item.name === preferredWorkspaceName) ?? null
    : workspaces[0] ?? null;
  const version = String(packageJson.version ?? '');
  if (!workspace) return emptyStartupInfo(version, null, []);

  try {
    const loaded = loadWikircProfile(workspace.workspacePath, 'default');
    const summary = summarizeWikircConfig(loaded.profile, loaded.config);
    const session = {
      workspace: workspace.name,
      workspacePath: workspace.workspacePath,
      workspaceEnv: workspace.env,
      wikirc: {
        profile: loaded.profile.name,
        fileName: loaded.profile.fileName,
        path: loaded.profile.path,
      },
      wikircConfig: loaded.config,
    };
    const mcp = buildMcpStatus(session);
    const connectedMcpServers = Object.values(mcp)
      .filter((server: any) => server?.status && server.status !== 'missing')
      .length;
    const provider = summary.provider ? String(summary.provider) : '';
    const model = summary.model ? String(summary.model) : '';
    return {
      version,
      model: [provider, model].filter(Boolean).join(' / '),
      connectedMcpServers,
      wikiReady: true,
      workspaceName: workspace.name,
      profileName: loaded.profile.name,
      workspaces: workspaces.map((item) => item.name),
      hasWorkspace: true,
    };
  } catch {
    return emptyStartupInfo(version, workspace, workspaces);
  }
}

function copyToClipboard(text: string, renderer: unknown) {
  try {
    const osc52 = (renderer as any).copyToClipboardOSC52;
    if (typeof osc52 === 'function') {
      osc52.call(renderer, text);
      return true;
    }
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
  runtime?: any;
  preflight?: any;
  initialWorkspaceName?: string | null;
  // Shared handle the shell awaits after onDestroy resolves. One ref instead of
  // two same-named `exitTask` bindings wired through a setter callback.
  exitRef?: { current: Promise<void> };
}) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [spinnerIndex, setSpinnerIndex] = createSignal(0);
  const [exitHint, setExitHint] = createSignal(false);
  const [exitStatus, setExitStatus] = createSignal<string | null>(null);
  const [copyHint, setCopyHint] = createSignal<string | null>(null);
  const [chatInputHeight, setChatInputHeight] = createSignal(3);
  const [startupKeyboardEvent, setStartupKeyboardEvent] = createSignal<{ id: number; key: any } | null>(null);
  // The app has exactly three mutually exclusive screens; one signal makes
  // that invariant structural instead of relying on two booleans staying in
  // sync at every call site.
  const [screen, setScreen] = createSignal<'startup' | 'setup' | 'main'>('startup');
  const [preflight, setPreflight] = createSignal(props.preflight ?? { status: 'degraded', checks: [] });
  const [preflightBusy, setPreflightBusy] = createSignal(false);
  let ctrlCTimer: ReturnType<typeof setTimeout> | null = null;
  let exiting = false;
  // Single exit path: the owned-runtime shutdown MUST happen here, on the
  // user's actual exit gesture. render() resolves at MOUNT, so code placed
  // after `await runOpenTuiShell(...)` runs while the shell is still on
  // screen — 0.12.9 shipped that and killed the runtime mid-session.
  const exitShell = () => {
    if (exiting) return;
    exiting = true;
    setExitStatus('Fermeture enclenchée…');
    // Register the complete shutdown before destroying the renderer: onDestroy
    // resolves runOpenTuiShell, which must still await this cleanup task.
    const task = Promise.resolve().then(async () => {
      renderer.destroy();
      console.log('[wiki-manager] fermeture enclenchée — nettoyage en cours…');
      const messages: string[] = [];
      try {
        if (props.runtime?.url) {
          const { shutdownOwnedRuntime } = await import('../runtime/lifecycle.js');
          await shutdownOwnedRuntime(props.runtime, { log: (message: string) => { messages.push(message); } });
        }
      } catch {
        // Best effort: never block the exit on runtime cleanup.
      }
      for (const message of messages) console.log(`[wiki-manager] ${message}`);
      console.log('[wiki-manager] fermeture terminée — shell clos proprement.');
    });
    if (props.exitRef) props.exitRef.current = task;
  };
  let copyHintTimer: ReturnType<typeof setTimeout> | null = null;
  let selectionCopyTimer: ReturnType<typeof setTimeout> | null = null;
  let startupKeyboardEventId = 0;
  let lastCopiedSelection = '';
  const state = useSession(props);
  const startup = createMemo(() => startupInfo(props.packageJson, props.initialWorkspaceName));
  const conversationRows = createMemo(() => Math.max(4, dimensions().height - 5 - chatInputHeight()));
  const rightColumns = createMemo(() => {
    const width = dimensions().width;
    // 38% + 2 columns / cap 58: the Plan/Activity/Logs panes carry job
    // labels, file names and error messages — 40 columns truncated everything
    // into unreadable stubs. The small addition uses the terminal's right-side
    // slack without making the conversation pane noticeably narrower.
    return Math.max(32, Math.min(58, Math.floor(width * 0.38) + 2));
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
      if (result?.exit) exitShell();
    });
  };

  const loadWorkspace = async (workspaceName?: string | null) => {
    if (!workspaceName) return false;
    if ((state.session as any).workspace === workspaceName) return true;
    await state.submitInput(`/use ${workspaceName}`);
    // /use does not throw on failure (e.g. a stale/deleted workspace) — it
    // just returns an error message without switching session.workspace, so
    // callers must check the actual post-await state rather than assume success.
    return (state.session as any).workspace === workspaceName;
  };

  // `startup` is a memo over non-reactive fs reads (listWorkspaces() etc.),
  // so it only ever reflects state at first mount. Action handlers that
  // decide *which* workspace to load must re-read current state directly
  // (startupInfo(...)) rather than trust the frozen memo, the same way
  // closeSetup() already does.
  const loadDefaultWorkspace = async () => loadWorkspace(startupInfo(props.packageJson, props.initialWorkspaceName).workspaceName);

  // The canonical status is the first useful view after entering ShellUI.
  // Run it only after /use has established the workspace so config, services,
  // MCP connectivity and runtime state are all reported in the same snapshot.
  const showDefaultStatus = async (workspaceLoaded: boolean) => {
    if (workspaceLoaded) await state.submitInput('/status');
  };

  const refreshPreflight = async () => {
    setPreflightBusy(true);
    try {
      const next = await runPreflightChecks();
      setPreflight(withRuntimePreflight(next, props.runtime));
    } finally {
      setPreflightBusy(false);
    }
  };

  const openAction = (action: StartupAction, workspaceName?: string) => {
    if (action === 'init-workspace') {
      setScreen('setup');
      return;
    }
    if (action === 'retry-preflight') {
      void refreshPreflight();
      return;
    }
    setScreen('main');
    void (async () => {
      try {
        if (action === 'open-workspace') {
          const loaded = await loadWorkspace(workspaceName ?? startupInfo(props.packageJson, props.initialWorkspaceName).workspaceName);
          await showDefaultStatus(loaded);
        } else if (action === 'new-conversation' || action === 'run-workflow') {
          const loaded = await loadDefaultWorkspace();
          await showDefaultStatus(loaded);
          if (action === 'run-workflow' && loaded) {
            await state.submitInput('/agent');
          }
        }
      } catch {
        // Individual submitInput failures already surface their own error
        // text in the conversation transcript; just stop the sequence here
        // instead of leaving an unhandled rejection.
      }
    })();
  };

  const closeSetup = () => {
    const info = startupInfo(props.packageJson, props.initialWorkspaceName);
    if (!info.hasWorkspace) {
      setScreen('startup');
      return;
    }
    setScreen('main');
    // Reuse loadWorkspace (not a bare /use dispatch) so the "already on this
    // workspace" short-circuit applies here too.
    void loadWorkspace(info.workspaceName).then(showDefaultStatus);
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
    if (screen() === 'startup') {
      startupKeyboardEventId += 1;
      setStartupKeyboardEvent({ id: startupKeyboardEventId, key });
      return;
    }
    if (screen() !== 'main') return;
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
        exitShell();
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
    if ((keyName === 'up' || keyName === 'down') && (state.slash() || !state.input().includes('\n'))) {
      // The Plan scrollbox also listens to global arrow keys. Consume arrows
      // handled by the chat input so one key press cannot move both widgets.
      key.preventDefault?.();
      key.stopPropagation?.();
      if (state.slash()) state.moveCompletion(keyName === 'up' ? -1 : 1);
      else if (keyName === 'up') state.historyUp();
      else state.historyDown();
      return;
    }
    if (keyName === 'escape') {
      if (state.slash()) state.dismissSlash();
      else state.setInput('');
    }
  });

  const hintLine = () => {
    if (exitStatus()) return exitStatus();
    if (copyHint()) return copyHint();
    if (exitHint()) return 'Press Ctrl+C again to exit.';
    if (state.runtimeHint()) return state.runtimeHint();
    return null;
  };

  return (
    <Show
      when={screen() === 'startup'}
      fallback={
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
            logFilter={state.runtimeLogFilter()}
            pendingApprovals={state.pendingApprovals()}
            onApprove={() => { void state.submitInput('/approve'); }}
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
          {screen() === 'setup' ? (
            <SetupWizard
              mode="setup"
              session={state.session}
              width={dimensions().width}
              height={dimensions().height}
              initialRoute="workspace-name"
              closeOnDone
              onComplete={closeSetup}
              onClose={closeSetup}
            />
          ) : null}
        </box>
      }
    >
      <StartupScreen
        version={startup().version}
        model={startup().model}
        connectedMcpServers={startup().connectedMcpServers}
        wikiReady={startup().wikiReady}
        workspaceName={startup().workspaceName}
        profileName={startup().profileName}
        workspaces={startup().workspaces}
        hasWorkspace={startup().hasWorkspace}
        preflight={preflight()}
        preflightBusy={preflightBusy()}
        width={dimensions().width}
        height={dimensions().height}
        keyboardEvent={startupKeyboardEvent()}
        onSelect={openAction}
        onQuit={() => exitShell()}
      />
    </Show>
  );
}

export async function runOpenTuiShell({
  agent,
  packageJson,
  runtime = null,
  preflight = null,
  initialWorkspaceName = null,
}: {
  agent: unknown;
  packageJson: Record<string, unknown>;
  runtime?: any;
  preflight?: any;
  initialWorkspaceName?: string | null;
}) {
  const exitRef = { current: Promise.resolve() as Promise<void> };
  await new Promise<void>((resolve, reject) => {
    render(() => (
      <App
        agent={agent}
        packageJson={packageJson}
        runtime={runtime}
        preflight={preflight}
        initialWorkspaceName={initialWorkspaceName}
        exitRef={exitRef}
      />
    ), {
      exitOnCtrlC: false,
      useMouse: true,
      targetFps: 30,
      onDestroy: resolve,
    }).catch(reject);
  });
  await exitRef.current;
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
