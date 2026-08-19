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
  const fields = ORDERED_FIELDS
    .map((key) => formatField(FIELD_ALIASES[key], payload[key]))
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

export function shortLogId(value, { maxLength = 40 } = {}) {
  const shortened = shortenUuids(value);
  return shortened.length > maxLength ? `${shortened.slice(0, maxLength - 1)}…` : shortened;
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
