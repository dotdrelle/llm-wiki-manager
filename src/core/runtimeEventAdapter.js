/**
 * Adapter RuntimeEvent -> événements natifs du manager (RFC § 16).
 *
 * Le flux d'événements d'un runtime externe est traduit ici dans le
 * vocabulaire du reducer (`core/agentEvents.js`) SANS aucune refonte de l'UI :
 *
 * - `message` devient un `assistant_message` : c'est ce que Donna affiche ;
 * - les événements d'action (`tool_*`, `subagent_*`, `approval_required`)
 *   deviennent des lignes de journal structurées (`runtime_log`) ;
 * - le raisonnement privé (`agent_thinking`) n'est jamais ré-émis (RFC § 15) ;
 * - les événements terminaux (`run_completed`/`run_failed`/`run_cancelled`)
 *   ne sont pas ré-émis : ils sont déjà portés par le poll `status()` du
 *   dispatcher, qui construit le résultat de tâche à partir de là.
 *
 * La fonction est pure et déterministe : un événement produit zéro ou
 * plusieurs descripteurs `{ type, payload }`. Le dispatcher porte l'identité
 * run/task au moment de la dépêche.
 */
export function mapRuntimeEvent(event) {
  const type = String(event?.type ?? '');
  switch (type) {
    case 'message': {
      const content = String(event?.content ?? event?.message ?? '').trim();
      return content ? [{ type: 'assistant_message', payload: { content } }] : [];
    }
    case 'tool_started':
      return log(`tool ${toolLabel(event)} started`);
    case 'tool_finished': {
      const duration = Number.isFinite(Number(event?.durationMs))
        ? ` (${Math.round(Number(event.durationMs))}ms)`
        : '';
      const summary = String(event?.resultSummary ?? '').trim();
      const error = String(event?.error ?? '').trim();
      if (error) return log(`tool ${toolLabel(event)} failed: ${error}${duration}`);
      return log(`tool ${toolLabel(event)} done${duration}${summary ? ` — ${summary}` : ''}`);
    }
    case 'subagent_started':
      // First-class timeline events (lot 2): the reducer tracks them and the
      // workflow projection renders each subagent as a child node of the run —
      // the timeline the events describe, not just one more log line.
      return [{ type: 'subagent_started', payload: { subagent: subagentLabel(event) } }];
    case 'subagent_finished':
      return [{ type: 'subagent_finished', payload: { subagent: subagentLabel(event) } }];
    case 'approval_required': {
      // Human-in-the-loop du runtime (RFC § 14) : l'analyse pré-exécution
      // devient une demande d'approbation native. Les mutations annoncées
      // deviennent les classes d'approbation ; le dispatcher attend qu'un
      // grant humain les couvre avant de débloquer le runtime.
      const proposal = event?.proposal && typeof event.proposal === 'object' ? event.proposal : {};
      const mutations = Array.isArray(proposal?.mutations) ? proposal.mutations : [];
      const classes = [...new Set(mutations.map((mutation) => String(mutation?.kind ?? '').trim()).filter(Boolean))];
      return [{
        type: 'approval.requested',
        payload: {
          approvalId: String(event?.approvalId ?? 'runtime-approval'),
          scope: 'run',
          approvalClasses: classes,
          reason: String(event?.reason ?? proposal?.summary ?? ''),
          proposal,
        },
      }];
    }
    // ── Activity (lot 2) ────────────────────────────────────────────────────
    //
    // The runtime's phases enrich the EXISTING business activity line; they do
    // not open a second axis of "phases" beside `projectWorkflow`. That is why
    // they travel as runtime_log here and are aggregated downstream, rather
    // than minting a new event type the reducer would have to reconcile.
    case 'phase_started':
      return log(`phase ${phaseLabel(event)} started`);
    case 'phase_finished': {
      const counters = phaseCounters(event);
      const outcome = event?.ok === false ? 'interrupted' : 'done';
      return log(`phase ${phaseLabel(event)} ${outcome}${counters}`);
    }
    case 'progress': {
      const label = String(event?.label ?? event?.phase ?? '').trim();
      return label ? log(`progress ${label}${phaseCounters(event)}`) : [];
    }
    // A heartbeat is liveness, not history: it proves the run is alive to
    // whoever is watching right now. It travels as its own NON-persisted event
    // so the run strip can read it, but it never reaches the journal — one
    // line per beat would bury what actually happened. Persisting is the
    // store's decision (NON_PERSISTED_EVENT_TYPES); dropping it here would
    // leave the strip with no liveness signal at all.
    case 'heartbeat':
      return [{
        type: 'runtime_heartbeat',
        payload: { elapsedMs: Number(event?.elapsedMs) || 0 },
      }];
    case 'finding': {
      const severity = String(event?.severity ?? '').trim();
      const summary = String(event?.summary ?? '').trim();
      if (!summary) return [];
      const path = String(event?.path ?? '').trim();
      const where = path ? ` at ${path}` : '';
      return log(`finding${severity ? ` [${severity}]` : ''} from ${String(event?.role ?? 'runtime')}${where}: ${summary}`);
    }
    // Maintenance the gateway performed on its own memory (eviction of an
    // inactive workspace, compaction of a thread). Not a failure — a notice,
    // so a reader can tell "the agent forgot an old workspace" from "the
    // agent broke".
    case 'notice': {
      const topic = String(event?.topic ?? 'notice').trim();
      const detail = String(event?.detail ?? '').trim();
      return log(`notice ${topic}${detail ? `: ${detail}` : ''}`);
    }
    // A degradation must announce itself — that is the whole contract. It is
    // never filtered, whatever else this adapter decides to keep quiet.
    case 'degraded': {
      const capability = String(event?.capability ?? 'capability').trim();
      const cause = String(event?.cause ?? 'unknown cause').trim();
      const fallback = String(event?.fallback ?? '').trim();
      return log(`degraded ${capability}: ${cause}${fallback ? ` — ${fallback}` : ''}`);
    }
    case 'run_started':
    case 'run_created':
    case 'agent_thinking':
    case 'run_completed':
    case 'run_failed':
    case 'run_cancelled':
      // Deliberately silent, and listed BY NAME so the silence is a decision
      // rather than a default: `agent_thinking` is private reasoning the chat
      // never shows, and the terminal events are already carried by the
      // dispatcher's own `status()` poll.
      return [];
    default:
      // Everything else is a type this manager does not know — most likely a
      // newer gateway talking to an older manager. Dropping it made that
      // version skew invisible: the events simply never arrived, and nothing
      // said so. One bounded line is the cost of knowing.
      return log(`unrecognized runtime event "${type || 'unnamed'}"${unknownDetail(event)}`);
  }
}

function phaseLabel(event) {
  return String(event?.phase ?? event?.label ?? 'unnamed');
}

function phaseCounters(event) {
  const parts = [];
  const tools = Number(event?.tools);
  const pages = Number(event?.pages);
  if (Number.isFinite(tools) && tools > 0) parts.push(`${tools} tool(s)`);
  if (Number.isFinite(pages) && pages > 0) parts.push(`${pages} page(s) read`);
  return parts.length > 0 ? ` — ${parts.join(', ')}` : '';
}

// Bounded on purpose: this is a diagnostic breadcrumb for a version skew, not
// a channel for an unknown payload to reach the journal whole.
const UNKNOWN_EVENT_DETAIL_MAX = 200;
function unknownDetail(event) {
  const keys = Object.keys(event ?? {})
    .filter((key) => !['type', 'runId', 'ts', 'sequence'].includes(key));
  if (keys.length === 0) return '';
  return ` (fields: ${keys.join(', ')})`.slice(0, UNKNOWN_EVENT_DETAIL_MAX);
}

function log(message) {
  return [{ type: 'runtime_log', payload: { message } }];
}

function toolLabel(event) {
  return String(event?.tool ?? event?.name ?? 'tool');
}

function subagentLabel(event) {
  return String(event?.subagent ?? event?.tool ?? event?.name ?? 'subagent');
}
