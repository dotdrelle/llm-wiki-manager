import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatcher } from './dispatcher.js';

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
