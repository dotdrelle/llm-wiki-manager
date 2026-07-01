import { createSignal } from 'solid-js';
import { postRuntimeCancel, postRuntimeRun } from '../runtime/client.js';
import { conversationMessages, runLine } from './repl.js';

export function useAgent(props: { agent: unknown; packageJson: Record<string, unknown>; session: Record<string, any>; chatMode: () => boolean; runtimeUrl?: string | null; refresh: () => void; addLog: (line: string) => void; onRuntimeAccepted?: () => void }) {
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
        await postRuntimeRun(trimmed, {
          url: props.runtimeUrl,
          workspace: props.session.workspace ?? null,
        });
        conversationMessages(props.session).push({ role: 'user', content: trimmed });
        conversationMessages(props.session).push({ role: 'command', content: `Runtime run queued: ${props.runtimeUrl}` });
        props.onRuntimeAccepted?.();
        props.addLog('runtime: run accepted');
        props.refresh();
        return { exit: false, runtime: true };
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
      void postRuntimeCancel({ url: props.runtimeUrl })
        .then(() => props.addLog('runtime: cancel requested'))
        .catch((err) => props.addLog(`runtime cancel error: ${err instanceof Error ? err.message : String(err)}`));
    }
    abortController()?.abort();
    props.addLog('interrupt requested');
  }

  return { busy, submit, abort };
}
