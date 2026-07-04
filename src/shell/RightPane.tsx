/** @jsxImportSource @opentui/solid */
import { createMemo, Index, Show } from 'solid-js';
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

const ACTIVITY_SLOTS = Array.from({ length: 6 }, (_, index) => index);
const LOG_SLOTS = Array.from({ length: 24 }, (_, index) => index);

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
  return [activity?.status ?? 'unknown', detail ?? phase].filter(Boolean).join(' · ');
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

function planStepColor(step: PlanStep, firstPendingStep: number | null) {
  if (step.status === 'done') return '#8BD5CA';
  if (step.status === 'failed') return '#F38BA8';
  if (step.status === 'running') return '#89B4FA';
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
  const lineWidth = () => Math.max(8, props.width - 2);
  const firstPending = () => props.plan.find((s) => s.status === 'pending')?.step ?? null;
  const icon = (status: string) =>
    status === 'done' ? '[✓]' : status === 'failed' ? '[✗]' : status === 'running' ? '[…]' : '[ ]';
  const title = () => props.jobName ? `Plan : ${props.jobName}` : 'Plan';
  return (
    <box flexShrink={0} flexDirection="column" padding={1}>
      <text width={lineWidth()} fg="#D6DEE8" content={fit(title(), lineWidth())} />
      <Index each={props.plan}>
        {(step) => (
          <text
            width={lineWidth()}
            fg={planStepColor(step(), firstPending())}
            content={fit(`${icon(step().status)} ${step().step}. ${step().description}`, lineWidth())}
          />
        )}
      </Index>
    </box>
  );
}

export function ActivityPanel(props: { activities: any[]; width: number }) {
  const lineWidth = () => Math.max(8, props.width - 2);
  const visible = () => props.activities.slice(-6).reverse();
  const activityAt = (index: number) => visible()[index] ?? null;
  return (
    <box flexShrink={0} flexDirection="column" padding={1}>
      <text width={lineWidth()} fg="#D6DEE8" content="Activity" />
      <Show when={visible().length > 0} fallback={<text width={lineWidth()} fg="#7F8C8D" content="no active jobs" />}>
        <Index each={ACTIVITY_SLOTS}>
          {(slot) => {
            const activity = () => activityAt(slot());
            const label = () => {
              const item = activity();
              if (!item) return '';
              return fit(item.progress?.label ?? item.label ?? `${item.source ?? 'mcp'} ${item.kind ?? 'job'}`, lineWidth());
            };
            const badge = () => activityPercentBadge(activity());
            const badgeLen = () => badge()?.text.length ?? 0;
            return (
              <box flexDirection="column" marginTop={slot() === 0 ? 1 : 0}>
                <text width={lineWidth()} fg={activityColor(activity()?.status)} content={label()} />
                <box height={1} flexDirection="row">
                  <text
                    width={lineWidth() - badgeLen()}
                    fg="#AAB7C4"
                    content={activity() ? fit(activityLine(activity()), lineWidth() - badgeLen()) : ''}
                  />
                  <text
                    width={badgeLen()}
                    bg={badge()?.bg ?? '#111827'}
                    fg={badge()?.fg ?? '#111827'}
                    content={badge()?.text ?? ''}
                  />
                </box>
                <text width={lineWidth()} fg="#7F8C8D" content={activity() ? fit(updatedLine(activity()), lineWidth()) : ''} />
              </box>
            );
          }}
        </Index>
      </Show>
    </box>
  );
}

export function LogPanel(props: { logs: string[]; width: number }) {
  const lineWidth = () => Math.max(8, props.width - 2);
  const visibleLines = () => props.logs.slice(-12).flatMap((line) => wrapLine(line, lineWidth())).slice(-24);
  const logLineAt = (index: number) => visibleLines()[index] ?? '';
  return (
    <box flexGrow={1} flexDirection="column" padding={1}>
      <text width={lineWidth()} fg="#D6DEE8" content="Logs / Trace" />
      <box flexGrow={1} flexDirection="column" overflow="hidden">
        <Index each={LOG_SLOTS}>
          {(slot) => {
            const line = () => logLineAt(slot());
            const parts = createMemo(() => logLineParts(line()));
            const timeWidth = () => parts().time ? Math.min(parts().time!.length + 1, lineWidth()) : 0;
            const messageWidth = () => Math.max(1, lineWidth() - timeWidth());
            return (
              <Show
                when={parts().time}
                fallback={<text width={lineWidth()} fg="#AAB7C4" content={line()} />}
              >
                <box height={1} flexDirection="row" overflow="hidden">
                  <text width={timeWidth()} fg="#89B4FA" content={fit(`${parts().time} `, timeWidth())} />
                  <text width={messageWidth()} fg="#AAB7C4" content={fit(parts().message, messageWidth())} />
                </box>
              </Show>
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
  onTabClick: (tab: 'plan' | 'queue') => void;
}) {
  const planJobName = () => activityJobName(
    [...props.activities].reverse().find((activity) => !activity.terminal) ?? props.activities.at(-1),
  );
  return (
    <box width={props.width} height="100%" flexDirection="column" gap={1} padding={1} overflow="hidden">
      <TabHeader active={props.activeTab} queueCount={props.queueInfo.active} width={props.width} onTabClick={props.onTabClick} />
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
      <LogPanel width={props.width} logs={props.logs} />
    </box>
  );
}
