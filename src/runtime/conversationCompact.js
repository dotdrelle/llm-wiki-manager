import { emitRuntimeLog } from './supervisor.js';

const CONVERSATION_SUMMARY_TIMEOUT_MS = 20_000;
const CONVERSATION_SUMMARY_MAX_INPUT_CHARS = 8_000;

/*
 A compact does not just cut older turns from conversationSeed — it replaces
 them with a short rolling summary, so a decision made 20 messages ago is not
 gone from Donna's grounding entirely, only condensed. Best-effort: no LLM
 configured, an empty reply, or a call failure all fall back to keeping
 whatever summary already existed (never worse than before this compact),
 the same deterministic-under-failure shape as generateControlAcknowledgment.
 */
export async function summarizeCompactedConversation(session, { previousSummary, segment }) {
  const llm = session?.llm;
  const transcript = (Array.isArray(segment) ? segment : [])
    .filter((message) => ['user', 'assistant'].includes(message?.role) && String(message?.content ?? '').trim())
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${String(message.content).trim()}`)
    .join('\n')
    .slice(0, CONVERSATION_SUMMARY_MAX_INPUT_CHARS);
  if (!transcript) return previousSummary || null;
  if (!(llm && typeof llm.complete === 'function')) return previousSummary || null;
  try {
    const reply = await llm.complete({
      system: 'You maintain a compact working memory for Donna, a workspace assistant. You are shown an optional PREVIOUS SUMMARY and a NEW SEGMENT of conversation about to leave the assistant\'s context window. Write ONE updated summary that preserves the facts, decisions, open questions and user preferences that still matter for future turns. Be concise: well under 200 words. Return only the summary text — no preamble, no meta-commentary, no headings.',
      input: [
        previousSummary ? `PREVIOUS SUMMARY:\n${previousSummary}` : null,
        `NEW SEGMENT:\n${transcript}`,
      ].filter(Boolean).join('\n\n'),
      signal: AbortSignal.timeout(CONVERSATION_SUMMARY_TIMEOUT_MS),
    });
    const text = String(reply ?? '').trim();
    if (text) return text;
    emitRuntimeLog(session, 'conversation-compact: LLM returned an empty summary, keeping the previous one');
  } catch (err) {
    emitRuntimeLog(session, `conversation-compact: summary LLM call failed, keeping the previous summary — ${err instanceof Error ? err.message : String(err)}`);
  }
  return previousSummary || null;
}
