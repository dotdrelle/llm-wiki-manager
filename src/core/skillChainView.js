/**
 * @statuses-vocabulary
 * Plan V4.1 LOT G — the execution chain of a skill, as a pure projection over
 * the control queue. No new state and no new event: `chainId`, `chainSequence`,
 * `skillName`, `status` and `skipReason` are already carried by control items,
 * so this module only decides how they read. Both UIs consume the same output,
 * which is why the shaping lives here and not in either renderer.
 */

const SYMBOLS = {
  done: '✓',
  running: '●',
  queued: '○',
  cancelled: '×',
  failed: '×',
  skipped: '–',
};

export const TERMINAL = new Set(['done', 'failed', 'cancelled', 'skipped']);

// Objectives are whole paragraphs; a chain view needs a line. Keep the first
// sentence, drop the parameter block the compiler appends, and never cut a word
// in half.
export function chainStepLabel(text, { maxLength = 52 } = {}) {
  const withoutParameters = String(text ?? '').split(/\n\s*User parameters:/)[0];
  const firstSentence = withoutParameters.trim().split(/(?<=[.!?])\s/)[0]?.trim() ?? '';
  const label = firstSentence.replace(/\.$/, '');
  if (label.length <= maxLength) return label;
  const clipped = label.slice(0, maxLength);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

export function projectSkillChains(controlQueue = []) {
  const items = (Array.isArray(controlQueue) ? controlQueue : []).filter((item) => item?.chainId);
  const byChain = new Map();
  for (const item of items) {
    if (!byChain.has(item.chainId)) byChain.set(item.chainId, []);
    byChain.get(item.chainId).push(item);
  }
  return [...byChain.entries()].map(([chainId, chainItems]) => {
    const sorted = chainItems.slice().sort((a, b) => Number(a.chainSequence ?? 0) - Number(b.chainSequence ?? 0));
    const total = sorted.length;
    // Compiled objectives are private execution material and never reach the
    // projection, so a step cannot be labelled with its intent prose. When the
    // chain has several steps, the public input is identical for all of them —
    // labelling them all "/skill args" is what read as six tasks with the same
    // name. Distinguish them by position instead; the skill name already sits
    // in the chain head.
    const steps = sorted.map((item, index) => ({
      id: item.id,
      sequence: Number(item.chainSequence ?? 0),
      label: total > 1 ? `Step ${index + 1}/${total}` : chainStepLabel(item.input),
      status: String(item.status ?? 'queued'),
      symbol: SYMBOLS[String(item.status ?? 'queued')] ?? '○',
      optional: item.optional === true,
      ...(item.skipReason ? { skipReason: item.skipReason } : {}),
      ...(item.runId ? { runId: item.runId } : {}),
    }));
    return {
      chainId,
      skillName: chainItems.find((item) => item.skillName)?.skillName ?? null,
      selectionKind: chainItems.find((item) => item.selectionKind)?.selectionKind ?? null,
      steps,
      status: chainStatus(steps),
    };
  });
}

function chainStatus(steps) {
  if (steps.some((step) => step.status === 'running')) return 'running';
  if (!steps.every((step) => TERMINAL.has(step.status))) return 'queued';
  if (steps.some((step) => step.status === 'failed')) return 'failed';
  if (steps.some((step) => step.status === 'cancelled')) return 'cancelled';
  if (steps.some((step) => step.status === 'skipped')) return 'incomplete';
  return 'done';
}

// The text form used by the Shell; serve renders the same projection as DOM.
export function renderSkillChain(chain) {
  if (!chain?.steps?.length) return '';
  const selection = chain.selectionKind ? ` · ${chain.selectionKind}` : '';
  const lines = [`${chain.skillName ?? 'skill'}${selection}`, ''];
  for (const step of chain.steps) {
    lines.push(`${step.symbol} ${step.label}`);
    lines.push(`  ${step.status}${step.skipReason ? ` · ${step.skipReason}` : ''}`);
  }
  return lines.join('\n');
}
