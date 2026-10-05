/**
 * Gmail grants requested from Google, and what they actually open up.
 *
 * The identifiers (`read`, `send`, `modify`) are Google's — `modify`
 * comes from the `gmail.modify` scope — and those of `GOOGLE_GRANTS` in
 * agent-connectors. Inventing a synonym for them on the manager side would create
 * a third spelling to keep up to date, exactly the pitfall that had given
 * a second pair of prefixed OAuth variables. We describe, we do not rename.
 *
 * This table is the single source: the default value of
 * `/connector auth`, the completion help and the rendering of `/connector list`
 * all derive from it, so they cannot diverge.
 */
export const GOOGLE_GRANT_LABELS = Object.freeze({
  read: 'read messages and collect them into the workspace',
  send: 'send email from your account (subject to the recipient allow-list)',
  modify: 'mark read/unread, archive, label, star, trash (never permanent deletion)',
});

export const GOOGLE_GRANTS = Object.freeze(Object.keys(GOOGLE_GRANT_LABELS));

/**
 * Grants requested when the operator names none.
 *
 * Everything the agent knows how to do. A narrower default promises actions that
 * the authorization does not cover: `/connector auth google` asked only for
 * `read`, while the agent exposes sending and mailbox management — Donna
 * offered "mark as read", and the action failed afterwards. Since
 * the Google authorization is incremental, a grant added later costs an
 * extra consent round-trip, not less access.
 */
export function defaultGoogleGrants() {
  return [...GOOGLE_GRANTS];
}

