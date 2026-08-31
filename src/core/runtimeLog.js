const FIELD_ALIASES = {
  runId: 'run',
  planRevision: 'plan',
  groupId: 'group',
  taskId: 'task',
  attemptId: 'attempt',
  agentType: 'agentType',
  agentInstanceId: 'agentInstance',
  agentId: 'agent',
  jobId: 'job',
  workspaceId: 'workspace',
  capability: 'capability',
  operation: 'operation',
  file: 'file',
  error: 'error',
};

const ORDERED_FIELDS = [
  'runId',
  'planRevision',
  'groupId',
  'taskId',
  'attemptId',
  'agentType',
  'agentInstanceId',
  'agentId',
  'jobId',
  'workspaceId',
  'capability',
  'operation',
  'file',
  'error',
];

// The dispatch events whose payload is routing plumbing, not business content:
// rendered compactly (see formatRuntimeLogPayload). Business events keep the
// full field=value form.
const COMPACT_EVENTS = new Set([
  'agent_status',
  'agent_execute',
  'job.accepted',
  'task.ready',
  'task.starting',
  'task.started',
  'task.completed',
  'task.failed',
  'attempt.created',
  'lock.acquired',
  'lock.released',
  'runtime.execute',
  'runtime.accepted',
  'runtime.result_returned',
  'task.result_returned',
  'runtime.params_refused',
  'runtime.blind',
]);

export function normalizeRuntimeLog(input, { session = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { message: String(input ?? '') };
  }
  const workspaceId = input.workspaceId ?? input.workspace ?? session?.workspace ?? session?._currentRunIdentity?.workspace ?? null;
  return {
    event: input.event ? String(input.event) : 'runtime.log',
    runId: input.runId ?? session?._currentRunIdentity?.runId ?? null,
    planRevision: input.planRevision ?? session?.planRevision ?? null,
    groupId: input.groupId ?? null,
    taskId: input.taskId ?? null,
    attemptId: input.attemptId ?? null,
    agentType: input.agentType ?? null,
    agentInstanceId: input.agentInstanceId ?? null,
    agentId: input.agentId ?? null,
    jobId: input.jobId ?? null,
    workspaceId,
    capability: input.capability ?? null,
    operation: input.operation ?? null,
    file: input.file ?? input.fileRef ?? null,
    error: input.error ?? null,
    status: input.status ?? null,
    outputs: input.outputs ?? input.outputRefs ?? null,
    percent: input.percent ?? null,
    detail: input.detail ?? input.message ?? null,
  };
}

export function formatRuntimeLogPayload(payload = {}, ts = null) {
  // Plain messages get the same time prefix as structured events: untimed
  // lines ended up visually glued at the bottom of Logs/Trace, out of
  // chronology with the shell's own timestamped lines.
  if (payload?.message != null && !payload.event) {
    return [timeLabel(ts), shortenUuids(String(payload.message))].filter(Boolean).join(' ');
  }
  const time = timeLabel(ts);
  const event = eventLabel(payload.event);
  // Dispatch plumbing is rendered as a readable sentence, not a field dump:
  // `AGENT_STATUS run=… plan=… group=… attempt=… agentType=… workspace=…`
  // buried the one thing the reader wants — WHO does WHAT on WHICH task, on
  // WHICH job. The verbosity is kept for business payloads, where fields are
  // the content.
  if (COMPACT_EVENTS.has(String(payload.event ?? ''))) {
    const parts = [time, event];
    const who = payload.agentInstanceId ?? payload.agentId ?? payload.agentType;
    if (who) parts.push(shortenUuids(String(who)));
    const what = [payload.capability, payload.operation].filter(Boolean).join('/');
    if (what) parts.push(what);
    const task = shortTaskLabel(payload.taskId);
    if (task) parts.push(task);
    if (payload.jobId) parts.push(shortenUuids(String(payload.jobId)));
    if (payload.status != null) parts.push(String(payload.status));
    if (payload.error) parts.push(shortenUuids(String(payload.error)).slice(0, 120));
    if (payload.detail != null && payload.detail !== ''
      && String(payload.detail).toUpperCase() !== event) {
      parts.push(shortenUuids(String(payload.detail)));
    }
    return parts.join(' · ');
  }
  const fields = ORDERED_FIELDS
    .map((key) => (key === 'taskId'
      ? formatField(FIELD_ALIASES[key], shortTaskLabel(payload[key]))
      : formatField(FIELD_ALIASES[key], payload[key])))
    .filter(Boolean);
  if (payload.status != null) fields.push(formatField('status', payload.status));
  if (payload.percent != null) fields.push(formatField('percent', payload.percent));
  if (payload.outputs != null) fields.push(formatField('outputs', payload.outputs));
  if (payload.detail != null && payload.detail !== '') fields.push(`detail=${quoteIfNeeded(shortenUuids(payload.detail))}`);
  return [time, event, ...fields].filter(Boolean).join(' ');
}

// Runtime/agent ids are long UUIDs (run, task, attempt, agent instance). A full
// UUID pushed the readable fields off the line and wrapped mid-id, which is what
// made the Logs/Trace panel illegible. Collapse the UUID to its first 8 hex
// characters — the same disambiguating prefix every UI already shows — and cap
// over-long slugs so a single field never monopolises the line.
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function shortenUuids(text) {
  return String(text ?? '').replace(UUID_RE, (uuid) => `${uuid.slice(0, 8)}…`);
}

// A structured taskId is `<runId-uuid>:<slug>-<hash8>`. The UUID and the hash
// carry no meaning for a reader; keep the human-readable slug in between so
// `task=…` in a runtime log line names the work instead of an opaque id. A
// plain id that is neither prefixed nor hash-suffixed (`task-build`, `a`, a
// legacy step number) is left exactly as it is — only the UUID is collapsed.
const TASK_HASH_SUFFIX = /-[0-9a-f]{8,}$/i;

export function shortTaskLabel(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return raw;
  const hasColon = raw.includes(':');
  if (!hasColon && !TASK_HASH_SUFFIX.test(raw)) return shortenUuids(raw);
  const tail = hasColon ? raw.slice(raw.indexOf(':') + 1) : raw;
  const pretty = tail.replace(TASK_HASH_SUFFIX, '').replace(/[-_]+/g, ' ').trim();
  return pretty || shortenUuids(raw);
}

export function shortLogId(value, { maxLength = 40 } = {}) {
  const shortened = shortenUuids(value);
  return shortened.length > maxLength ? `${shortened.slice(0, maxLength - 1)}…` : shortened;
}

// A line emitted by formatRuntimeLogPayload for a structured event: optional
// HH:MM:SS, then the ALL-CAPS event token eventLabel() produces from the LAST
// dotted segment ('job.accepted' → 'ACCEPTED', 'capability.resolving' →
// 'RESOLVING', 'agent_status' → 'AGENT_STATUS'). These are the dispatch
// plumbing. A business line the reducer writes starts with a ▸/✓/✗/↻ glyph or
// a capitalised word ("Plan received", "Run failed:") — never an all-caps
// token — so this one shape separates the two without an event-name list
// (which is what an earlier enumeration got wrong: it only ever matched the
// two underscore-form events and missed every dotted one).
const DISPATCH_PLUMBING_LINE = /^(?:\d{1,2}:\d{2}(?::\d{2})?\s*(?:·\s*)?)?[A-Z][A-Z0-9_]{2,}(?:\s|$)/;

export function isDispatchPlumbingLine(line) {
  return DISPATCH_PLUMBING_LINE.test(String(line ?? ''));
}

export function runtimeLogMatchesFilter(line, filter = '') {
  const query = String(filter ?? '').trim();
  if (!query) return true;
  const haystack = String(line ?? '').toLowerCase();
  return query
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token.toLowerCase()));
}

export function filterRuntimeLogs(logs = [], filter = '') {
  return logs.filter((line) => runtimeLogMatchesFilter(line, filter));
}

export function compactRuntimeLogForDisplay(line) {
  const text = String(line ?? '');
  if (!/\bWARN\s+retrieval:vector-fallback\b/i.test(text)) return text;
  const header = text.split(/\r?\n/, 1)[0].trimEnd();
  const reason = logFieldValue(text, 'reason');
  const message = logFieldValue(text, 'message');
  const details = [reason && `reason=${reason}`, message && `message=${message}`].filter(Boolean).join(' ');
  return details ? `${header} ${details}` : header;
}

function logFieldValue(text, name) {
  const match = String(text).match(new RegExp(`(?:^|\\s)${name}=("(?:\\\\.|[^"\\\\])*"|[^\\s]+)`, 'i'));
  return match?.[1] ?? null;
}

function timeLabel(ts) {
  const date = ts ? new Date(ts) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(11, 19);
}

function eventLabel(event) {
  const raw = String(event ?? 'runtime.log').trim();
  const part = raw.includes('.') ? raw.split('.').at(-1) : raw;
  return part.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'LOG';
}

function formatField(key, value) {
  if (value == null || value === '') return null;
  return `${key}=${quoteIfNeeded(shortenUuids(value))}`;
}

function quoteIfNeeded(value) {
  const text = Array.isArray(value)
    ? value.map((item) => refString(item)).filter(Boolean).join(',')
    : refString(value);
  return /[\s"]/u.test(text) ? JSON.stringify(text) : text;
}

function refString(value) {
  if (value == null) return '';
  if (typeof value === 'object') return String(value.ref ?? value.path ?? value.id ?? JSON.stringify(value));
  return String(value);
}
