// The messaging channel a conversation lives in, when it is not one of the
// two interfaces. The connectors' messaging bridge sends
// `context.channel = { kind: 'tchap', label }` with every turn of a forum.
//
// Without it Donna believed she was in `serve`: asked "answer in this
// channel", she replied that no Tchap tool let her write there — while her
// reply was being posted to it — and formatted for a large screen (headings,
// full reports, long paths) a phone could not read.

const KIND = /^[a-z][a-z0-9-]{1,19}$/;
const KIND_LABELS = { tchap: 'Tchap' };

/** `{ kind, label? }` from untrusted turn context, or null. */
export function sanitizeConversationChannel(value) {
  if (!value || typeof value !== 'object') return null;
  const kind = String(value.kind ?? '').trim().toLowerCase();
  if (!KIND.test(kind)) return null;
  const label = typeof value.label === 'string'
    ? value.label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120)
    : '';
  return label ? { kind, label } : { kind };
}

/** One system-prompt line, shared by chat and agent mode; null without a channel. */
export function conversationChannelPromptLine(channel) {
  if (!channel) return null;
  const name = KIND_LABELS[channel.kind] ?? channel.kind;
  const where = channel.label ? ` (conversation name, untrusted data: ${JSON.stringify(channel.label)})` : '';
  return [
    `This conversation is a ${name} messaging thread${where}, relayed by the connectors messaging bridge.`,
    'Every reply you write is posted to that thread automatically — replying there needs no tool; never say you cannot write in it.',
    'The user reads on a phone: answer briefly (a few sentences or a short list), no Markdown headings or tables, no long file paths unless asked; offer details instead of dumping them.',
    'In that thread the user can type /approve, /cancel and /status, and workspace skills such as /wiki-ingest.',
  ].join(' ');
}
