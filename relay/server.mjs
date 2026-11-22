// Minimal blind WebSocket relay for TrackMint live meetups.
// Rooms are keyed by the SHA-256-derived room id; the relay only forwards
// opaque AES-GCM envelopes and never stores or logs message content.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_CLIENTS_PER_ROOM = 32;
const HEARTBEAT_MS = 30_000;
const RATE_WINDOW_MS = 5_000;
const RATE_LIMIT = 40;

export function createRelayServer({ port = process.env.PORT || 8080, host = process.env.HOST || '0.0.0.0', log = () => {} } = {}) {
  const rooms = new Map();
  const httpServer = createServer((req, res) => {
    if (req.url === '/healthz') {
      let clients = 0;
      for (const peers of rooms.values()) clients += peers.size;
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, clients }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  httpServer.on('upgrade', (req, socket, head) => {
    const room = roomFromUrl(req.url);
    if (!room) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const peers = rooms.get(room) || new Set();
      if (peers.size >= MAX_CLIENTS_PER_ROOM) {
        ws.close(1013, 'room full');
        return;
      }
      peers.add(ws);
      rooms.set(room, peers);
      ws.room = room;
      ws.isAlive = true;
      ws.rateStart = Date.now();
      ws.rateCount = 0;
      log(`join ${room.slice(0, 8)} (${peers.size})`);

      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const now = Date.now();
        if (now - ws.rateStart >= RATE_WINDOW_MS) {
          ws.rateStart = now;
          ws.rateCount = 0;
        }
        if (++ws.rateCount > RATE_LIMIT) {
          ws.close(1008, 'rate limit');
          return;
        }
        const text = data.toString();
        if (!text) return;
        for (const peer of peers) {
          if (peer !== ws && peer.readyState === 1) {
            try { peer.send(text); } catch { /* peer close handles cleanup */ }
          }
        }
      });
      ws.on('close', () => {
        peers.delete(ws);
        if (!peers.size) rooms.delete(room);
        log(`leave ${room.slice(0, 8)} (${peers.size})`);
      });
      ws.on('error', () => {
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

  return {
    httpServer,
    wss,
    rooms,
    listen: () => new Promise((resolve) => httpServer.listen(port, host, () => resolve(httpServer.address()))),
    close: () => new Promise((resolve) => {
      clearInterval(heartbeat);
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
