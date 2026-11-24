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
    ws.once('message', (data, isBinary) => {
      clearTimeout(timer);
      if (isBinary) {
        reject(new Error('unexpected binary frame'));
        return;
      }
      resolve(data.toString());
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function closeCode(ws) {
  return new Promise((resolve) => {
    ws.once('close', (code) => resolve(code));
    ws.once('error', () => { /* close event carries the code */ });
  });
}

function rejected(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('close timeout')), 2000);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.once('error', () => { /* server closes after rejecting */ });
  });
}

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

test('rate limits binary frames before rejecting them', async (t) => {
  const relay = createRelayServer({
    port: 0, host: '127.0.0.1', messageRate: 1, messageBurst: 2
  });
  const address = await relay.listen();
  const ws = await connect(`ws://127.0.0.1:${address.port}/room/${ROOM_A}`);
  t.after(() => { ws.terminate(); return relay.close(); });
  const closed = closeCode(ws);
  for (let i = 0; i < 4; i++) ws.send(Buffer.from(`binary-${i}`));
  assert.equal(await closed, 1008);
});

test('closes abusive sockets and caps rooms', async (t) => {
  const relay = createRelayServer({
    port: 0,
    host: '127.0.0.1',
    maxRooms: 1,
    messageRate: 1,
    messageBurst: 2
  });
  const address = await relay.listen();
  const base = `ws://127.0.0.1:${address.port}/room/`;
  t.after(() => relay.close());

  const a = await connect(base + ROOM_A);
  const b = await connect(base + ROOM_A);
  t.after(() => { a.close(); b.close(); });
  assert.equal(await rejected(base + ROOM_B), 1013);

  const limited = closeCode(a);
  for (let i = 0; i < 4; i++) a.send(`frame-${i}`);
  assert.equal(await limited, 1008);

  const health = await fetch(`http://127.0.0.1:${address.port}/healthz`).then((res) => res.json());
  assert.equal(health.rooms, 1);
  assert.equal(health.clients, 1);
});

test('rejects extra clients in a full room', async (t) => {
  const relay = createRelayServer({ port: 0, host: '127.0.0.1', maxClientsPerRoom: 1 });
  const address = await relay.listen();
  const base = `ws://127.0.0.1:${address.port}/room/`;
  t.after(() => relay.close());
  const a = await connect(base + ROOM_A);
  t.after(() => a.close());
  assert.equal(await rejected(base + ROOM_A), 1013);
  const health = await fetch(`http://127.0.0.1:${address.port}/healthz`).then((res) => res.json());
  assert.equal(health.rooms, 1);
  assert.equal(health.clients, 1);
});

test('closes oversized frames', async (t) => {
  const relay = createRelayServer({ port: 0, host: '127.0.0.1', maxMessageBytes: 256 });
  const address = await relay.listen();
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/room/${ROOM_A}`);
  t.after(() => { ws.terminate(); return relay.close(); });
  const closed = closeCode(ws);
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send('x'.repeat(512));
  assert.equal(await closed, 1009);
});

test('relays image-sized frames within the 128 KB limit', async (t) => {
  const relay = createRelayServer({ port: 0, host: '127.0.0.1' });
  const address = await relay.listen();
  const base = `ws://127.0.0.1:${address.port}/room/`;
  t.after(() => relay.close());
  const a = await connect(base + ROOM_A);
  const b = await connect(base + ROOM_A);
  t.after(() => { a.close(); b.close(); });

  const received = nextMessage(b);
  const imageFrame = 'A'.repeat(100 * 1024);
  a.send(imageFrame);
  assert.equal(await received, imageFrame);

  const closed = closeCode(a);
  a.send('B'.repeat(129 * 1024));
  assert.equal(await closed, 1009);
});

test('enforces a byte budget in addition to frame rate', async (t) => {
  const relay = createRelayServer({
    port: 0, host: '127.0.0.1', maxMessageBytes: 2048,
    messageByteRate: 0, messageByteBurst: 1200
  });
  const address = await relay.listen();
  const ws = await connect(`ws://127.0.0.1:${address.port}/room/${ROOM_A}`);
  t.after(() => { ws.terminate(); return relay.close(); });
  const closed = closeCode(ws);
  ws.send('x'.repeat(1300));
  await delay(50);
  ws.send('y'.repeat(1300));
  assert.equal(await closed, 1008);
});

test('closes slow consumers before queuing oversized fan-out buffers', async (t) => {
  const relay = createRelayServer({
    port: 0, host: '127.0.0.1', maxMessageBytes: 2048,
    maxSendBufferBytes: 1024
  });
  const address = await relay.listen();
  const base = `ws://127.0.0.1:${address.port}/room/${ROOM_A}`;
  const a = await connect(base);
  const b = await connect(base);
  t.after(() => { a.close(); b.close(); return relay.close(); });
  const closed = closeCode(b);
  a.send('x'.repeat(1500));
  assert.equal(await closed, 1013);
});

test('sweeps idle rooms and releases their sockets', async (t) => {
  const relay = createRelayServer({ port: 0, host: '127.0.0.1', roomIdleMs: 150, sweepMs: 50 });
  const address = await relay.listen();
  const ws = await connect(`ws://127.0.0.1:${address.port}/room/${ROOM_A}`);
  t.after(() => { ws.terminate(); return relay.close(); });
  const closed = closeCode(ws);
  assert.equal(await closed, 1001);
  const health = await fetch(`http://127.0.0.1:${address.port}/healthz`).then((res) => res.json());
  assert.equal(health.rooms, 0);
  assert.equal(health.clients, 0);
});
