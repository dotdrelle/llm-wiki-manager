import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatcher, normalizeTaskError } from './dispatcher.js';

test('dispatcher returns a retryable logical failure when agent_execute reports workspace_busy', async () => {
  const session = {
    workspace: 'test',
    mcp: {
      production: {
        tools: [
          { name: 'agent_execute' },
          { name: 'agent_status' },
          { name: 'agent_cancel' },
        ],
      },
    },
  };
  const dispatcher = createDispatcher({
    session,
    callTool: async () => ({ accepted: false, error: 'workspace_busy', activeJobId: 'job-old' }),
  });

  const result = await dispatcher.execute(
    { id: 'ingest-a', requiredCapability: 'knowledge.update', operation: 'ingest_plan', arguments: {} },
    { serverName: 'production', agentInstanceId: 'production-main' },
    { attempt: { attemptId: 'ingest-a:attempt-1', locks: [], release() {} } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.taskId, 'ingest-a');
  assert.equal(result.attemptId, 'ingest-a:attempt-1');
  assert.equal(result.error.code, 'workspace_busy');
  assert.equal(result.error.retryable, true);
});

test('dispatcher forwards the orchestration run and required capability to agent_execute', async () => {
  let executeArgs;
  const session = {
    workspace: 'test',
    mcp: {
      production: {
        tools: [{ name: 'agent_execute' }, { name: 'agent_status' }, { name: 'agent_cancel' }],
      },
    },
    activities: {},
  };
  const dispatcher = createDispatcher({
    session,
    pollIntervalMs: 1,
    callTool: async (_mcp, _server, tool, args) => {
      if (tool === 'agent_execute') {
        executeArgs = args;
        return { accepted: true, jobId: 'job-build', status: 'queued' };
      }
      return { jobId: 'job-build', status: 'succeeded', terminal: true, result: { status: 'succeeded' } };
    },
  });

  await dispatcher.execute(
    { id: 'build-a', requiredCapability: 'document.build', operation: 'build', arguments: {} },
    { serverName: 'production', agentInstanceId: 'production-main' },
    { runId: 'run-donna-1', attempt: { attemptId: 'build-a:attempt-1', locks: [], release() {} } },
  );

  assert.equal(executeArgs.runId, 'run-donna-1');
  assert.equal(executeArgs.capability, 'document.build');
});

test('dispatcher completes when an executor-only agent reports succeeded', async () => {
  const session = {
    workspace: 'test',
    mcp: {
      connectors: {
        status: 'connected',
        tools: [
          { name: 'agent_execute' },
          { name: 'agent_status' },
          { name: 'agent_cancel' },
        ],
      },
    },
    activities: {},
  };
  const dispatcher = createDispatcher({
    session,
    pollIntervalMs: 1,
    callTool: async (_mcp, _server, tool) => {
      if (tool === 'agent_execute') {
        return { accepted: true, jobId: 'job-connectors', status: 'queued' };
      }
      return {
        jobId: 'job-connectors',
        status: 'succeeded',
        terminal: true,
        result: { status: 'succeeded', outputRefs: [] },
      };
    },
  });

  const result = await dispatcher.execute(
    {
      id: 'collect-mail',
      label: 'Collect mail',
      requiredCapability: 'external-source.collect',
      operation: 'collect',
      arguments: {},
    },
    { serverName: 'connectors', agentInstanceId: 'connectors' },
    { attempt: { attemptId: 'collect-mail:attempt-1', locks: [], release() {} } },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.jobId, 'job-connectors');
});

test('dispatcher normalizes a bare string error reported on a terminal agent_status', async () => {
  const session = {
    workspace: 'test',
    mcp: {
      connectors: {
        status: 'connected',
        tools: [
          { name: 'agent_execute' },
          { name: 'agent_status' },
          { name: 'agent_cancel' },
        ],
      },
    },
    activities: {},
  };
  const dispatcher = createDispatcher({
    session,
    pollIntervalMs: 1,
    callTool: async (_mcp, _server, tool) => {
      if (tool === 'agent_execute') {
        return { accepted: true, jobId: 'job-connectors', status: 'queued' };
      }
      return {
        jobId: 'job-connectors',
        status: 'failed',
        terminal: true,
        // Executor-only agents report the reason as a bare string, which the
        // contract permits; it must not be swallowed into a bare "failed".
        result: { status: 'failed', error: 'authentication_required' },
      };
    },
  });

  const result = await dispatcher.execute(
    {
      id: 'collect-mail',
      requiredCapability: 'external-source.collect',
      operation: 'collect',
      arguments: {},
    },
    { serverName: 'connectors', agentInstanceId: 'connectors' },
    { attempt: { attemptId: 'collect-mail:attempt-1', locks: [], release() {} } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'authentication_required');
  assert.equal(result.error.message, 'authentication_required');
  assert.equal(result.error.retryable, false);
});

test('dispatcher keeps a null error when a terminal status reports none', async () => {
  const session = {
    workspace: 'test',
    mcp: {
      connectors: {
        status: 'connected',
        tools: [{ name: 'agent_execute' }, { name: 'agent_status' }, { name: 'agent_cancel' }],
      },
    },
    activities: {},
  };
  const dispatcher = createDispatcher({
    session,
    pollIntervalMs: 1,
    callTool: async (_mcp, _server, tool) => (tool === 'agent_execute'
      ? { accepted: true, jobId: 'job-connectors', status: 'queued' }
      : { jobId: 'job-connectors', status: 'succeeded', terminal: true, result: { status: 'succeeded' } }),
  });

  const result = await dispatcher.execute(
    { id: 'collect-mail', requiredCapability: 'external-source.collect', operation: 'collect', arguments: {} },
    { serverName: 'connectors', agentInstanceId: 'connectors' },
    { attempt: { attemptId: 'collect-mail:attempt-1', locks: [], release() {} } },
  );

  assert.equal(result.ok, true);
  assert.equal(result.error, null);
});

test('normalizeTaskError keeps the agent reason as the message, never the fallback', () => {
  // Regression: the fallback describes only WHERE the failure was seen
  // ("agent_execute rejected task"). Letting it win discarded the one
  // actionable sentence — and left Donna to invent a cause.
  const error = normalizeTaskError("Error: source 'acpi' not found", {
    fallbackCode: 'execution_rejected',
    fallbackMessage: 'agent_execute rejected task',
  });

  assert.equal(error.code, "Error: source 'acpi' not found");
  assert.equal(error.message, "Error: source 'acpi' not found");
});

test('normalizeTaskError falls back only when the agent reports no reason at all', () => {
  const error = normalizeTaskError('', {
    fallbackCode: 'execution_rejected',
    fallbackMessage: 'agent_execute rejected task',
  });

  assert.equal(error.code, 'execution_rejected');
  assert.equal(error.message, 'agent_execute rejected task');
});
