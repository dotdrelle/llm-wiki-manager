import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommandFailure, failureHint, rawFailureText } from './commandFailure.js';
import { localizedOperationFailure } from '../commands/slash.js';

const COMPOSE_COMMAND = 'Command failed: docker compose -f /home/p/.nvm/versions/node/v24/lib/node_modules/@dotdrelle/wiki-manager/docker-compose.yml -p wiki-juno --env-file /mnt/c/Users/p/Documents/docker/llm-wiki/.env up -d';

test('common docker failures map to a stable reason code', () => {
  const cases = [
    [{ message: `${COMPOSE_COMMAND}\ndocker: command not found` }, 'docker-not-installed'],
    [{ message: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.' }, 'docker-daemon-unavailable'],
    [{ stderr: 'Error response from daemon: manifest unknown' }, 'image-unavailable'],
    [{ stderr: 'Bind for 0.0.0.0:3100 failed: port is already allocated' }, 'port-already-in-use'],
    [{ stderr: 'error while creating mount source path: no such file or directory' }, 'workspace-path-unavailable'],
    [{ stderr: 'proxyconnect tcp: dial tcp 10.0.0.1:3128: i/o timeout' }, 'network-unreachable'],
    [{ stderr: 'no such service: all' }, 'unknown-service'],
    [{ code: 'ENOENT' }, 'command-not-found'],
    [{ message: `${COMPOSE_COMMAND}\nsomething nobody has seen before` }, 'unknown'],
  ];

  for (const [error, expected] of cases) {
    assert.equal(classifyCommandFailure(error), expected, `expected ${expected} for ${rawFailureText(error)}`);
  }
});

test('the fallback hint drops the command echo, compose warnings and host paths', () => {
  const error = {
    message: [
      COMPOSE_COMMAND,
      'time="2026-07-28T11:37:41+02:00" level=warning msg="The \\"CONNECTORS_MCP_PORT\\" variable is not set."',
      'error while creating mount source path /mnt/c/Users/p/Documents/docker/llm-wiki/workspaces/juno: denied',
    ].join('\n'),
  };

  const hint = failureHint(error);
  assert.doesNotMatch(hint, /Command failed/);
  assert.doesNotMatch(hint, /level=warning/);
  assert.doesNotMatch(hint, /--env-file|-f |docker compose/);
  // Only the basename survives: absolute paths describe this machine's install
  // layout and mean nothing to the person reading the answer.
  assert.doesNotMatch(hint, /\/mnt\/c/);
  assert.match(hint, /juno/);
});

test('a failed operation reaches Donna as facts, never as docker output', () => {
  const error = { message: `${COMPOSE_COMMAND}\nCannot connect to the Docker daemon at unix:///var/run/docker.sock.` };
  const result = localizedOperationFailure({ operation: 'start', target: 'workspace-services', error });

  assert.equal(result.rawOutput, true);
  assert.deepEqual(JSON.parse(result.output), {
    operation: 'start',
    target: 'workspace-services',
    status: 'failed',
    reason: 'docker-daemon-unavailable',
  });
  assert.doesNotMatch(result.output, /docker compose|--env-file|unix:\/\//);
  assert.doesNotMatch(result.agentTrigger, /docker compose|--env-file|unix:\/\//);
  assert.match(result.agentTrigger, /action concrète/);
});

test('an unclassified failure still carries a sanitized detail for Donna', () => {
  const error = { message: `${COMPOSE_COMMAND}\nsomething nobody has seen before` };
  const facts = JSON.parse(localizedOperationFailure({ operation: 'stop', target: 'agents', error }).output);

  assert.equal(facts.reason, 'unknown');
  assert.equal(facts.detail, 'something nobody has seen before');
});
