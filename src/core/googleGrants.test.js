import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GOOGLE_GRANTS, GOOGLE_GRANT_LABELS, defaultGoogleGrants } from './googleGrants.js';

const connectorsSrc = (file) =>
  readFileSync(fileURLToPath(new URL(`../../../agent-external/agent-connectors/src/${file}`, import.meta.url)), 'utf8');

test('the grant names mirror the agent, spelling included', () => {
  // `modify` est le nom de Google (scope gmail.modify) et celui de l'agent.
  // Un synonyme côté manager créerait une troisième orthographe à tenir à jour
  // — le travers qui avait déjà donné une seconde paire de variables OAuth.
  const tokens = connectorsSrc('googleTokens.ts');
  const declared = tokens.match(/GOOGLE_GRANTS: readonly GoogleGrant\[\] = \[([^\]]+)\]/)?.[1] ?? '';
  const agentGrants = [...declared.matchAll(/'([a-z]+)'/g)].map(([, grant]) => grant);

  assert.deepEqual([...GOOGLE_GRANTS].sort(), agentGrants.sort());
});

test('every grant is described in plain words, never left as a bare token', () => {
  for (const grant of GOOGLE_GRANTS) {
    const label = GOOGLE_GRANT_LABELS[grant];
    assert.ok(label && label.length > 10, `${grant} needs a human description`);
    assert.notEqual(label, grant);
  }
});

test('the default asks for everything the agent can actually do', () => {
  // Un défaut plus étroit promet des actions que l'autorisation ne couvre pas :
  // `/connector auth google` ne demandait que `read`, et l'envoi comme le
  // marquage échouaient après coup, en ressemblant à des fonctions absentes.
  assert.deepEqual(defaultGoogleGrants().sort(), [...GOOGLE_GRANTS].sort());

  // Chaque droit du défaut doit ouvrir quelque chose de réellement exposé.
  const server = connectorsSrc('server.ts');
  const contract = connectorsSrc('contract.ts');
  assert.match(contract, /CAPABILITY_ID = 'external-source\.collect'/, 'read feeds the collect capability');
  assert.match(contract, /SEND_CAPABILITY_ID = 'communication\.send-email'/, 'send has a capability');
  assert.match(server, /'connectors_gmail_modify'/, 'modify has a tool');
});

test('the default grants are not mutated by the caller', () => {
  const first = defaultGoogleGrants();
  first.push('bogus');
  assert.deepEqual(defaultGoogleGrants().sort(), [...GOOGLE_GRANTS].sort());
});

test('the destructive Gmail tool needs approval and stays out of chat mode', () => {
  const script = readFileSync(fileURLToPath(new URL('../../wiki-workspace', import.meta.url)), 'utf8');
  const block = script.slice(script.indexOf('config.mcpServers.connectors ??='), script.indexOf('delete connectorAccess.allowActions'));
  const approval = block.slice(block.indexOf('requireApproval'), block.indexOf('chatAccess'));
  const chatAllow = block.slice(block.indexOf('connectorAccess.allow ='));

  assert.match(approval, /connectors_gmail_modify/, 'a destructive tool must be approval-gated');
  // /chat est en lecture seule : une mutation n'y a pas sa place, elle passe
  // par /agent où l'allow-list ne s'applique pas.
  assert.ok(!chatAllow.includes('connectors_gmail_modify'), 'chat mode must stay read-only');
});
