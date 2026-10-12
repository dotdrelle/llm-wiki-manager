import { callMcpTool } from '../core/mcp.js';
import { parseToolPayload, toolNameFor } from '../core/mcpPayload.js';
import { openExternalUrl } from '../shell/openExternal.js';

/**
 * `/connector … tchap` — the Tchap bridge of agent-connectors, as
 * deterministic shell commands. Same tools Donna calls
 * (`connectors_tchap_*`); the agent owns every rule (one sign-in for all
 * workspaces, one forum per workspace, activation from the forum) and sums
 * the state up in `phase`. The manager only puts that phase into words — it
 * never decides who may speak, nor reinterprets the raw fields.
 */

export const TCHAP_ACTIONS = ['auth', 'remove', 'signout'];

const DISABLED = 'tchap: not offered by the connectors agent in this deployment (CONNECTORS_BRIDGE_ENABLED=false).';

/**
 * Whether the connectors agent offers the Tchap tools, read from its
 * discovered `tools/list` (refreshed just before `/connector` runs): with
 * CONNECTORS_BRIDGE_ENABLED=false it registers none. `null` when the tool
 * list is not known — then the call itself tells what is wrong.
 */
export function tchapOffered(session) {
  const tools = session.mcp?.connectors?.tools ?? [];
  if (tools.length === 0) return null;
  return tools.some((tool) => /(^|__)connectors_tchap_status$/.test(String(tool?.name ?? '')));
}

async function callTchap(session, tool, args = {}) {
  return parseToolPayload(await callMcpTool(session.mcp, 'connectors', toolNameFor(session, 'connectors', tool), args));
}

const BRIDGE_PHASE = {
  awaiting_activation: 'awaiting /activate in the forum',
  active: 'active',
  paused: 'paused (/start in the forum)',
  stopped: 'bridge stopped',
};

/** One line for `/connector list`, from the agent's `phase`. */
export function tchapStatusLine(status) {
  const error = status.lastError ? ` (${status.lastError})` : '';
  switch (status.phase) {
    case 'disabled':
      return DISABLED;
    case 'not_set_up':
      return 'tchap: not connected. Run `/connector auth tchap #forum:server` to attach a forum to this workspace.';
    case 'signin_pending':
      return `tchap: sign-in pending — open ${status.pending?.verificationUri} and confirm the code ${status.pending?.userCode}.`;
    case 'signin_failed':
      return `tchap: sign-in failed (${status.pending?.error ?? status.lastError ?? 'unknown'}). Run \`/connector auth tchap\` again.`;
    case 'signed_out':
      return `tchap: signed out${error}${status.forum ? `; forum ${status.forum} kept, bridge stopped` : ''}. Run \`/connector auth tchap ${status.forum ? '<forum>' : '#forum:server'}\` to sign in again.`;
    case 'no_forum':
      return `tchap: account ${status.account}, no forum for this workspace. Run \`/connector auth tchap\` to list your forums.`;
    default: {
      const allowed = Array.isArray(status.allowedUsers) ? `; allowed: ${status.allowedUsers.join(', ')}` : '';
      const phase = BRIDGE_PHASE[status.phase] ?? String(status.phase ?? 'unknown');
      return `tchap: account ${status.account}, forum ${status.forum}, ${phase}${allowed}${status.phase === 'stopped' ? error : ''}.`;
    }
  }
}

export async function tchapListLine(session) {
  if (tchapOffered(session) === false) return DISABLED;
  try {
    const status = await callTchap(session, 'connectors_tchap_status', { workspace: session.workspace });
    if (status.ok === false) return `tchap: unavailable (${status.error ?? 'status failed'}).`;
    return tchapStatusLine(status);
  } catch (error) {
    return `tchap: unavailable (${error instanceof Error ? error.message : String(error)}).`;
  }
}

/** `/connector auth tchap [forum]`, `/connector remove tchap`, `/connector signout tchap`. */
export async function tchapConnectorCommand(session, action, forum) {
  if (tchapOffered(session) === false) return DISABLED;
  try {
    if (action === 'remove') {
      const result = await callTchap(session, 'connectors_tchap_disconnect', { workspace: session.workspace });
      if (result.ok === false) return `Tchap: ${result.error}.`;
      return result.hadForum
        ? `Tchap forum detached from workspace ${session.workspace}. The Tchap sign-in and the other workspaces' forums are kept.`
        : `Workspace ${session.workspace} had no Tchap forum.`;
    }
    if (action === 'signout') {
      const result = await callTchap(session, 'connectors_tchap_signout');
      if (result.ok === false) return `Tchap: ${result.error}.`;
      const stopped = result.stopped?.length ? ` Stopped: ${result.stopped.join(', ')}.` : '';
      const revoked = result.revoked ? 'session revoked' : `session forgotten locally (${result.reason ?? 'revocation failed'})`;
      return `Signed out of Tchap for every workspace: ${revoked}.${stopped} Forums are kept; one new sign-in brings them back.`;
    }
    if (!forum) {
      const listed = await callTchap(session, 'connectors_tchap_forums');
      if (listed.ok === false && listed.error === 'tchap_not_connected') {
        return 'Tchap is not connected yet. Give the forum address: `/connector auth tchap #forum:agent.<ministry>.tchap.gouv.fr` (create the forum in Tchap first).';
      }
      if (listed.ok === false) return `Tchap forums could not be listed (${listed.error}).`;
      const forums = Array.isArray(listed.forums) ? listed.forums : [];
      if (forums.length === 0) return 'No usable Tchap forum: create an unencrypted forum you administer, then `/connector auth tchap #forum:server`.';
      const lines = forums.map((item) => {
        const address = item.alias ?? item.roomId;
        const label = item.name ? `${item.name} — ${address}` : address;
        const others = (item.members ?? []).length > 1 ? `, ${item.members.length} members (must be alone)` : '';
        return `  ${item.usedBy ? `✗ ${label} (used by ${item.usedBy})` : `• ${label}${others}`}`;
      });
      const skipped = listed.skipped ? `\n(${listed.skipped} more rooms not examined.)` : '';
      return `Your Tchap forums:\n${lines.join('\n')}${skipped}\nRun \`/connector auth tchap <address>\` to attach one to workspace ${session.workspace}.`;
    }
    const result = await callTchap(session, 'connectors_tchap_connect', { workspace: session.workspace, room: forum });
    if (result.ok === false) return `Tchap: ${result.error}.`;
    if (result.pending) {
      const url = result.verificationUriComplete ?? result.verificationUri;
      const opened = openExternalUrl(url) ? 'opened in your browser' : `to open: ${url}`;
      return `Tchap sign-in ${opened} — confirm the code ${result.userCode} (valid ${Math.round((result.expiresInSeconds ?? 0) / 60)} min). This sign-in serves every workspace. Once confirmed, the forum is set up; then type /activate in it.`;
    }
    const report = result.report ?? {};
    const access = report.inviteOnly ? 'invitation only' : 'still joinable by address';
    const directory = report.directory === 'private' ? 'removed from the directory' : 'directory visibility unchanged';
    return `Tchap forum ${report.name ?? forum} attached to workspace ${session.workspace} (${access}, ${directory}, history closed to non-members). Type /activate in the forum to switch the bridge on.`;
  } catch (error) {
    return `Tchap: ${error instanceof Error ? error.message : String(error)}.`;
  }
}
