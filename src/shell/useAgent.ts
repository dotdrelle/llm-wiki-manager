import { createSignal } from 'solid-js';
import { postRuntimeCancel } from '../runtime/client.js';
import { applyRuntimeOutcome, conversationMessages, recordRuntimeUnavailableAgentInput, runLine, shouldHandleFreeTextLocally, submitRuntimeTurn } from './repl.js';

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
      // Questions and small talk are answered by the local agent: the reply
      // shows up in the chat immediately and no runtime run (plan, SQLite
      // state, replans) is created for a sentence that only needed an answer.
      // Actions still go to the runtime below.
      const freeTextRouting = (props.runtimeUrl && !props.chatMode() && !trimmed.startsWith('/'))
        ? shouldHandleFreeTextLocally(trimmed, props.session)
        : null;
      if (props.runtimeUrl && !props.chatMode() && !trimmed.startsWith('/') && !freeTextRouting?.local) {
        if (freeTextRouting?.fallbackReason) {
          props.addLog(`runtime: ${freeTextRouting.fallbackReason}, routing to runtime run`);
        }
        // Marked _pending so mergeRuntimeConversation (useSession.ts) can
        // confirm this exact entry instead of pushing a second copy once the
        // same user message comes back from the runtime's own /state.
        conversationMessages(props.session).push({ role: 'user', content: trimmed, _pending: true });
        // Let Donna decide while the runtime is still idle. If the objective
        // maps to an agent capability, runtime__delegate then starts the real
        // run. Posting natural language straight to /run made that run active
        // too early and intentionally hid delegation after a status check.
        const outcome = await submitRuntimeTurn(trimmed, {
          runtime: { url: props.runtimeUrl },
          session: props.session,
        });
        // Same classification → message mapping as the legacy TTY shell —
        // see applyRuntimeOutcome in repl.js. Control-lane acknowledgements
        // (src/runtime/controlMessages.js) are deterministic and English-only
        // by design, never localized; this only supplies the last-resort
        // fallback text for a response that carries neither.
        applyRuntimeOutcome(props.session, outcome, props.addLog);
        props.refresh();
        return { exit: false, runtime: true };
      }
      if (!props.chatMode() && !trimmed.startsWith('/') && !freeTextRouting?.local) {
        const message = recordRuntimeUnavailableAgentInput(props.session, trimmed, {
          error: props.runtimeUnavailableReason ?? 'runtime unavailable',
        });
        props.addLog(message ?? 'runtime: disconnected');
        props.refresh();
        return { exit: false, runtimeUnavailable: true };
      }
      if (freeTextRouting?.local) {
        props.addLog(`agent: ${freeTextRouting.classification.kind} handled locally`);
      }
      const result = await runLine(trimmed, {
        agent: props.agent,
        packageJson: props.packageJson,
        session: props.session,
        onUpdate: props.refresh,
        onStep: props.addLog,
        chatMode: props.chatMode(),
        // Without this, slash commands that target the runtime (/run kill,
        // /run cancel, /run status) reported "Runtime unavailable" in the
        // TUI even while the status bar showed "runtime: connected".
        runtime: props.runtimeUrl ? { url: props.runtimeUrl } : null,
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
