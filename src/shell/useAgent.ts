import { createSignal } from 'solid-js';
import { postRuntimeCancel } from '../runtime/client.js';
import { conversationMessages, recordRuntimeUnavailableAgentInput, runLine, shouldHandleFreeTextLocally, submitRuntimeRun } from './repl.js';

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
        const outcome = await submitRuntimeRun(trimmed, {
          runtime: { url: props.runtimeUrl },
          session: props.session,
        });
        if (outcome.kind === 'accepted') {
          props.onRuntimeAccepted?.();
          const runId = (outcome as any).result?.runId ?? null;
          // Light, immediate feedback in the chat: without it an accepted run
          // is invisible until its first activity lands in the side panels.
          conversationMessages(props.session).push({
            role: 'command',
            content: `▶ Run accepté${runId ? ` (${String(runId).slice(0, 8)})` : ''} — progression dans le panneau Activity, réponse ici à la fin du run.`,
          });
          props.addLog('runtime: run accepted');
        } else if (outcome.kind === 'queued') {
          // The server localizes control-lane acknowledgements from the
          // session language (src/runtime/controlMessages.js) — always prefer
          // its explanation over a local hardcoded string.
          const explanation = (outcome as any).result?.explanation ?? 'Request added to the queue.';
          conversationMessages(props.session).push({ role: 'command', content: String(explanation) });
          props.addLog('runtime: control queued');
        } else if ((outcome as any).result?.explanation) {
          // Control-lane kinds (cancel / approve / observe / modify_run…):
          // surface the server's localized explanation instead of an error.
          conversationMessages(props.session).push({ role: 'command', content: String((outcome as any).result.explanation) });
          props.addLog(`runtime: ${outcome.kind}`);
        } else {
          conversationMessages(props.session).push({ role: 'command', content: `Runtime error: ${outcome.message}` });
          props.addLog(`runtime error: ${outcome.message}`);
        }
        props.refresh();
        return { exit: false, runtime: true };
      }
      if (!props.chatMode() && !trimmed.startsWith('/') && !freeTextRouting?.local) {
        const message = recordRuntimeUnavailableAgentInput(props.session, trimmed, {
          error: props.runtimeUnavailableReason ?? 'runtime introuvable',
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
