/*
 The subagent timeline: one reducer-owned list, two producers (the external
 runtime's collective and Donna's own read-only subagent).

 Kept out of agentEvents.js so the event switch stays a switch, and so the
 start/step/finish rules can be tested without dispatching events.
*/

function findEntry(list, payload) {
  const name = String(payload?.subagent ?? 'subagent');
  const id = String(payload?.subagentId ?? name);
  let index = list.findLastIndex((item) => (item.id ?? item.subagent) === id);
  if (index < 0) index = list.findLastIndex((item) => item.subagent === name && item.status === 'running');
  return { index, name, id };
}

export function startSubagent(list, payload, ts) {
  const name = String(payload?.subagent ?? 'subagent');
  const id = String(payload?.subagentId ?? name);
  return [
    ...(list ?? []),
    {
      id,
      subagent: name,
      status: 'running',
      startedAt: ts,
      objective: payload?.objective ? String(payload.objective).slice(0, 600) : null,
      maxSteps: Number(payload?.maxSteps) || null,
      parentCallId: payload?.parentCallId ?? null,
      steps: [],
    },
  ];
}

export function stepSubagent(list, payload, ts) {
  const entries = [...(list ?? [])];
  let { index, name, id } = findEntry(entries, payload);
  if (index < 0) {
    entries.push({ id, subagent: name, status: 'running', startedAt: ts, steps: [] });
    index = entries.length - 1;
  }
  const current = entries[index];
  const step = Number(payload?.step) || current.step || 0;
  const status = ['running', 'done', 'failed'].includes(payload?.status) ? payload.status : 'running';
  const steps = [...(current.steps ?? [])];
  const stepIndex = steps.findIndex((entry) => Number(entry.step) === step);
  const stepEntry = {
    step,
    tool: String(payload?.tool ?? current.tool ?? ''),
    status,
    ...(payload?.error ? { error: String(payload.error).slice(0, 200) } : {}),
  };
  if (stepIndex >= 0) steps[stepIndex] = stepEntry;
  else steps.push(stepEntry);
  entries[index] = {
    ...current,
    step,
    maxSteps: Number(payload?.maxSteps) || current.maxSteps || null,
    tool: stepEntry.tool,
    status: status === 'failed' ? 'failed' : current.status,
    toolCount: status === 'done' ? Math.max(current.toolCount ?? 0, step) : (current.toolCount ?? 0),
    steps,
  };
  return entries;
}

export function finishSubagent(list, payload, ts) {
  const entries = [...(list ?? [])];
  let { index, name, id } = findEntry(entries, payload);
  if (index < 0) {
    entries.push({ id, subagent: name, status: 'running', startedAt: ts, steps: [] });
    index = entries.length - 1;
  }
  const current = entries[index];
  entries[index] = {
    ...current,
    status: payload?.status === 'failed' ? 'failed' : 'done',
    finishedAt: ts,
    step: Number(payload?.step) || current.step || 0,
    maxSteps: Number(payload?.maxSteps) || current.maxSteps || null,
    toolCount: Number(payload?.toolCount) || current.toolCount || 0,
    durationMs: Number(payload?.durationMs) || current.durationMs || 0,
    answerPreview: payload?.answerPreview
      ? String(payload.answerPreview).slice(0, 300)
      : current.answerPreview ?? null,
    error: payload?.error
      ? String(payload.error).slice(0, 300)
      : current.error ?? null,
  };
  return entries;
}
