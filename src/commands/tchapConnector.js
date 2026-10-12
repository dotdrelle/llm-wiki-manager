import { parseJsonText } from '../core/activity.js';
import { callMcpTool, formatMcpToolResult } from '../core/mcp.js';
import { openExternalUrl } from '../shell/openExternal.js';

/**
 * `/connector … tchap` — the Tchap bridge of agent-connectors, as
 * deterministic shell commands. Same tools Donna calls
 * (`connectors_tchap_*`); the agent owns every rule (one sign-in for all
 * workspaces, one forum per workspace, activation from the forum). The
 * manager only renders the facts — it never decides who may speak.
 */

export const TCHAP_ACTIONS = ['auth', 'remove', 'signout'];

async function callTchap(session, tool, args = {}) {
  const result = await callMcpTool(session.mcp, 'connectors', tool, args);
  return parseJsonText(formatMcpToolResult(result)) ?? {};
}

/**
 * Only the MCP refusal of a Tchap tool means "the bridge is not offered here"
 * (CONNECTORS_BRIDGE_ENABLED=false registers none). Any other not-found — an
 * HTTP 404 from a wrong endpoint, a proxy — is a real failure and is reported
 * as such, never passed off as a configuration choice.
 */
export function isMissingTchapTool(error) {
  const text = error instanceof Error ? error.message : String(error);
  return /\btool\s+["'`]?connectors_tchap_\w+["'`]?\s+not found\b/i.test(text)
    || /\bunknown tool\b[^\n]*connectors_tchap_/i.test(text);
}

/**
 * One line for `/connector list`. A deployment that forbids the bridge
 * (CONNECTORS_BRIDGE_ENABLED=false) offers no Tchap tool: said, not hidden.
 */
export async function tchapListLine(session) {
  let status;
  try {
    status = await callTchap(session, 'connectors_tchap_status', { workspace: session.workspace });
  } catch (error) {
    if (isMissingTchapTool(error)) return 'tchap: disabled in this deployment (CONNECTORS_BRIDGE_ENABLED=false).';
    return `tchap: unavailable (${error instanceof Error ? error.message : String(error)}).`;
  }
  if (status.ok === false) return `tchap: unavailable (${status.error ?? 'status failed'}).`;
  if (status.pending?.userCode) {
    return `tchap: sign-in pending — open ${status.pending.verificationUri} and confirm the code ${status.pending.userCode}.`;
  }
  if (!status.connected) {
    const cause = status.lastError ? ` (${status.lastError})` : '';
    return `tchap: not connected${cause}. Run \`/connector auth tchap #forum:server\` to attach a forum to this workspace.`;
  }
  const account = `account ${status.account}`;
  if (!status.forum) return `tchap: ${account}, no forum for this workspace. Run \`/connector auth tchap\` to list your forums.`;
  const bridge = status.bridge === 'awaiting_activation'
    ? 'awaiting /activate in the forum'
    : status.bridge === 'paused' ? 'paused (/start in the forum)' : 'active';
  const running = status.running ? '' : ` — bridge stopped${status.lastError ? ` (${status.lastError})` : ''}`;
  const allowed = Array.isArray(status.allowedUsers) ? `; allowed: ${status.allowedUsers.join(', ')}` : '';
  return `tchap: ${account}, forum ${status.forum}, ${bridge}${allowed}${running}.`;
}

/** `/connector auth tchap [forum]`, `/connector remove tchap`, `/connector signout tchap`. */
export async function tchapConnectorCommand(session, action, forum) {
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
    const closed = report.inviteOnly ? 'invitation only' : 'removed from the directory, history closed to non-members';
    return `Tchap forum ${report.name ?? forum} attached to workspace ${session.workspace} (${closed}). Type /activate in the forum to switch the bridge on.`;
  } catch (error) {
    if (isMissingTchapTool(error)) return 'Tchap bridge is disabled in this deployment (CONNECTORS_BRIDGE_ENABLED=false).';
    return `Tchap: ${error instanceof Error ? error.message : String(error)}.`;
  }
}
