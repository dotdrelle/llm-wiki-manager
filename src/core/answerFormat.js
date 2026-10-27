// How Donna lays out what she writes. The facts were right but read as a wall
// of prose (a /status of four dense paragraphs; a maintenance report that
// said "cycle completed" while a proposal waited on the user). The chat,
// the report reader and the maintenance panel render safe Markdown — headings,
// lists, tables, quotes; never raw HTML — so the layout is asked for in words
// and drawn by those renderers: nothing here widens what a reply may contain.
import { conversationChannelPromptLine } from './conversationChannel.js';

export const ANSWER_FORMAT_RULE = [
  'Answer format (the chat renders Markdown): a reply of one to three sentences stays plain text.',
  'A longer reply opens with one bold line giving the verdict, then lists the facts as short bullets, each starting with a **bold label**.',
  'Use a small table (two to four columns) only to compare three or more items of the same kind.',
  'Put anything the user must act on, or a failure, on its own quoted line starting with ⚠ (`> ⚠ …`).',
  'When something is left to do, end with the next steps as a numbered list of one to three items under a short heading in the reply language.',
  'Keep every figure exact. Never write raw HTML or images, and no decorative emoji (✓ and ⚠ only).',
].join(' ');

export const REPORT_FORMAT_RULE = [
  'Report format (a report is read in a Markdown reader): open with a quoted "In brief" block of at most three lines in the reply language —',
  'the verdict, what blocks, and what the user must do now, or that nothing is needed — then sections under ## headings,',
  'facts as bullets with **bold labels**, a table only to compare three or more items, a quoted ⚠ line for each problem.',
  'When something waits on the user, the In brief block says so first: never close a report on "completed" while it does.',
].join(' ');

/**
 * The presentation lines of a conversational prompt. A messaging thread
 * (Tchap) is read on a phone and its renderer has no headings or tables: its
 * own channel line replaces the rich format instead of competing with it.
 */
export function presentationPromptLines(channel) {
  const channelLine = conversationChannelPromptLine(channel);
  return channelLine ? [channelLine] : [ANSWER_FORMAT_RULE];
}
