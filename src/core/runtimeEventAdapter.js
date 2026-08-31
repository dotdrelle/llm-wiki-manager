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
      return log(`subagent ${subagentLabel(event)} started`);
    case 'subagent_finished':
      return log(`subagent ${subagentLabel(event)} finished`);
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
    case 'run_started':
    case 'run_created':
    case 'agent_thinking':
    case 'run_completed':
    case 'run_failed':
    case 'run_cancelled':
    default:
      return [];
  }
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
