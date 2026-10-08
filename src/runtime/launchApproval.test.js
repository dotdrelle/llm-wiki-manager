import test from 'node:test';
import assert from 'node:assert/strict';
import { requestLaunchApproval } from './launchApproval.js';
import { createApprovalManager } from './approvals.js';
import { approvalCovered } from '../orchestrator/approvalPolicy.js';

test('a run requiring approval asks at launch, before any model call', async () => {
  const requests = [];
  const session = { _runApprovalRequired: true, _requestApproval: async (request) => { requests.push(request); } };
  assert.equal(await requestLaunchApproval(session, { runId: 'r1', publicInput: '/wiki-build   templates/a.md' }), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].scope, 'run');
  assert.equal(requests[0].anyRevision, true);
  assert.match(requests[0].reason, /Approve \/wiki-build templates\/a\.md before it runs\./);
  assert.equal(session._runApprovalResolved, true);
  assert.equal(await requestLaunchApproval({ _runApprovalRequired: false, _requestApproval: async () => assert.fail() }, { runId: 'r2' }), false);
});

test('the launch grant covers the tasks the run delegates later, not a recovery replan', async () => {
  const session = { workspace: 'juno', planRevision: 0, agentEvents: [] };
  const manager = createApprovalManager(session);
  const waiting = manager.requestApproval({ scope: 'run', runId: 'r1', workspaceId: 'juno', anyRevision: true });
  const pending = manager.listPending?.() ?? [];
  manager.approve({ runId: 'r1', ...(pending[0]?.approvalId ? { approvalId: pending[0].approvalId } : {}) });
  await waiting;
  const grant = session.agentEvents.filter((event) => event.type === 'approval.granted').at(-1)?.payload;
  assert.equal(grant?.planRevision ?? null, null);
  const delegated = { id: 'ingest', requiresApproval: true };
  assert.equal(approvalCovered(delegated, [grant], { runId: 'r1', workspaceId: 'juno', planRevision: 3 }), true);
  assert.equal(approvalCovered({ ...delegated, recoveryRevision: 4 }, [grant], { runId: 'r1', workspaceId: 'juno', planRevision: 4 }), false);
  assert.equal(approvalCovered(delegated, [grant], { runId: 'other', workspaceId: 'juno', planRevision: 3 }), false);
});
