import { createSignal } from 'solid-js';
import { postRuntimeCancel } from '../runtime/client.js';
import { conversationMessages, recordRuntimeUnavailableAgentInput, runLine, submitRuntimeRun } from './repl.js';

export function useAgent(props: { agent: unknown; packageJson: Record<string, unknown>; session: Record<string, any>; chatMode: () => boolean; runtimeUrl?: string | null; runtimeUnavailableReason?: string | null; refresh: () => void; addLog: (line: string) => void; onRuntimeAccepted?: () => void }) {
  const [busy, setBusy] = createSignal(false);
  const [abortController, setAbortController] = createSignal<AbortController | null>(null);

  async function submit(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return { exit: false };
    if (busy()) return { exit: false, busy: true };

    const controller = new AbortController();
    setAbortController(controller);
    props.session._abortSignal = controller.signal;
    setBusy(true);
    props.addLog(`input: ${trimmed}`);

    try {
      if (props.runtimeUrl && !props.chatMode() && !trimmed.startsWith('/')) {
        // Marked _pending so mergeRuntimeConversation (useSession.ts) can
        // confirm this exact entry instead of pushing a second copy once the
        // same user message comes back from the runtime's own /state.
        conversationMessages(props.session).push({ role: 'user', content: trimmed, _pending: true });
        const outcome = await submitRuntimeRun(trimmed, {
          runtime: { url: props.runtimeUrl },
          session: props.session,
        });
        if (outcome.kind === 'accepted') {
          props.onRuntimeAccepted?.();
          props.addLog('runtime: run accepted');
        } else if (outcome.kind === 'queued') {
          // The server localizes control-lane acknowledgements from the
          // session language (src/runtime/controlMessages.js) — always prefer
          // its explanation over a local hardcoded string.
          const explanation = (outcome as any).result?.explanation ?? 'Request added to the queue.';
          conversationMessages(props.session).push({ role: 'command', content: String(explanation) });
          props.addLog('runtime: control queued');
        } else {
          conversationMessages(props.session).push({ role: 'command', content: `Runtime error: ${outcome.message}` });
          props.addLog(`runtime error: ${outcome.message}`);
        }
        props.refresh();
        return { exit: false, runtime: true };
      }
      if (!props.chatMode() && !trimmed.startsWith('/')) {
        const message = recordRuntimeUnavailableAgentInput(props.session, trimmed, {
          error: props.runtimeUnavailableReason ?? 'runtime introuvable',
        });
        props.addLog(message ?? 'runtime: disconnected');
        props.refresh();
        return { exit: false, runtimeUnavailable: true };
      }
      const result = await runLine(trimmed, {
        agent: props.agent,
        packageJson: props.packageJson,
        session: props.session,
        onUpdate: props.refresh,
        onStep: props.addLog,
        chatMode: props.chatMode(),
      });
      props.refresh();
      return result;
    } catch (err: any) {
      if (err?.name === 'AbortError') return { exit: false, aborted: true };
      props.addLog(`error: ${err instanceof Error ? err.message : String(err)}`);
      return { exit: false };
    } finally {
      delete props.session._abortSignal;
      setAbortController(null);
      setBusy(false);
    }
  }

  function abort() {
    if (props.runtimeUrl) {
      void postRuntimeCancel({ url: props.runtimeUrl, workspace: props.session.workspace ?? null })
        .then(() => props.addLog('runtime: cancel requested'))
        .catch((err) => props.addLog(`runtime cancel error: ${err instanceof Error ? err.message : String(err)}`));
    }
    abortController()?.abort();
    props.addLog('interrupt requested');
  }

  return { busy, submit, abort };
}
