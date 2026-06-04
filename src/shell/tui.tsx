import { render, useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/solid';
import { createMemo, createSignal, onCleanup } from 'solid-js';
import { LeftPane } from './LeftPane';
import { RightPane } from './RightPane';
import { SlashDialog } from './SlashDialog';
import { useSession } from './useSession';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function App(props: { agent: unknown; packageJson: Record<string, unknown> }) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [spinnerIndex, setSpinnerIndex] = createSignal(0);
  const state = useSession(props);
  const conversationRows = createMemo(() => Math.max(4, dimensions().height - 7));
  const rightColumns = createMemo(() => {
    const width = dimensions().width;
    return Math.max(26, Math.min(44, Math.floor(width * 0.32)));
  });
  const leftColumns = createMemo(() => Math.max(32, dimensions().width - rightColumns() - 1));
  const conversationColumns = createMemo(() => {
    return Math.max(24, leftColumns() - 4);
  });
  const submit = (value?: string) => {
    void state.submitInput(value).then((result) => {
      if (result?.exit) renderer.destroy();
    });
  };

  const spinnerTimer = setInterval(() => {
    if (state.busy()) setSpinnerIndex((value) => (value + 1) % 10);
  }, 90);
  onCleanup(() => clearInterval(spinnerTimer));

  useKeyboard((key) => {
    if (key.ctrl && key.name === 'c') {
      if (state.busy()) state.abort();
      else renderer.destroy();
      return;
    }
    if (state.busy()) return;
    if (key.name === 'tab') state.completeSelected();
    if (key.name === 'pageup') state.scrollConversation(conversationRows());
    else if (key.name === 'pagedown') state.scrollConversation(-conversationRows());
    if (key.name === 'up' && state.slash()) state.moveCompletion(-1);
    else if (key.name === 'down' && state.slash()) state.moveCompletion(1);
    else if (key.name === 'up') state.historyUp();
    else if (key.name === 'down') state.historyDown();
    else if (key.name === 'escape') {
      if (state.slash()) state.dismissSlash();
      else state.setInput('');
    }
  });

  return (
    <box width="100%" height="100%" flexDirection="row">
      <LeftPane
        width={leftColumns()}
        title={state.title()}
        statusLine={state.statusLine()}
        messages={state.messages()}
        prompt={state.prompt()}
        input={state.input()}
        busy={state.busy()}
        setInput={state.setInput}
        submit={submit}
        conversationRows={conversationRows()}
        conversationColumns={conversationColumns()}
        conversationScroll={state.conversationScroll()}
        scrollConversation={state.scrollConversation}
        spinnerFrame={SPINNER_FRAMES[spinnerIndex()] ?? SPINNER_FRAMES[0]}
      />
      <box width={1} height="100%" flexDirection="column">
        {Array.from({ length: dimensions().height }, () => (
          <text fg="#4B5563">│</text>
        ))}
      </box>
      <RightPane width={rightColumns()} servers={state.mcpServers()} logs={state.logs()} />
      <SlashDialog context={state.slash()} />
    </box>
  );
}

export async function runOpenTuiShell({ agent, packageJson }: { agent: unknown; packageJson: Record<string, unknown> }) {
  await render(() => <App agent={agent} packageJson={packageJson} />, {
    exitOnCtrlC: false,
    targetFps: 30,
  });
}
