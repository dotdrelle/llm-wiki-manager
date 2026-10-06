import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createMaintenanceService } from './service.js';

// A refusal or a failed cycle must say why: "maintenance_execution_refused" and
// "cycle failed" alone left the panel — and Donna, asked about it — with
// nothing to explain (juno: an unreachable Confluence, an exhausted budget).
function service({ execute, runtime = null }) {
  const db = new DatabaseSync(':memory:');
  const provider = { serverName: 'cme', health: 'available', capability: { supportedOperations: ['export', 'doctor'], inputSchema: { type: 'object', additionalProperties: true } } };
  const session = {
    workspace: 'x',
    workspacePath: '/private/tmp/nonexistent-maintenance-test',
    mcp: { wiki: { tools: [{ name: 'wiki_maintenance_state' }] } },
    capabilityRegistry: { providersFor: (capability) => (capability === 'agent.maintain' ? (runtime ? [{ runtimeProvider: runtime, runtimeId: 'gw', health: 'available', capability: { supportedOperations: ['run'] } }] : []) : [provider]) },
  };
  const facts = { wikiHash: 'w', pending: [], index: { enabled: true, fresh: false }, deliverables: [], publications: [], proposals: [] };
  const access = { maintenanceAccess: { defaults: { enabled: true, limits: { sourceQuietMinutes: 0 } } } };
  const svc = createMaintenanceService({
    db,
    baseUrl: 'http://localhost',
    discover: async (s) => { s.runtimeProviderAgents = []; },
    getContext: async () => ({ session }),
    readDocument: () => access,
    callTool: async (_mcp, _server, tool, args) => {
      if (tool === 'wiki_maintenance_state') return facts;
      if (tool === 'agent_execute') return execute(args);
      if (tool === 'agent_status') return { status: 'done', result: {} };
      throw new Error(tool);
    },
  });
  return { db, svc };
}

test('an agent refusal written as plain text reaches the maintenance log', async () => {
  const { db, svc } = service({ execute: () => ({ accepted: false, error: 'Error: Confluence unreachable, export not started: liste-serveurs (no answer within 5 s)' }) });
  try {
    await assert.rejects(svc.runCandidate('x', 'c', { action: 'doctor', target: 'workspace' }), /Confluence unreachable/);
    const failure = svc.store.events('x').find((e) => e.kind === 'failure');
    assert.match(failure.message, /Confluence unreachable/);
    assert.doesNotMatch(failure.message, /maintenance_execution_refused/);
  } finally { await svc.close(); db.close(); }
});

test('a failed maintenance cycle says why it failed', async () => {
  const runtime = {
    execute: async () => ({ runId: 'gw-run' }),
    status: async () => ({ status: 'failed', error: 'maintenance_budget_exhausted' }),
    cancel: async () => {},
  };
  const { db, svc } = service({ execute: () => ({ accepted: true, jobId: 'job-1' }), runtime });
  try {
    await svc.tick('x');
    let failed;
    for (let i = 0; i < 100 && !failed; i++) {
      failed = svc.store.events('x').find((e) => /cycle failed/.test(e.message));
      if (!failed) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(failed, 'the cycle failure is logged');
    assert.match(failed.message, /cycle failed — .*budget/i);
  } finally { await svc.close(); db.close(); }
});
