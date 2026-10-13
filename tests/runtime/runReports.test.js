import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentEvent, dispatchAgentEvent, reduceAgentEvents } from '../../src/core/agentEvents.js';
import { reportFromToolResult, reportTitle } from '../../src/core/reports.js';
import { runOutcomeReports } from '../../src/runtime/runReports.js';

const longReport = `## Curation juno — résultat de la passe\n\n${'- une ligne du rapport\n'.repeat(40)}`;

test('a curation proposal becomes a fact and a button to its review page, never its report', async () => {
  const plan = [{ id: 'run-1:task-a', status: 'done', description: 'Curate', result: { rawStatus: { result: { worktreeProposal: {
    changes: [{ path: 'wiki/sources/a.md' }, { path: 'wiki/sources/b.md' }], objections: ['o1'], justification: longReport,
  } } } } }];
  const { facts, attachments } = await runOutcomeReports({}, plan);
  assert.match(facts, /Curation proposal ready for review: 2 changed file\(s\), 1 unresolved objection\(s\)/);
  assert.doesNotMatch(facts, /une ligne du rapport/);
  assert.deepEqual(attachments, [{ kind: 'proposal', target: '/agent-proposals/run-1%3Atask-a', title: 'Curation juno — résultat de la passe' }]);
});

test('a long agent report is written through the report tool and attached; a short one is a fact', async () => {
  const calls = [];
  const session = { mcp: { wiki: { status: 'connected', tools: [{ name: 'report_write' }] } } };
  const callTool = async (_mcp, server, tool, args) => {
    calls.push({ server, tool, args });
    return { content: [{ type: 'text', text: JSON.stringify({ report: { path: 'raw/untracked/Donna/2026-10-13-x.md.lock', title: args.title } }) }] };
  };
  const plan = [
    { id: 't1', status: 'done', result: { runtimeReport: longReport } },
    { id: 't2', status: 'done', result: { runtimeReport: 'Nothing to change.' } },
  ];
  const { facts, attachments } = await runOutcomeReports(session, plan, { callTool });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'report_write');
  assert.equal(calls[0].args.title, 'Curation juno — résultat de la passe');
  assert.deepEqual(attachments, [{ kind: 'report', target: 'raw/untracked/Donna/2026-10-13-x.md.lock', title: 'Curation juno — résultat de la passe' }]);
  assert.match(facts, /written as a document titled/);
  assert.match(facts, /Agent report: Nothing to change\./);
});

test('without a report tool the outcome says a report could not be written, and the log says why', async () => {
  const session = { mcp: {} };
  const { facts, attachments } = await runOutcomeReports(session, [{ id: 't', status: 'done', result: { runtimeReport: longReport } }]);
  assert.deepEqual(attachments, []);
  assert.match(facts, /could not be written as a document/);
  assert.ok((session.agentEvents ?? []).some((event) => event.type === 'runtime_log' && /no connected server offers report_write/.test(event.payload.message)));
});

test('attachments ride on the answer that announces them, and on its conversation entry', () => {
  const session = { _pendingAttachments: [{ kind: 'report', target: 'raw/untracked/Donna/r.md.lock', title: 'R' }] };
  dispatchAgentEvent(session, createAgentEvent('assistant_message', { origin: 'test', payload: { content: '' } }));
  dispatchAgentEvent(session, createAgentEvent('assistant_message', { origin: 'test', payload: { content: 'Le rapport est prêt.' } }));
  const entry = reduceAgentEvents(session.agentEvents).conversation.at(-1);
  assert.equal(entry.content, 'Le rapport est prêt.');
  assert.deepEqual(entry.attachments, [{ target: 'raw/untracked/Donna/r.md.lock', title: 'R', kind: 'report' }]);
  assert.deepEqual(session._pendingAttachments, []);
});

test('a report is recognised by shape, and its title is its first heading', () => {
  assert.deepEqual(reportFromToolResult('{"report":{"path":"raw/untracked/Donna/a.md.lock","title":"A"}}'), { kind: 'report', target: 'raw/untracked/Donna/a.md.lock', title: 'A' });
  assert.equal(reportFromToolResult('{"report":{"path":"wiki/x.md"}}'), null);
  assert.equal(reportFromToolResult('not json'), null);
  assert.equal(reportTitle('intro\n# **Titre** du rapport\nx', 'fallback'), 'Titre du rapport');
  assert.equal(reportTitle('pas de titre', 'fallback'), 'fallback');
});
