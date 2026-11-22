import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createRelayServer } from './server.mjs';

const ROOM_A = 'a'.repeat(32);
const ROOM_B = 'b'.repeat(32);

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), 2000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('relays ciphertext only within the same room', async (t) => {
  const relay = createRelayServer({ port: 0, host: '127.0.0.1' });
  const address = await relay.listen();
  const base = `ws://127.0.0.1:${address.port}/room/`;
  const a = await connect(base + ROOM_A);
  const b = await connect(base + ROOM_A);
  const c = await connect(base + ROOM_B);
  t.after(async () => {
    for (const ws of [a, b, c]) ws.close();
    await relay.close();
  });

  const received = nextMessage(b);
  a.send('ciphertext-envelope');
  assert.equal(await received, 'ciphertext-envelope');

  let leaked = false;
  c.once('message', () => { leaked = true; });
  a.send('second-envelope');
  await delay(150);
  assert.equal(leaked, false);

  const health = await fetch(`http://127.0.0.1:${address.port}/healthz`).then((res) => res.json());
  assert.equal(health.ok, true);
  assert.equal(health.rooms, 2);
  assert.equal(health.clients, 3);
});

test('rejects malformed room paths and binary frames', async (t) => {
  const relay = createRelayServer({ port: 0, host: '127.0.0.1' });
  const address = await relay.listen();
  t.after(() => relay.close());
  await assert.rejects(connect(`ws://127.0.0.1:${address.port}/nope`));

  const a = await connect(`ws://127.0.0.1:${address.port}/room/${ROOM_A}`);
  const b = await connect(`ws://127.0.0.1:${address.port}/room/${ROOM_A}`);
  t.after(() => { a.close(); b.close(); });
  let leaked = false;
  b.once('message', () => { leaked = true; });
  a.send(Buffer.from('binary-frame'));
  await delay(150);
  assert.equal(leaked, false);
});
