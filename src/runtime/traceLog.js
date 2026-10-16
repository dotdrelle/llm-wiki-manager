// One readable line per meaningful runtime event, written to the runtime's
// stdout — which `lifecycle.js` redirects to `<state>/runtime.log`, the file
// `wiki-workspace runtime logs` follows. The SQLite event log is the durable
// record, but it cannot be grepped from a terminal on a production box, and
// `runtime_log` lines (capability resolution, discovery, maintenance) are not
// persisted at all: before this mirror, runtime.log held two boot lines while
// the failure that explained a run lived only in the Serve Logs tab.
//
// WIKI_MANAGER_RUNTIME_TRACE: `on` (default), `verbose` (adds the compact
// payload of every line) or `off`. Content excerpts are bounded; secrets never
// enter events in the first place (prompt-safe facts, redacted base URLs).

const SILENT_TYPES = new Set([
  'assistant_delta',
  'runtime_heartbeat',
  'runtime_phase_started',
  'state',
]);

const ERROR_TYPES = new Set(['run_error', 'run_failed', 'task_failed', 'control_failed', 'skill_failed']);

export function runtimeTraceMode(env = process.env) {
  const value = String(env.WIKI_MANAGER_RUNTIME_TRACE ?? 'on').trim().toLowerCase();
  if (/^(0|off|false|no|none)$/.test(value)) return 'off';
  if (value === 'verbose') return 'verbose';
  return 'on';
}

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function shortId(value) {
  const text = String(value ?? '');
  return text ? text.slice(0, 8) : '';
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function firstText(payload, keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function agentSummary(payload) {
  const agent = payload?.agent ?? {};
  const description = agent.description ?? {};
  const id = agent.agentInstanceId ?? description.agentInstanceId ?? agent.serverName ?? '?';
  const health = description.health?.status ?? payload?.health ?? payload?.to ?? '';
  const capabilities = (description.capabilities ?? []).map((c) => c?.id ?? c?.name).filter(Boolean);
  const error = description.health?.error ?? description.health?.message ?? '';
  return `${id} health=${health || '?'} capabilities=[${capabilities.join(', ')}]${error ? ` error=${clip(error, 200)}` : ''}`;
}

function toolResultSummary(payload) {
  const parsed = parseMaybeJson(payload?.result);
  const failed = payload?.ok === false || parsed?.ok === false || Boolean(parsed?.error);
  const detail = parsed && typeof parsed === 'object'
    ? [parsed.code, parsed.blocker, parsed.error?.message ?? parsed.error, parsed.message, parsed.reason, parsed.status]
      .filter((v) => typeof v === 'string' && v).join(' — ')
    : String(parsed ?? '');
  return { failed, text: `${payload?.name ?? '?'} ${failed ? 'FAILED' : 'ok'}${detail ? ` — ${clip(detail, failed ? 600 : 200)}` : ''}` };
}

/**
 * Format one event as a log line, or null when it is deliberately silent.
 * `seen` lets repeated agent registrations (one per periodic re-scan) print
 * only when the agent's health or capability set changes.
 */
export function formatTraceLine(event, { mode = 'on', seen = null } = {}) {
  if (!event || mode === 'off' || SILENT_TYPES.has(event.type)) return null;
  const payload = event.payload ?? {};
  const type = String(event.type ?? 'event');
  let level = ERROR_TYPES.has(type) ? 'ERROR' : 'INFO';
  let text;
  switch (type) {
    case 'agent.registered':
    case 'agent.health_changed': {
      text = agentSummary(payload);
      if (seen) {
        const key = (payload?.agent?.agentInstanceId ?? payload?.agent?.serverName ?? '?') + (event.workspace ?? '');
        if (seen.get(key) === text) return null;
        seen.set(key, text);
      }
      if (/health=(unavailable|degraded)/.test(text)) level = 'WARN';
      break;
    }
    case 'tool_call_started':
      text = `${payload.name ?? '?'} ${clip(payload.summary ?? payload.args ?? '', 300)}`;
      break;
    case 'tool_call_result': {
      const result = toolResultSummary(payload);
      if (result.failed) level = 'ERROR';
      text = result.text;
      break;
    }
    case 'chat_step':
      text = `${payload.name ?? '?'} ${clip(payload.arguments ?? '', 200)}`;
      break;
    case 'user_message':
    case 'control_message_received':
      text = `"${clip(payload.content ?? payload.input ?? '', 160)}"${payload.classification?.kind ? ` → ${payload.classification.kind}` : ''}`;
      break;
    case 'assistant_message':
      // A model step that only called tools: the tool lines already say it.
      if (!String(payload.content ?? '').trim()) return null;
      text =`(${String(payload.content ?? '').length} chars) ${clip(payload.content ?? '', 160)}`;
      break;
    case 'assistant_progress':
      text = clip(firstText(payload, ['message', 'text', 'content']), 300);
      if (!text) return null;
      break;
    case 'step_narrative':
      if (!payload.final) return null;
      text = (payload.lines ?? []).map((line) => `[${line.state}] ${clip(line.text, 160)}`).join(' | ');
      break;
    case 'control_enqueued':
      text = `${payload.type ?? ''} "${clip(payload.input, 120)}"${payload.capabilityPlan ? ` capability=${payload.capabilityPlan.capability}/${payload.capabilityPlan.operation}` : ''} item=${shortId(payload.id?.replace(/^control-/, ''))}`;
      break;
    case 'runtime_log': {
      text = clip(firstText(payload, ['message']), 800);
      if (/\b(fail|failed|error|unresolvable|unavailable|unreachable|refused|denied|401|403|timeout|timed out)\b/i.test(text)) level = 'WARN';
      if (/degraded/i.test(text)) level = 'WARN';
      break;
    }
    default: {
      text = clip(firstText(payload, ['message', 'error', 'reason', 'summary', 'status', 'input', 'objective']), 600);
      if (payload.kind) text = `${text}${text ? ' ' : ''}(${payload.kind})`;
      if (/error|failed|degraded|rejected/i.test(type) && level === 'INFO') level = 'WARN';
    }
  }
  const scope = [
    event.workspace ? `[${event.workspace}]` : '[-]',
    event.runId ? `run=${shortId(event.runId)}` : '',
    event.taskId ?? payload.taskId ? `task=${shortId(event.taskId ?? payload.taskId)}` : '',
  ].filter(Boolean).join(' ');
  const ts = event.ts ?? new Date().toISOString();
  let line = `${ts} ${level.padEnd(5)} ${scope} ${type}${text ? ` ${text}` : ''}`;
  if (mode === 'verbose') line += ` payload=${clip(JSON.stringify(payload), 2000)}`;
  return line;
}

/** A writer bound to one process: its own dedup memory and output stream. */
export function createRuntimeTracer({ env = process.env, write = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const mode = runtimeTraceMode(env);
  const seen = new Map();
  return (event) => {
    try {
      const line = formatTraceLine(event, { mode, seen });
      if (line) write(line);
    } catch {
      // A trace is a comfort: it must never break event delivery.
    }
  };
}
