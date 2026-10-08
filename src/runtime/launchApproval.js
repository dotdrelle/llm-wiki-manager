/*
 Approve at launch. The approval never showed the content — it is produced
 after it — so it authorizes the action and what it will spend. Asked at the
 first write, it came ~33 s and four model calls late on juno: paid for before
 consent. A run that requires approval now asks before any model call. The
 grant covers the whole run whatever its plan revision becomes, so the tasks
 it delegates are covered too; a recovery replan still asks anew
 (`grantCoversTask` checks its recoveryRevision).
*/
export async function requestLaunchApproval(session, { runId, publicInput }) {
  if (!session?._runApprovalRequired || !session._requestApproval) return false;
  const label = String(publicInput ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  await session._requestApproval({
    scope: 'run',
    runId,
    reason: `Approve ${label} before it runs.`,
    plan: [label],
    anyRevision: true,
    timeoutMs: session._approvalTimeoutMs,
    signal: session._abortSignal,
  });
  session._runApprovalResolved = true;
  return true;
}
