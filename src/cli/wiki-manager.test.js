import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExecutorOnlyFragment,
  forwardRuntimeApproval,
  mcpStatusNeedsRefresh,
  missingRequiredArguments,
  resolveExecutorArguments,
  resolvePreparedDelegationApproval,
  startupWizardGaps,
} from './wiki-manager.js';

const COLLECT_CAPABILITY = {
  description: 'Collect content from an external connector source.',
  inputSchema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      maxMessages: { type: 'integer' },
      query: { type: 'string' },
    },
  },
};

test('startup never opens the setup wizard just because agents are stopped', () => {
  const workspace = { kind: 'workspace', context: {} };
  assert.deepEqual(
    startupWizardGaps([
      { kind: 'agents', context: { downServices: ['cme', 'documents'] } },
      workspace,
    ]),
    [workspace],
  );
  assert.deepEqual(startupWizardGaps([{ kind: 'agents' }]), []);
});

test('interactive runtime refreshes configured MCP endpoints that started late', () => {
  assert.equal(mcpStatusNeedsRefresh({
    wiki: { url: 'http://127.0.0.1:3201/mcp', status: 'connected' },
    cme: { url: 'http://127.0.0.1:3336/mcp/', status: 'configured' },
  }), true);
  assert.equal(mcpStatusNeedsRefresh({
    wiki: { url: 'http://127.0.0.1:3201/mcp', status: 'connected' },
    cme: { url: 'http://127.0.0.1:3336/mcp/', status: 'connected' },
  }), false);
  assert.equal(mcpStatusNeedsRefresh({
    disabled: { url: null, status: 'missing' },
  }), false);
});

test('executor-only capabilities receive one manager-authored executable task', () => {
  const fragment = buildExecutorOnlyFragment({
    objective: 'donne-moi mes derniers mails',
    workspace: 'juno',
    selection: {
      capability: 'external-source.collect',
      operation: 'collect',
      arguments: { maxMessages: 10 },
      provider: {
        serverName: 'connectors',
        agentInstanceId: 'connectors-1',
        description: {
          contractVersion: '1',
          orchestration: { canPlan: false, singleTaskOnly: true },
        },
        capability: {
          mutationClass: 'external-source',
          defaultRequiresApproval: true,
        },
      },
    },
  });

  assert.equal(fragment.agentInstanceId, 'connectors-1');
  assert.equal(fragment.tasks.length, 1);
  assert.equal(fragment.tasks[0].requiredCapability, 'external-source.collect');
  assert.equal(fragment.tasks[0].operation, 'collect');
  assert.deepEqual(fragment.tasks[0].arguments, { maxMessages: 10 });
  assert.deepEqual(fragment.tasks[0].locks, ['external-source.collect:juno']);
  assert.equal(fragment.tasks[0].requiresApproval, true);
  assert.equal(fragment.tasks[0].approvalClass, 'external-source');
  assert.match(fragment.tasks[0].idempotencyKey, /^[0-9a-f-]{36}$/);
});

test('generic argument extraction fills the executor task from the objective', async () => {
  const llm = {
    completeWithTools: async () => ({
      tool_calls: [{
        function: { name: 'set_task_arguments', arguments: JSON.stringify({ maxMessages: 10 }) },
      }],
    }),
  };
  const args = await resolveExecutorArguments({
    llm,
    objective: 'récupère les 10 derniers mails',
    capability: COLLECT_CAPABILITY,
  });
  assert.deepEqual(args, { maxMessages: 10 });
});

test('argument extraction falls back to a JSON-text completion', async () => {
  const llm = {
    completeWithTools: async ({ tools }) =>
      tools.length > 0 ? { content: '' } : { content: '{"query":"from:linkedin.com"}' },
  };
  const args = await resolveExecutorArguments({
    llm,
    objective: 'les mails de LinkedIn',
    capability: COLLECT_CAPABILITY,
  });
  assert.deepEqual(args, { query: 'from:linkedin.com' });
});

test('argument extraction stays agnostic and safe when it cannot extract', async () => {
  // No inputSchema → no extraction attempted at all.
  assert.deepEqual(
    await resolveExecutorArguments({ llm: { completeWithTools: async () => ({}) }, objective: 'x', capability: {} }),
    {},
  );
  // Provider/LLM failure degrades to the executor's own defaults, never throws.
  const throwing = { completeWithTools: async () => { throw new Error('gateway rejected tool_choice'); } };
  assert.deepEqual(
    await resolveExecutorArguments({ llm: throwing, objective: 'les 10 derniers mails', capability: COLLECT_CAPABILITY }),
    {},
  );
});

test('required executor arguments become a conversational blocker before plan validation', () => {
  const schema = {
    type: 'object',
    required: ['to', 'subject', 'body'],
    properties: {
      to: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
    },
  };
  assert.deepEqual(missingRequiredArguments(schema, {}), ['to', 'subject', 'body']);
  assert.deepEqual(
    missingRequiredArguments(schema, { to: 'a@example.test', subject: 'Hello', body: 'Message' }),
    [],
  );
  assert.deepEqual(
    missingRequiredArguments(schema, { to: [], subject: ' ', body: 'Message' }),
    ['to', 'subject'],
  );
});

test('runtime approval bridge preserves the complete run-scoped grant', async () => {
  let forwarded = null;
  const request = {
    workspace: 'test4',
    workspaceId: 'test4',
    runId: 'run-1',
    scope: 'run',
    planRevision: 3,
    approvalClasses: ['mutation'],
  };

  const result = await forwardRuntimeApproval(async (workspace) => ({
    approvalManager: {
      approve(value) {
        assert.equal(workspace, 'test4');
        forwarded = value;
        return { approved: true };
      },
    },
  }), request);

  assert.deepEqual(forwarded, request);
  assert.deepEqual(result, { approved: true });
});

test('prepared delegation waits for explicit approval by default', () => {
  let calls = 0;
  const result = resolvePreparedDelegationApproval({
    runId: 'run-gated',
    approvalManager: {
      approve() {
        calls += 1;
      },
    },
  });

  assert.equal(calls, 0);
  assert.deepEqual(result, { approved: false, awaitingApproval: true });
});

test('prepared delegation only approves when autoApprove is explicitly true', () => {
  let forwarded = null;
  const result = resolvePreparedDelegationApproval({
    autoApprove: true,
    runId: 'run-headless',
    approvalManager: {
      approve(request) {
        forwarded = request;
        return { approved: true };
      },
    },
  });

  assert.deepEqual(forwarded, { scope: 'run', runId: 'run-headless' });
  assert.deepEqual(result, {
    approved: true,
    awaitingApproval: false,
    result: { approved: true },
  });
});

const EXPORT_CAPABILITY = {
  description: 'Export configured sources to workspace markdown files.',
  inputSchema: {
    type: 'object',
    additionalProperties: true,
    properties: { source_name: { type: 'string' } },
  },
};

test('argument extraction drops a value that only echoes the active workspace', async () => {
  // Regression: "exporter les pages Confluence du workspace acpi" against a
  // schema whose single free-text field is source_name. The model binds the
  // workspace name to it, and the executor fails with "source 'acpi' not
  // found". The workspace is already bound out of band, so the echo is noise.
  const llm = {
    completeWithTools: async () => ({
      tool_calls: [{
        function: { name: 'set_task_arguments', arguments: JSON.stringify({ source_name: 'acpi' }) },
      }],
    }),
  };

  assert.deepEqual(
    await resolveExecutorArguments({
      llm,
      objective: 'exporter les pages Confluence du workspace acpi',
      capability: EXPORT_CAPABILITY,
      workspace: 'acpi',
    }),
    {},
  );
});

test('argument extraction keeps a real value that is not the workspace name', async () => {
  const llm = {
    completeWithTools: async () => ({
      tool_calls: [{
        function: {
          name: 'set_task_arguments',
          arguments: JSON.stringify({ source_name: 'EAS_Avant_projet_ACPI' }),
        },
      }],
    }),
  };

  assert.deepEqual(
    await resolveExecutorArguments({
      llm,
      objective: 'exporter la source EAS_Avant_projet_ACPI',
      capability: EXPORT_CAPABILITY,
      workspace: 'acpi',
    }),
    { source_name: 'EAS_Avant_projet_ACPI' },
  );
});

test('argument extraction tells the model the workspace is already bound', async () => {
  let seenSystem = '';
  const llm = {
    completeWithTools: async ({ system }) => {
      seenSystem = system;
      return { tool_calls: [] };
    },
  };

  await resolveExecutorArguments({
    llm,
    objective: 'exporter les pages du workspace acpi',
    capability: EXPORT_CAPABILITY,
    workspace: 'acpi',
  });

  assert.match(seenSystem, /already runs against workspace "acpi"/);
});

test('argument extraction rejects a value outside the closed vocabulary', async () => {
  // Regression: "exporter les pages Confluence du workspace juno" — the
  // workspace guard removes "juno", so the model reaches for the next noun and
  // emits "Confluence". Only the agent knows the valid names; once it publishes
  // them as an enum, the orchestrator can check without guessing at meaning.
  const capability = {
    description: 'Export configured sources.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        source_name: { type: 'string', enum: ['EAS_Avant_projet_ACPI'] },
      },
    },
  };
  const llm = {
    completeWithTools: async () => ({
      tool_calls: [{
        function: { name: 'set_task_arguments', arguments: JSON.stringify({ source_name: 'Confluence' }) },
      }],
    }),
  };

  assert.deepEqual(
    await resolveExecutorArguments({
      llm,
      objective: 'exporter les pages Confluence du workspace juno',
      capability,
      workspace: 'juno',
    }),
    {},
  );
});

test('argument extraction keeps a value the vocabulary allows', async () => {
  const capability = {
    description: 'Export configured sources.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        source_name: { type: 'string', enum: ['EAS_Avant_projet_ACPI', 'autre'] },
      },
    },
  };
  const llm = {
    completeWithTools: async () => ({
      tool_calls: [{
        function: {
          name: 'set_task_arguments',
          arguments: JSON.stringify({ source_name: 'EAS_Avant_projet_ACPI' }),
        },
      }],
    }),
  };

  assert.deepEqual(
    await resolveExecutorArguments({
      llm,
      objective: 'exporter la source EAS_Avant_projet_ACPI',
      capability,
      workspace: 'acpi',
    }),
    { source_name: 'EAS_Avant_projet_ACPI' },
  );
});
