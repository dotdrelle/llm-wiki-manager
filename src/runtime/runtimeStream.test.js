import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { streamRuntimeEvents } from './client.js';

function sseServer(onStream) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    onStream(response);
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => { for (const socket of sockets) socket.destroy(); return new Promise((done) => server.close(done)); },
  })));
}

test('a stream that goes silent is abandoned instead of hanging forever', async () => {
  // One frame, then nothing — what a socket left over from a sleep looks like.
  const server = await sseServer((response) => response.write('event: state\ndata: {"ok":true}\n\n'));
  const seen = [];
  try {
    await assert.rejects(async () => {
      for await (const event of streamRuntimeEvents({ url: server.url, token: null, idleTimeoutMs: 150 })) seen.push(event.type);
    }, /silent/);
    assert.deepEqual(seen, ['state']);
  } finally {
    await server.close();
  }
});

test('comment pings keep a quiet stream alive', async () => {
  let timer;
  const server = await sseServer((response) => {
    let ticks = 0;
    timer = setInterval(() => {
      ticks += 1;
      if (ticks < 6) response.write(': ping\n\n');
      else { clearInterval(timer); response.end('event: done\ndata: {}\n\n'); }
    }, 50);
  });
  const seen = [];
  try {
    for await (const event of streamRuntimeEvents({ url: server.url, token: null, idleTimeoutMs: 150 })) seen.push(event.type);
    assert.deepEqual(seen, ['done']);
  } finally {
    clearInterval(timer);
    await server.close();
  }
});

test('the caller can still abort the stream', async () => {
  const server = await sseServer((response) => response.write(': ping\n\n'));
  const controller = new AbortController();
  try {
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(async () => {
      for await (const _event of streamRuntimeEvents({ url: server.url, token: null, signal: controller.signal, idleTimeoutMs: 10_000 })) { /* none */ }
    }, (err) => !/silent/.test(String(err?.message)));
  } finally {
    await server.close();
  }
});
