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
    return [timeLabel(ts), String(payload.message)].filter(Boolean).join(' ');
  }
  const time = timeLabel(ts);
  const event = eventLabel(payload.event);
  const fields = ORDERED_FIELDS
    .map((key) => formatField(FIELD_ALIASES[key], payload[key]))
    .filter(Boolean);
  if (payload.status != null) fields.push(formatField('status', payload.status));
  if (payload.percent != null) fields.push(formatField('percent', payload.percent));
  if (payload.outputs != null) fields.push(formatField('outputs', payload.outputs));
  if (payload.detail != null && payload.detail !== '') fields.push(`detail=${quoteIfNeeded(payload.detail)}`);
  return [time, event, ...fields].filter(Boolean).join(' ');
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
  return `${key}=${quoteIfNeeded(value)}`;
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
