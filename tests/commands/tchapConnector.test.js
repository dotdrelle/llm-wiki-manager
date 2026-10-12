import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isMissingTchapTool } from '../../src/commands/tchapConnector.js';

// Only the MCP refusal of a Tchap tool means the bridge is not offered in this
// deployment. A transport 404 or any other "not found" is a real failure, and
// reporting it as "disabled (CONNECTORS_BRIDGE_ENABLED=false)" sent the user
// to check a flag that was set to true.
test('a missing Tchap tool is recognized, other not-found errors are not', () => {
  assert.equal(isMissingTchapTool(new Error('Error [connectors.connectors_tchap_status]: MCP error -32602: Tool connectors_tchap_status not found')), true);
  assert.equal(isMissingTchapTool(new Error('Unknown tool: connectors_tchap_forums')), true);
  assert.equal(isMissingTchapTool(new Error('HTTP 404 Not Found')), false);
  assert.equal(isMissingTchapTool(new Error('workspace "demo" not found')), false);
  assert.equal(isMissingTchapTool(new Error('Tool connectors_google_status not found')), false);
});
