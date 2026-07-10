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
