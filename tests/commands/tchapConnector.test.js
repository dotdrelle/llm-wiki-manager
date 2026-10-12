import assert from 'node:assert/strict';
import { test } from 'node:test';

import { tchapOffered, tchapStatusLine } from '../../src/commands/tchapConnector.js';

// "Disabled" is read from the agent's discovered tool list, not from error
// text: an HTTP 404 or an SDK rewording must never pass for
// CONNECTORS_BRIDGE_ENABLED=false.
test('the Tchap bridge is offered when the agent lists its tools, unknown when no list is known', () => {
  assert.equal(tchapOffered({ mcp: { connectors: { tools: [{ name: 'connectors_google_status' }, { name: 'connectors_tchap_status' }] } } }), true);
  assert.equal(tchapOffered({ mcp: { connectors: { tools: [{ name: 'connectors__connectors_tchap_status' }] } } }), true);
  assert.equal(tchapOffered({ mcp: { connectors: { tools: [{ name: 'connectors_google_status' }] } } }), false);
  assert.equal(tchapOffered({ mcp: { connectors: { tools: [] } } }), null);
  assert.equal(tchapOffered({}), null);
});

// The agent reads the raw fields once (`phase`); the shell only words it.
test('each phase of the agent becomes one line', () => {
  assert.match(tchapStatusLine({ phase: 'not_set_up' }), /not connected/);
  assert.match(tchapStatusLine({ phase: 'signin_pending', pending: { userCode: 'AB-12', verificationUri: 'https://auth.example/link' } }), /confirm the code AB-12/);
  assert.match(tchapStatusLine({ phase: 'signed_out', forum: 'Donna-demo', lastError: 'tchap_reauthorization_required' }), /signed out \(tchap_reauthorization_required\); forum Donna-demo kept/);
  assert.match(tchapStatusLine({ phase: 'awaiting_activation', account: '@me:x', forum: 'Donna-demo', allowedUsers: ['@me:x'] }), /awaiting \/activate in the forum; allowed: @me:x/);
  assert.match(tchapStatusLine({ phase: 'stopped', account: '@me:x', forum: 'Donna-demo', lastError: 'tchap_room_lost' }), /bridge stopped.*tchap_room_lost/);
});
