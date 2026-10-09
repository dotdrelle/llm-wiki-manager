import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createContainerStats, parseDockerSize, parseStatsLine, summarizeSamples } from './containerStats.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

const line = (name, cpu, mem, net = '1kB / 2kB') =>
  JSON.stringify({ Name: name, CPUPerc: cpu, MemUsage: mem, NetIO: net, PIDs: '10' });

test('parses docker sizes and stats lines, ANSI clear codes included', () => {
  assert.equal(parseDockerSize('1.5GiB'), 1.5 * 1024 ** 3);
  assert.equal(parseDockerSize('12.3kB'), 12300);
  assert.equal(parseDockerSize('0B'), 0);
  const sample = parseStatsLine(`\x1b[2J\x1b[H${line('wiki-juno-serve-1', '12.5%', '100MiB / 7.7GiB')}`);
  assert.equal(sample.name, 'wiki-juno-serve-1');
  assert.equal(sample.cpuPercent, 12.5);
  assert.equal(sample.memUsedBytes, 100 * 1024 ** 2);
  assert.equal(parseStatsLine('CONTAINER ID   NAME'), null);
});

test('sums CPU, memory and network; the memory limit is the largest, not a sum', () => {
  const summary = summarizeSamples([
    parseStatsLine(line('a', '100%', '1GiB / 8GiB')),
    parseStatsLine(line('b', '42.3%', '512MiB / 8GiB')),
  ]);
  assert.equal(summary.containers, 2);
  assert.equal(summary.cpuPercent, 142.3);
  assert.equal(summary.memUsedBytes, 1.5 * 1024 ** 3);
  assert.equal(summary.memLimitBytes, 8 * 1024 ** 3);
  assert.equal(summary.netRxBytes, 2000);
  assert.equal(summary.pids, 20);
});

test('one stream per workspace, shared by every reader, stopped when nobody looks', async () => {
  let clock = 0;
  const spawned = [];
  const listed = [];
  let tickFn = null;
  const stats = createContainerStats({
    now: () => clock,
    idleMs: 30_000,
    listEveryMs: 30_000,
    listContainers: async (project) => { listed.push(project); return ['wiki-juno-serve-1', 'wiki-juno-wiki-1']; },
    spawnImpl: (cmd, args) => { const child = fakeChild(); spawned.push({ cmd, args, child }); return child; },
    setIntervalImpl: (fn) => { tickFn = fn; return 1; },
    clearIntervalImpl: () => { tickFn = null; },
  });
  assert.equal(stats.snapshot('juno').state, 'starting');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(listed, ['wiki-juno']);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, ['stats', '--format', '{{json .}}', 'wiki-juno-serve-1', 'wiki-juno-wiki-1']);

  spawned[0].child.stdout.emit('data', `${line('wiki-juno-serve-1', '10%', '1GiB / 8GiB')}\n${line('wiki-juno-wiki-1', '5%', '1GiB / 8GiB')}\n`);
  for (let i = 0; i < 5; i += 1) stats.snapshot('juno');
  const snap = stats.snapshot('juno');
  assert.equal(snap.state, 'live');
  assert.equal(snap.cpuPercent, 15);
  assert.equal(snap.containers, 2);
  assert.equal(spawned.length, 1, 'readers share the one stream');

  clock += 31_000;
  tickFn();
  assert.equal(spawned[0].child.killed, true);
  assert.deepEqual(stats.watching(), []);
});

test('an unavailable docker is reported, not shown as an empty line', async () => {
  const stats = createContainerStats({
    listContainers: async () => { const error = new Error('spawn docker ENOENT'); error.code = 'ENOENT'; throw error; },
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  stats.snapshot('juno');
  await new Promise((resolve) => setImmediate(resolve));
  const snap = stats.snapshot('juno');
  assert.equal(snap.state, 'unavailable');
  assert.equal(snap.error, 'docker command not found');
  stats.close();
});
