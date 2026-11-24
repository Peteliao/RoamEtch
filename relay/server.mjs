// Minimal blind WebSocket relay for TrackMint live meetups.
// Rooms are keyed by the SHA-256-derived room id; the relay only forwards
// opaque AES-GCM envelopes and never stores or logs message content.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_CLIENTS_PER_ROOM = 32;
const MAX_ROOMS = 2_000;
const MAX_CLIENTS = 10_000;
const ROOM_IDLE_MS = 12 * 60 * 60_000;
const SWEEP_MS = 60_000;
const MESSAGE_RATE = 8;
const MESSAGE_BURST = 40;
const MESSAGE_BYTE_RATE = 512 * 1024;
const MESSAGE_BYTE_BURST = 2 * 1024 * 1024;
const MAX_SEND_BUFFER_BYTES = 512 * 1024;
const HEARTBEAT_MS = 30_000;

function takeToken(ws, now, rate, burst) {
  if (ws.tokens == null) {
    ws.tokens = burst;
    ws.tokenAt = now;
  }
  ws.tokens = Math.min(burst, ws.tokens + ((now - ws.tokenAt) / 1000) * rate);
  ws.tokenAt = now;
  if (ws.tokens < 1) return false;
  ws.tokens -= 1;
  return true;
}

function takeByteTokens(ws, bytes, now, rate, burst) {
  if (ws.byteTokens == null) {
    ws.byteTokens = burst;
    ws.byteTokenAt = now;
  }
  ws.byteTokens = Math.min(burst, ws.byteTokens + ((now - ws.byteTokenAt) / 1000) * rate);
  ws.byteTokenAt = now;
  if (ws.byteTokens < bytes) return false;
  ws.byteTokens -= bytes;
  return true;
}

export function createRelayServer({
  port = process.env.PORT || 8080,
  host = process.env.HOST || '0.0.0.0',
  log = () => {},
  maxMessageBytes = MAX_MESSAGE_BYTES,
  maxClientsPerRoom = MAX_CLIENTS_PER_ROOM,
  maxRooms = MAX_ROOMS,
  maxClients = MAX_CLIENTS,
  roomIdleMs = ROOM_IDLE_MS,
  sweepMs = SWEEP_MS,
  messageRate = MESSAGE_RATE,
  messageBurst = MESSAGE_BURST,
  messageByteRate = MESSAGE_BYTE_RATE,
  messageByteBurst = MESSAGE_BYTE_BURST,
  maxSendBufferBytes = MAX_SEND_BUFFER_BYTES
} = {}) {
  const rooms = new Map();
  let clientCount = 0;
  const httpServer = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: clientCount }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: maxMessageBytes });

  httpServer.on('upgrade', (req, socket, head) => {
    const room = roomFromUrl(req.url);
    if (!room) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let state = rooms.get(room);
      if (!state && rooms.size >= maxRooms) {
        ws.close(1013, 'relay full');
        return;
      }
      if (clientCount >= maxClients) {
        ws.close(1013, 'relay full');
        return;
      }
      if (!state) {
        state = { peers: new Set(), lastActivity: Date.now() };
        rooms.set(room, state);
      }
      if (state.peers.size >= maxClientsPerRoom) {
        ws.close(1013, 'room full');
        return;
      }
      state.peers.add(ws);
      clientCount++;
      ws.room = room;
      ws.isAlive = true;
      log(`join ${room.slice(0, 8)} (${state.peers.size})`);

      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', (data, isBinary) => {
        const now = Date.now();
        if (!takeToken(ws, now, messageRate, messageBurst)
          || !takeByteTokens(ws, data.length, now, messageByteRate, messageByteBurst)) {
          ws.close(1008, 'rate limit');
          return;
        }
        if (isBinary || !data.length) return;
        state.lastActivity = now;
        for (const peer of state.peers) {
          if (peer === ws || peer.readyState !== 1) continue;
          if (peer.bufferedAmount + data.length > maxSendBufferBytes) {
            peer.close(1013, 'slow consumer');
            continue;
          }
          try { peer.send(data.toString('utf8'), { binary: false }); } catch { /* peer close handles cleanup */ }
        }
      });
      ws.on('close', () => {
        state.peers.delete(ws);
        clientCount = Math.max(0, clientCount - 1);
        if (!state.peers.size && rooms.get(room) === state) rooms.delete(room);
        log(`leave ${room.slice(0, 8)} (${state.peers.size})`);
      });
      ws.on('error', (err) => {
        if (/max payload/i.test(String(err?.message || ''))) {
          try { ws.close(1009, 'payload too large'); } catch { ws.terminate(); }
          return;
        }
        try { ws.terminate(); } catch { /* already closed */ }
      });
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* close handles it */ }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const sweep = roomIdleMs > 0
    ? setInterval(() => {
        const now = Date.now();
        for (const [room, state] of rooms) {
          if (now - state.lastActivity <= roomIdleMs) continue;
          rooms.delete(room);
          for (const ws of state.peers) {
            try { ws.close(1001, 'room idle'); } catch { /* already closed */ }
          }
          log(`idle ${room.slice(0, 8)}`);
        }
      }, Math.max(250, Math.min(sweepMs, roomIdleMs)))
    : null;
  sweep?.unref?.();

  return {
    httpServer,
    wss,
    rooms,
    listen: () => new Promise((resolve) => httpServer.listen(port, host, () => resolve(httpServer.address()))),
    close: () => new Promise((resolve) => {
      clearInterval(heartbeat);
      if (sweep) clearInterval(sweep);
      for (const ws of wss.clients) {
        try { ws.terminate(); } catch { /* already closed */ }
      }
      wss.close(() => httpServer.close(() => resolve()));
    })
  };
}

function roomFromUrl(url) {
  let pathname;
  try { pathname = new URL(url, 'http://relay.local').pathname; } catch { return ''; }
  const match = /^\/room\/([A-Za-z0-9_-]{8,128})$/.exec(pathname);
  return match ? match[1] : '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relay = createRelayServer({ log: (line) => console.log(`[relay] ${line}`) });
  const address = await relay.listen();
  console.log(`[relay] listening on ws://${address.address}:${address.port}/room/{room}`);
  const shutdown = async () => {
    await relay.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
