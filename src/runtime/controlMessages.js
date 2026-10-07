// Short fallback facts for the runtime control lane. User-facing control
// results are phrased by Donna in server.js; these strings are never sent to
// the conversational UI as system messages.

const CONTROL_MESSAGES = {
  queued_for_future_run: 'Request added to the queue — it will start automatically after the current run.',
  control_run_started: 'A queued request is now starting.',
  plan_patch_proposed: 'Plan patch proposed. Approve it explicitly to apply it to the active plan.',
  ambiguous_control: 'A run is already active, and this looks like a new action. Say "queue it" to run it after the current run, "modify the run" to change the active plan, "cancel" to stop the current run first — or wait for it to finish.',
  converse_while_running: 'Runtime run is still active. This message was treated as conversation and did not create a queued run.',
  converse_while_idle: 'Runtime is idle. This message was treated as conversation and did not create a run.',
};

export function controlMessage(_session, key) {
  const entry = CONTROL_MESSAGES[key];
  if (!entry) throw new Error(`Unknown control message key: ${key}`);
  return entry;
}
