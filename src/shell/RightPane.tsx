/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, Index, Show } from 'solid-js';
import { filterRuntimeLogs } from '../core/runtimeLog.js';
import { fit } from './textFit';

type PlanStep = { step: number; description: string; status: string };
type QueueItem = {
  id: string;
  workspace?: string | null;
  status: string;
  args?: Record<string, any>;
  jobId?: string;
  error?: string;
  reason?: string;
};
type QueueInfo = { active: number; current: number; frozen: number };
type LogLineParts = { time: string | null; message: string };

// 4 slots (was 6): items can now span up to 5 lines each (wrapped label +
// wrapped status/error), so fewer, readable entries beat more, truncated ones.
const ACTIVITY_SLOTS = Array.from({ length: 4 }, (_, index) => index);
const LOG_SLOTS = Array.from({ length: 24 }, (_, index) => index);
const PLAN_VIEWPORT_ROWS = 12;

function wrapLine(value: string, width: number) {
  const max = Math.max(8, width);
  const text = String(value);
  if (text.length <= max) return [text];
  const lines = [];
  let rest = text;
  while (rest.length > max) {
    const slice = rest.slice(0, max + 1);
    const spaceAt = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\t'));
    const slashAt = slice.lastIndexOf('/');
    const threshold = Math.floor(max * 0.45);
    let index: number;
    if (spaceAt > threshold && (slashAt < 0 || spaceAt <= slashAt)) {
      index = spaceAt;
    } else if (slashAt > threshold) {
      index = slashAt + 1;
    } else if (spaceAt > threshold) {
      index = spaceAt;
    } else {
      index = max;
    }
    lines.push(rest.slice(0, index).trimEnd());
    rest = rest.slice(index).trimStart();
  }
  if (rest) lines.push(rest);
  return lines;
}

function logLineParts(line: string): LogLineParts {
  const match = line.match(/^((?:\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?|\d{4}-\d{2}-\d{2}[T ][0-9:.]+Z?))\s+(.+)$/i);
  if (!match) return { time: null, message: line };
  return { time: match[1], message: match[2] };
}

function activityColor(status: string) {
  const value = String(status ?? '').toLowerCase();
  if (['done', 'complete', 'completed', 'success'].includes(value)) return '#8BD5CA';
  if (['failed', 'error', 'cancelled', 'canceled'].includes(value)) return '#F38BA8';
  if (['running', 'queued', 'starting', 'cancelling'].includes(value)) return '#89B4FA';
  return '#AAB7C4';
}

function queueColor(status: string) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'waiting' || value === 'pending_approval') return '#FBBF24';
  return activityColor(status);
}

function activityLine(activity: any) {
  const detail = activity?.progress?.detail ?? null;
  const phase = activity?.progress?.step ?? activity?.progress?.phase ?? activity?.progress?.currentStep ?? null;
  // On failure the error message is the information that matters — surface
  // it instead of repeating the bare status the label color already conveys.
  const error = activityErrorText(activity);
  return [activity?.status ?? 'unknown', error ?? detail ?? phase].filter(Boolean).join(' · ');
}

function activityErrorText(activity: any): string | null {
  const status = String(activity?.status ?? '').toLowerCase();
  if (!['failed', 'error', 'cancelled', 'canceled'].includes(status)) return null;
  const error = activity?.error ?? activity?.result?.error ?? activity?.progress?.detail ?? null;
  const text = error == null ? '' : String(error).replace(/\s+/g, ' ').trim();
  return text || null;
}

function activityPercentBadge(activity: any): { text: string; bg: string; fg: string } | null {
  const val = Number(activity?.progress?.percent);
  if (!Number.isFinite(val)) return null;
  const pct = Math.round(val);
  if (pct >= 100) return { text: ` 100% `, bg: '#15803d', fg: '#dcfce7' };
  return { text: ` ${pct}% `, bg: '#1e3a5f', fg: '#93c5fd' };
}

function updatedLine(activity: any) {
  const source = activity?.source ?? 'mcp';
  const id = activity?.id ? `#${activity.id}` : null;
  if (!activity?.updatedAt) return [source, id].filter(Boolean).join(' ');
  const age = Math.max(0, Math.round((Date.now() - Date.parse(activity.updatedAt)) / 1000));
  return [source, id, `${age}s ago`].filter(Boolean).join(' · ');
}

// Single source of truth for terminal-status aliases so a plan step's icon and
// its color can never disagree (e.g. a 'succeeded' step showing done-green but a
// pending icon). Shared by planStepColor and PlanPanel's icon().
const DONE_STATUSES = ['done', 'complete', 'completed', 'success', 'succeeded'];
const FAILED_STATUSES = ['failed', 'error'];

function planStepColor(step: PlanStep, firstPendingStep: number | null) {
  const status = String(step.status ?? '').toLowerCase();
  if (DONE_STATUSES.includes(status)) return '#8BD5CA';
  if (FAILED_STATUSES.includes(status)) return '#F38BA8';
  if (status === 'running') return '#89B4FA';
  if (step.step === firstPendingStep) return '#89B4FA';
  return '#7F8C8D';
}

function activityJobName(activity: any) {
  if (!activity) return '';
  const id = activity.id ?? activity.jobId ?? activity.job_id;
  if (id) return `Job ${id}`;
  return activity.label
    ?? [activity.source, activity.kind, activity.id ? `#${activity.id}` : null].filter(Boolean).join(' ')
    ?? '';
}

function queueSummary(item: QueueItem) {
  const args = item.args ?? {};
  const parts = [
    args.type ?? 'production',
    Array.isArray(args.steps) && args.steps.length ? args.steps.join('+') : null,
    Array.isArray(args.templates) && args.templates.length ? `tpl:${args.templates.length}` : null,
    Array.isArray(args.deliverables) && args.deliverables.length ? `del:${args.deliverables.length}` : null,
  ].filter(Boolean);
  return parts.join(' ');
}

export function PlanPanel(props: { plan: PlanStep[]; width: number; jobName?: string }) {
  // Keep one column for the native vertical scrollbar when the plan is long.
  const lineWidth = () => Math.max(8, props.width - 3);
  const firstPending = () => props.plan.find((s) => s.status === 'pending')?.step ?? null;
  const icon = (rawStatus: string) => {
    const status = String(rawStatus ?? '').toLowerCase();
    if (DONE_STATUSES.includes(status)) return '[✓]';
    if (FAILED_STATUSES.includes(status)) return '[✗]';
    return status === 'running' ? '[…]' : '[ ]';
  };
  const visualRows = createMemo(() => props.plan.reduce((total, step) =>
    total + wrapLine(`${icon(step.status)} ${step.step}. ${step.description}`, lineWidth()).slice(0, 2).length, 0));
  const title = () => {
    const label = props.jobName ? `Plan : ${props.jobName}` : 'Plan';
    return visualRows() > PLAN_VIEWPORT_ROWS ? `${label} (${props.plan.length}) · scroll` : label;
  };
  const viewportRows = () => Math.min(PLAN_VIEWPORT_ROWS, Math.max(1, visualRows()));
  return (
    <box flexShrink={0} flexDirection="column" padding={1}>
      <text width={lineWidth()} fg="#D6DEE8" content={fit(title(), lineWidth())} />
      <scrollbox
        height={viewportRows()}
        focusable={false}
        scrollY={true}
        scrollX={false}
        stickyStart="top"
        viewportCulling={true}
        verticalScrollbarOptions={{ visible: visualRows() > PLAN_VIEWPORT_ROWS }}
      >
        <Index each={props.plan}>
          {(step) => {
            // Wrap step descriptions over up to 2 lines instead of truncating —
            // "Ingest des 39 documents raw/untrac…" hid the actual target.
            const lines = () => wrapLine(`${icon(step().status)} ${step().step}. ${step().description}`, lineWidth()).slice(0, 2);
            return (
              <box flexShrink={0} flexDirection="column">
                <text width={lineWidth()} fg={planStepColor(step(), firstPending())} content={lines()[0]} />
                <Show when={lines()[1]}>
                  <text width={lineWidth()} fg={planStepColor(step(), firstPending())} content={`    ${fit(lines()[1], Math.max(8, lineWidth() - 4))}`} />
                </Show>
              </box>
            );
          }}
        </Index>
      </scrollbox>
    </box>
  );
}

export function ActivityPanel(props: { activities: any[]; width: number }) {
  const lineWidth = () => Math.max(8, props.width - 2);
  const visible = () => props.activities.slice(-ACTIVITY_SLOTS.length).reverse();
  const activityAt = (index: number) => visible()[index] ?? null;
  return (
    <box flexShrink={0} flexDirection="column" padding={1}>
      <text width={lineWidth()} fg="#D6DEE8" content="Activity" />
      <Show when={visible().length > 0} fallback={<text width={lineWidth()} fg="#7F8C8D" content="no active jobs" />}>
        <Index each={ACTIVITY_SLOTS}>
          {(slot) => {
            const activity = () => activityAt(slot());
            // Wrap instead of hard-truncating: a 40-column pane cut labels to
            // "Appliquer la config recommandée (doct…" and hid the one thing
            // that mattered. Labels get up to 2 lines, the status/error line
            // up to 2 lines; empty continuation lines are not rendered.
            const labelLines = () => {
              const item = activity();
              if (!item) return [''];
              const label = String(item.progress?.label ?? item.label ?? `${item.source ?? 'mcp'} ${item.kind ?? 'job'}`);
              const lines = wrapLine(label, lineWidth()).slice(0, 2);
              if (lines.length === 2 && String(label).length > lines[0].length + lines[1].length) {
                lines[1] = fit(lines[1], lineWidth());
              }
              return lines;
            };
            const badge = () => activityPercentBadge(activity());
            const badgeLen = () => badge()?.text.length ?? 0;
            const statusLines = () => {
              const item = activity();
              if (!item) return [''];
              return wrapLine(activityLine(item), Math.max(8, lineWidth() - badgeLen())).slice(0, 2);
            };
            const statusColor = () => (activityErrorText(activity()) ? '#F38BA8' : '#AAB7C4');
            return (
              <box flexDirection="column" marginTop={slot() === 0 ? 1 : 0}>
                <text width={lineWidth()} fg={activityColor(activity()?.status)} content={labelLines()[0]} />
                <Show when={labelLines()[1]}>
                  <text width={lineWidth()} fg={activityColor(activity()?.status)} content={labelLines()[1]} />
                </Show>
                <box height={1} flexDirection="row">
                  <text
                    width={lineWidth() - badgeLen()}
                    fg={statusColor()}
                    content={activity() ? fit(statusLines()[0], lineWidth() - badgeLen()) : ''}
                  />
                  <text
                    width={badgeLen()}
                    bg={badge()?.bg ?? '#111827'}
                    fg={badge()?.fg ?? '#111827'}
                    content={badge()?.text ?? ''}
                  />
                </box>
                <Show when={statusLines()[1]}>
                  <text width={lineWidth()} fg={statusColor()} content={fit(statusLines()[1], lineWidth())} />
                </Show>
                <text width={lineWidth()} fg="#7F8C8D" content={activity() ? fit(updatedLine(activity()), lineWidth()) : ''} />
              </box>
            );
          }}
        </Index>
      </Show>
    </box>
  );
}

type LogSegment = { text: string; fg: string };

// Per-line coloring: 'runtime' source tag in violet, HH:MM:SS in blue,
// message tinted by nature (errors red, warnings amber, activity teal).
// Continuation lines of a wrapped entry are indented and dimmed so each
// entry reads as one visual block instead of an undifferentiated wall.
function logMessageColor(message: string): string {
  if (/\b(error|failed|exception|unavailable|introuvable|HTTP 4\d\d|HTTP 5\d\d)\b/i.test(message)) return '#F38BA8';
  if (/\b(warn|warning|avertissement|fallback|retry|expired|stale)\b/i.test(message)) return '#FBBF24';
  if (/^(activity|job)\b/i.test(message)) return '#8BD5CA';
  return '#AAB7C4';
}

function logRenderLines(logs: string[], width: number): LogSegment[][] {
  // Newest entry FIRST (descending): the freshest information belongs at the
  // top of the pane. Wrapped continuation lines stay attached below their
  // entry's first line.
  const blocks: LogSegment[][][] = [];
  for (const raw of logs) {
    blocks.push(logEntryLines(raw, width));
  }
  return blocks.reverse().flat();
}

function logEntryLines(raw: string, width: number): LogSegment[][] {
  const out: LogSegment[][] = [];
  for (const item of [raw]) {
    const rawLine = item;
    const sourceMatch = String(rawLine).match(/^(runtime)\s+(.*)$/);
    const source = sourceMatch ? sourceMatch[1] : null;
    const rest = sourceMatch ? sourceMatch[2] : String(rawLine);
    const parts = logLineParts(rest);
    const prefix: LogSegment[] = [];
    if (source) prefix.push({ text: `${source} `, fg: '#C6A0F6' });
    if (parts.time) prefix.push({ text: `${parts.time} `, fg: '#89B4FA' });
    const prefixLength = prefix.reduce((total, segment) => total + segment.text.length, 0);
    const messageColor = logMessageColor(parts.message);
    const wrapped = wrapLine(parts.message, Math.max(8, width - prefixLength));
    wrapped.forEach((text, index) => {
      if (index === 0) {
        out.push([...prefix, { text, fg: messageColor }]);
      } else {
        const indent = ' '.repeat(Math.min(prefixLength, 4));
        out.push([{ text: `${indent}${text}`, fg: messageColor === '#F38BA8' ? messageColor : '#7F8C8D' }]);
      }
    });
  }
  return out;
}

export function LogPanel(props: { logs: string[]; width: number; filter?: string }) {
  const [activeLogTab, setActiveLogTab] = createSignal<'flow' | 'agent-status'>('flow');
  const lineWidth = () => Math.max(8, props.width - 2);
  const isAgentStatus = (line: string) => /agent[_ -]?status/i.test(line);
  const filteredLogs = () => filterRuntimeLogs(props.logs, props.filter ?? '')
    .filter((line) => activeLogTab() === 'agent-status' ? isAgentStatus(line) : !isAgentStatus(line));
  const visibleLines = createMemo(() => logRenderLines(filteredLogs(), lineWidth()).slice(0, 24));
  const segmentsAt = (index: number): LogSegment[] => visibleLines()[index] ?? [];
  return (
    <box flexGrow={1} flexDirection="column" padding={1} focusable={false}>
      <box height={1} flexDirection="row">
        <text
          fg={activeLogTab() === 'flow' ? '#0B1020' : '#D6DEE8'}
          bg={activeLogTab() === 'flow' ? '#89B4FA' : undefined}
          content=" Flow / Trace "
          onMouseUp={() => setActiveLogTab('flow')}
        />
        <text fg="#4B5563" content=" " />
        <text
          fg={activeLogTab() === 'agent-status' ? '#0B1020' : '#D6DEE8'}
          bg={activeLogTab() === 'agent-status' ? '#FBBF24' : undefined}
          content=" Agent status "
          onMouseUp={() => setActiveLogTab('agent-status')}
        />
      </box>
      <box flexGrow={1} flexDirection="column" overflow="hidden">
        <Index each={LOG_SLOTS}>
          {(slot) => {
            const segments = () => segmentsAt(slot());
            const segmentAt = (position: number): LogSegment => segments()[position] ?? { text: '', fg: '#AAB7C4' };
            const usedWidth = (upTo: number) => segments().slice(0, upTo).reduce((total, segment) => total + segment.text.length, 0);
            const widthFor = (position: number) => {
              const segment = segmentAt(position);
              if (!segment.text) return 0;
              // Last visible segment absorbs the remaining width.
              return position === segments().length - 1
                ? Math.max(1, lineWidth() - usedWidth(position))
                : Math.min(segment.text.length, lineWidth() - usedWidth(position));
            };
            return (
              <box height={1} flexDirection="row" overflow="hidden">
                <text width={widthFor(0)} fg={segmentAt(0).fg} content={segmentAt(0).text} />
                <text width={widthFor(1)} fg={segmentAt(1).fg} content={segmentAt(1).text} />
                <text width={widthFor(2)} fg={segmentAt(2).fg} content={segmentAt(2).text} />
              </box>
            );
          }}
        </Index>
      </box>
    </box>
  );
}

export function QueuePanel(props: { items: QueueItem[]; info: QueueInfo; width: number }) {
  const lineWidth = () => Math.max(8, props.width - 2);
  const visible = () => props.items.slice(-6).reverse();
  return (
    <box flexShrink={0} flexDirection="column" padding={1}>
      <text width={lineWidth()} fg="#D6DEE8" content="Queue" />
      <Show when={props.info.frozen > 0}>
        <text width={lineWidth()} fg="#FBBF24" content={fit(`Queue frozen: ${props.info.frozen} item(s) in another workspace`, lineWidth())} />
      </Show>
      <Show when={visible().length > 0} fallback={<text width={lineWidth()} fg="#7F8C8D" content="no queued jobs" />}>
        <Index each={ACTIVITY_SLOTS}>
          {(slot) => {
            const item = () => visible()[slot()] ?? null;
            return (
              <box flexDirection="column" marginTop={slot() === 0 ? 1 : 0}>
                <text
                  width={lineWidth()}
                  fg={queueColor(item()?.status)}
                  content={item() ? fit(`${item()!.id} ${item()!.status} ${queueSummary(item()!)}`, lineWidth()) : ''}
                />
                <text
                  width={lineWidth()}
                  fg="#AAB7C4"
                  content={item() ? fit([item()!.workspace, item()!.jobId ? `job ${item()!.jobId}` : item()!.reason].filter(Boolean).join(' · '), lineWidth()) : ''}
                />
                <text
                  width={lineWidth()}
                  fg="#7F8C8D"
                  content={item()?.error ? fit(item()!.error!, lineWidth()) : ''}
                />
              </box>
            );
          }}
        </Index>
      </Show>
    </box>
  );
}

function TabHeader(props: { active: 'plan' | 'queue'; queueCount: number; width: number; onTabClick: (tab: 'plan' | 'queue') => void }) {
  const lineWidth = () => Math.max(8, props.width - 2);
  const planActive = () => props.active === 'plan';
  return (
    <box height={1} flexDirection="row" paddingX={1}>
      <text
        fg={planActive() ? '#0B1020' : '#D6DEE8'}
        bg={planActive() ? '#89B4FA' : undefined}
        content=" Plan "
        onMouseUp={() => props.onTabClick('plan')}
      />
      <text fg="#4B5563" content=" " />
      <text
        fg={!planActive() ? '#0B1020' : '#D6DEE8'}
        bg={!planActive() ? '#FBBF24' : undefined}
        content={` Queue (${props.queueCount}) `}
        onMouseUp={() => props.onTabClick('queue')}
      />
      <text fg="#7F8C8D" content={fit('  Ctrl+Q', Math.max(0, lineWidth() - 24))} />
    </box>
  );
}

export function RightPane(props: {
  width: number;
  activities: any[];
  logs: string[];
  plan: PlanStep[] | null;
  queueItems: QueueItem[];
  queueInfo: QueueInfo;
  activeTab: 'plan' | 'queue';
  logFilter?: string;
  pendingApprovals: any[];
  onApprove: () => void;
  onTabClick: (tab: 'plan' | 'queue') => void;
}) {
  const planJobName = () => activityJobName(
    [...props.activities].reverse().find((activity) => !activity.terminal) ?? props.activities.at(-1),
  );
  return (
    <box width={props.width} height="100%" flexDirection="column" gap={1} padding={1} overflow="hidden" focusable={false}>
      <TabHeader active={props.activeTab} queueCount={props.queueInfo.active} width={props.width} onTabClick={props.onTabClick} />
      <Show when={props.pendingApprovals.length > 0}>
        <box height={2} flexDirection="column" border={['left']} borderStyle="heavy" borderColor="#FBBF24" paddingX={1}>
          <text fg="#FBBF24" content={`${props.pendingApprovals.length} approbation(s) requise(s)`} />
          <text fg="#0B1020" bg="#FBBF24" content=" Approuver le run " onMouseUp={props.onApprove} />
        </box>
      </Show>
      <Show when={props.activeTab === 'queue'} fallback={(
        <>
          <Show when={props.plan && props.plan.length > 0}>
            <PlanPanel width={props.width} plan={props.plan!} jobName={planJobName()} />
          </Show>
          <ActivityPanel width={props.width} activities={props.activities} />
        </>
      )}>
        <QueuePanel width={props.width} items={props.queueItems} info={props.queueInfo} />
      </Show>
      <LogPanel width={props.width} logs={props.logs} filter={props.logFilter} />
    </box>
  );
}
