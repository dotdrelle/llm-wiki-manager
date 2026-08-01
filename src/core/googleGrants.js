/**
 * Droits Gmail demandés à Google, et ce qu'ils ouvrent réellement.
 *
 * Les identifiants (`read`, `send`, `modify`) sont ceux de Google — `modify`
 * vient du scope `gmail.modify` — et ceux de `GOOGLE_GRANTS` dans
 * agent-connectors. Leur inventer un synonyme côté manager créerait une
 * troisième orthographe à tenir à jour, exactement le travers qui avait donné
 * une seconde paire de variables OAuth préfixées. On décrit, on ne renomme pas.
 *
 * Cette table est la source unique : la valeur par défaut de
 * `/connector auth`, l'aide de la complétion et le rendu de `/connector list`
 * en découlent tous, donc ils ne peuvent pas diverger.
 */
export const GOOGLE_GRANT_LABELS = Object.freeze({
  read: 'read messages and collect them into the workspace',
  send: 'send email from your account (subject to the recipient allow-list)',
  modify: 'mark read/unread, archive, label, star, trash (never permanent deletion)',
});

export const GOOGLE_GRANTS = Object.freeze(Object.keys(GOOGLE_GRANT_LABELS));

/**
 * Droits demandés quand l'opérateur n'en nomme aucun.
 *
 * Tout ce que l'agent sait faire. Un défaut plus étroit promet des actions que
 * l'autorisation ne couvre pas : `/connector auth google` ne demandait que
 * `read`, alors que l'agent expose l'envoi et la gestion de boîte — Donna
 * proposait « marquer comme lu », et l'action échouait après coup. Comme
 * l'autorisation Google est incrémentale, un droit ajouté plus tard coûte un
 * aller-retour de consentement supplémentaire, pas moins d'accès.
 */
export function defaultGoogleGrants() {
  return [...GOOGLE_GRANTS];
}

export function describeGoogleGrant(grant) {
  return GOOGLE_GRANT_LABELS[grant] ?? null;
}
