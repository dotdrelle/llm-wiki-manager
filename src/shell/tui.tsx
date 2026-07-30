/** @jsxImportSource @opentui/solid */
import { execFileSync } from 'node:child_process';
import { render, useKeyboard, useRenderer, useSelectionHandler, useTerminalDimensions } from '@opentui/solid';
import { createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { FileEditorDialog } from './FileEditorDialog';
import { LeftPane } from './LeftPane';
import { openExternalUrl } from './openExternal.js';
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

// Ordered from verifiable to hopeful. Each entry is [command, args].
function clipboardCommands(): Array<[string, string[]]> {
  if (process.platform === 'darwin') return [['pbcopy', []]];
  if (process.platform === 'win32') return [['clip', []]];
  return [
    ['wl-copy', []],
    // `xsel` before `xclip`: xclip must keep running to own the X selection and
    // inherits our stdio, so execFileSync waits on pipes that never close and
    // the whole ShellUI freezes. xsel forks and releases them.
    ['xsel', ['--clipboard', '--input']],
    ['xclip', ['-selection', 'clipboard']],
  ];
}

function copyToClipboard(text: string, renderer: unknown) {
  // Local tools first, OSC 52 last. OSC 52 used to win by default and always
  // reported success, because writing an escape sequence cannot fail: on
  // GNOME Terminal / VTE, which does not implement it, the sequence was
  // swallowed and the ShellUI cheerfully announced "Copied." with an unchanged
  // clipboard. Selection-copy appeared to work only because the terminal
  // itself copies selections, without going through this code at all.
  for (const [command, args] of clipboardCommands()) {
    try {
      execFileSync(command, args, {
        input: text,
        // Never inherit stdout/stderr: see the xclip note above.
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: 2_000,
      });
      return true;
    } catch {
      // Missing binary, wrong display server, or timeout: try the next one.
    }
  }
  // Nothing local worked. Over SSH or in a terminal that supports it, OSC 52
  // is the only remaining option — but it is fire-and-forget, so it is also
  // the only case where we cannot promise the clipboard was actually written.
  try {
    const osc52 = (renderer as any).copyToClipboardOSC52;
    if (typeof osc52 === 'function') {
      osc52.call(renderer, text);
      return true;
    }
  } catch {
    // Renderer without OSC 52 support.
  }
  return false;
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
  // The runtime is shared infrastructure: `llm-wiki serve` can still be using
  // it after this shell closes. Exiting the UI only destroys the renderer;
  // explicit lifecycle commands own runtime shutdown.
  const exitShell = () => {
    if (exiting) return;
    exiting = true;
    setExitStatus('Fermeture enclenchée…');
    const task = Promise.resolve().then(async () => {
      renderer.destroy();
      console.log('[wiki-manager] shell closed; shared runtime left running.');
      // MCP clients, image-refresh probes, and reconnect timers may still own
      // event-loop handles. They belong to this shell process, not to the
      // detached shared runtime. Once the renderer is gone there is no useful
      // foreground work left, so terminate explicitly instead of leaving the
      // terminal pending indefinitely.
      process.exit(0);
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
    // Advance while the chat is streaming OR a runtime run is executing. Without
    // executionActive(), the plan spinner froze on frame 0 during a scheduler-
    // driven run (no conversation turn), so it looked static.
    if (state.busy() || state.executionActive()) setSpinnerIndex((value) => (value + 1) % 10);
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
            onCopy={(content) => showCopyHint(
              copyToClipboard(content, renderer)
                ? 'Copied.'
                // Actionable, because the fix is one package away: on Linux the
                // clipboard needs wl-copy (Wayland) or xsel/xclip (X11).
                : 'Copy failed — install wl-copy, xsel or xclip.',
            )}
            onOpenLink={(url) => {
              if (openExternalUrl(url)) return showCopyHint(`Opening ${url}`);
              // No usable opener on this machine (headless, container, no
              // xdg-utils). Leave the operator something actionable instead of
              // the silent no-op that made links look broken.
              showCopyHint(copyToClipboard(url, renderer) ? `No browser opener — copied ${url}` : `No browser opener — open ${url}`);
            }}
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
            runSummary={state.runSummary()}
            queueItems={state.queueItems()}
            queueInfo={state.queueInfo()}
            activeTab={state.rightTab()}
            logFilter={state.runtimeLogFilter()}
            pendingApprovals={state.pendingApprovals()}
            onApprove={() => { void state.submitInput('/approve'); }}
            onTabClick={state.selectRightTab}
            spinnerFrame={SPINNER_FRAMES[spinnerIndex()] ?? SPINNER_FRAMES[0]}
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
