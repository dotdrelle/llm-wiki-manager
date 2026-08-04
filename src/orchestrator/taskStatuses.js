/**
 * Vocabulaire unique des statuts de tâche.
 *
 * Quatorze modules portaient chacun sa propre liste : `['done', 'failed',
 * 'cancelled']` ici, un `Set` avec `success` et `succeeded` là, un troisième
 * qui ajoutait `error` mais oubliait `canceled`. Aucune n'était fausse
 * isolément ; ensemble elles ne décrivaient pas le même monde. Un statut
 * `skipped` introduit dans l'ordonnanceur était terminal pour lui, inconnu
 * pour la projection — qui le lisait comme un succès — et non terminal pour
 * les panneaux, où la tâche tournait indéfiniment.
 *
 * Ce module est donc la seule définition. Les alias existent parce que les
 * agents externes en produisent : `error` pour `failed`, `succeeded` pour
 * `done`, `canceled` pour `cancelled`. Les normaliser à l'entrée évite d'avoir
 * à les reconnaître à chaque comparaison.
 */

/** Succès : la tâche a produit ce qu'on attendait d'elle. */
export const SUCCESS_STATUSES = Object.freeze(['done', 'complete', 'completed', 'success', 'succeeded']);
/** Échec : la tâche a été tentée et n'a pas abouti. */
export const FAILURE_STATUSES = Object.freeze(['failed', 'error', 'stalled']);
/** Annulation : arrêtée par une décision, pas par un défaut. */
export const CANCELLED_STATUSES = Object.freeze(['cancelled', 'canceled']);
/** Abandon : jamais tentée, parce qu'elle ne pouvait plus l'être. */
export const SKIPPED_STATUSES = Object.freeze(['skipped']);
/** En attente : pas encore exécutable, mais susceptible de le devenir. */
export const PENDING_STATUSES_LIST = Object.freeze(['pending', 'pending_approval', 'waiting_approval']);
/** En cours : un agent y travaille en ce moment. */
export const ACTIVE_STATUSES = Object.freeze(['running', 'in_progress', 'started', 'starting']);

const ALIASES = new Map([
  ...SUCCESS_STATUSES.map((status) => [status, 'done']),
  ...FAILURE_STATUSES.map((status) => [status, 'failed']),
  ...CANCELLED_STATUSES.map((status) => [status, 'cancelled']),
  ...SKIPPED_STATUSES.map((status) => [status, 'skipped']),
  ...ACTIVE_STATUSES.map((status) => [status, 'running']),
  // Les statuts d'attente restent distincts : `pending_approval` et
  // `waiting_approval` ne demandent pas la même chose que `pending`, et les
  // confondre ferait disparaître les demandes d'approbation.
  ...PENDING_STATUSES_LIST.map((status) => [status, status]),
]);

/**
 * Statut canonique, ou `null` si le vocabulaire ne le connaît pas.
 *
 * Le `null` est un résultat, pas un accident : c'est lui qui permet aux
 * appelants de traiter l'inconnu comme inconnu plutôt que de le ranger
 * silencieusement du côté qui les arrange.
 */
export function normalizeTaskStatus(status) {
  const value = String(status ?? '').trim().toLowerCase();
  if (!value) return null;
  return ALIASES.get(value) ?? null;
}

export function isSuccessful(status) {
  return normalizeTaskStatus(status) === 'done';
}

export function isFailed(status) {
  return normalizeTaskStatus(status) === 'failed';
}

export function isCancelled(status) {
  return normalizeTaskStatus(status) === 'cancelled';
}

export function isSkipped(status) {
  return normalizeTaskStatus(status) === 'skipped';
}

export function isPending(status) {
  const normalized = normalizeTaskStatus(status);
  return normalized != null && PENDING_STATUSES_LIST.includes(normalized);
}

export function isActive(status) {
  return normalizeTaskStatus(status) === 'running';
}

/** Terminal : plus rien n'arrivera à cette tâche dans ce run. */
export function isTerminal(status) {
  const normalized = normalizeTaskStatus(status);
  return normalized === 'done' || normalized === 'failed' || normalized === 'cancelled' || normalized === 'skipped';
}

/**
 * Terminal sans avoir réussi. Regroupe échec, annulation et abandon — la
 * distinction compte pour le rapport à l'utilisateur, pas pour décider si la
 * suite du plan peut s'appuyer dessus.
 */
export function isUnsuccessfulTerminal(status) {
  return isTerminal(status) && !isSuccessful(status);
}

/** Vrai pour un statut qu'aucun ensemble ne reconnaît. */
export function isUnknownStatus(status) {
  return String(status ?? '').trim() !== '' && normalizeTaskStatus(status) == null;
}
