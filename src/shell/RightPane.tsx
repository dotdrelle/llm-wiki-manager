import { For, Show } from 'solid-js';

type PlanStep = { step: number; description: string; status: string };

function wrapLine(value: string, width: number) {
  const max = Math.max(8, width);
  const text = String(value);
  if (text.length <= max) return [text];
  const lines = [];
  let rest = text;
  while (rest.length > max) {
    const slice = rest.slice(0, max + 1);
    const breakAt = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\t'));
    const index = breakAt > Math.floor(max * 0.45) ? breakAt : max;
    lines.push(rest.slice(0, index).trimEnd());
    rest = rest.slice(index).trimStart();
  }
  if (rest) lines.push(rest);
  return lines;
}

function fit(value: string, width: number) {
  const max = Math.max(1, width);
  if (value.length <= max) return value;
  if (max <= 1) return '…';
  return value.slice(0, max - 1) + '…';
}

function activityColor(status: string) {
  const value = String(status ?? '').toLowerCase();
  if (['done', 'complete', 'completed', 'success'].includes(value)) return '#8BD5CA';
  if (['failed', 'error', 'cancelled', 'canceled'].includes(value)) return '#F38BA8';
  if (['running', 'queued', 'starting', 'cancelling'].includes(value)) return '#89B4FA';
  return '#AAB7C4';
}

function activityLine(activity: any) {
  const percent = Number.isFinite(Number(activity?.progress?.percent))
    ? `${Math.round(Number(activity.progress.percent))}%`
    : null;
  const step = activity?.progress?.step ?? activity?.progress?.currentStep ?? null;
  return [
    activity?.status ?? 'unknown',
    step,
    percent,
  ].filter(Boolean).join(' · ');
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
  if (step.step === firstPendingStep) return '#89B4FA';
  return '#7F8C8D';
}

export function PlanPanel(props: { plan: PlanStep[]; width: number }) {
  const lineWidth = () => Math.max(8, props.width - 2);
  const firstPending = () => props.plan.find((s) => s.status === 'pending')?.step ?? null;
  const icon = (status: string) =>
    status === 'done' ? '[✓]' : status === 'failed' ? '[✗]' : '[ ]';
  return (
    <box flexShrink={0} flexDirection="column" padding={1}>
      <text width={lineWidth()} fg="#D6DEE8">Plan</text>
      <For each={props.plan}>
        {(step) => (
          <text width={lineWidth()} fg={planStepColor(step, firstPending())}>
            {fit(`${icon(step.status)} ${step.step}. ${step.description}`, lineWidth())}
          </text>
        )}
      </For>
    </box>
  );
}

export function ActivityPanel(props: { activities: any[]; width: number }) {
  const lineWidth = () => Math.max(8, props.width - 2);
  const visible = () => props.activities.slice(-6).reverse();
  return (
    <box flexShrink={0} flexDirection="column" padding={1}>
      <text width={lineWidth()} fg="#D6DEE8">Activity</text>
      <Show when={visible().length > 0} fallback={<text width={lineWidth()} fg="#7F8C8D">no active jobs</text>}>
        <For each={visible()}>
          {(activity) => (
            <box flexDirection="column" marginTop={1}>
              <text width={lineWidth()} fg={activityColor(activity.status)}>
                {fit(activity.label ?? `${activity.source ?? 'mcp'} ${activity.kind ?? 'job'}`, lineWidth())}
              </text>
              <text width={lineWidth()} fg="#AAB7C4">
                {fit(activityLine(activity), lineWidth())}
              </text>
              <text width={lineWidth()} fg="#7F8C8D">
                {fit(updatedLine(activity), lineWidth())}
              </text>
            </box>
          )}
        </For>
      </Show>
    </box>
  );
}

export function LogPanel(props: { logs: string[]; width: number }) {
  const lineWidth = () => Math.max(8, props.width - 2);
  const visibleLines = () => props.logs.slice(-12).flatMap((line) => wrapLine(line, lineWidth()));
  return (
    <box flexGrow={1} flexDirection="column" padding={1}>
      <text width={lineWidth()} fg="#D6DEE8">Logs / Trace</text>
      <box flexGrow={1} flexDirection="column" overflow="hidden">
        <For each={visibleLines().slice(-24)}>
          {(line) => <text width={lineWidth()} fg="#AAB7C4">{line}</text>}
        </For>
      </box>
    </box>
  );
}

export function RightPane(props: { width: number; activities: any[]; logs: string[]; plan: PlanStep[] | null }) {
  return (
    <box width={props.width} height="100%" flexDirection="column" gap={1} padding={1} overflow="hidden">
      <Show when={props.plan && props.plan.length > 0}>
        <PlanPanel width={props.width} plan={props.plan!} />
      </Show>
      <ActivityPanel width={props.width} activities={props.activities} />
      <LogPanel width={props.width} logs={props.logs} />
    </box>
  );
}
