# TrackMint blind relay / 极简盲中继

A ~120-line Node.js WebSocket relay for TrackMint live meetups. It forwards opaque
AES-GCM envelopes between clients in the same room, keeps no history, and never
sees the 12-character meetup code or plaintext positions.

一个约 120 行的 Node.js WebSocket 中继，用于 TrackMint 实时组队。它只在同一
房间内转发 AES-GCM 密文，不落盘、不记录消息内容，也拿不到 12 位组队码或明文位置。

## Run locally / 本地运行

```bash
cd relay
npm install
npm start
# ws://localhost:8080/room/{room}
```

Docker:

```bash
docker build -t trackmint-relay ./relay
docker run --rm -p 8080:8080 trackmint-relay
```

Then open TrackMint **Settings → Team relay → Custom WS relay**, choose WebSocket,
and set:

```text
wss://your-relay.example.com/room/{room}
```

The `{room}` placeholder is required; TrackMint replaces it with the room id derived
from the meetup code. The relay must keep the URL path exactly as `/room/<id>`.

在 TrackMint「设置 → 组队中继」中选择自建 WS 中继，并填入包含 `{room}` 的地址。

## Production notes / 部署提示

- Put the relay behind TLS (Caddy, Nginx, Cloudflare Tunnel). Browsers require `wss://`
  when the app is served over HTTPS.
- `GET /healthz` returns `{ ok, rooms, clients }` for monitoring. No room ids or message
  content are exposed.
- Limits: 8 KB frames, 32 clients per room, 40 messages per 5 seconds per socket, and a
  30-second ping/pong heartbeat. Adjust the constants at the top of `server.mjs` if needed.
- The relay is intentionally stateless: no database, no message queue, no replay. Late
  joiners see no history, matching the app's ephemeral chat contract.
- Anyone who knows a room id can join that room and receive its ciphertext. The relay
  cannot decrypt it, but a malicious participant who obtains the meetup code can. Share
  codes only through trusted channels and use a private relay if you want to reduce
  metadata exposure.

## Test / 测试

```bash
cd relay
npm test
```

The test starts two rooms on an ephemeral port, checks same-room forwarding,
cross-room isolation, binary-frame rejection, and the health endpoint.
