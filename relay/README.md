# TrackMint blind relay / 极简盲中继

A ~120-line Node.js WebSocket relay for TrackMint live meetups. It forwards opaque
AES-256-GCM envelopes between clients in the same room, keeps no history, and never
sees the invite secret, plaintext positions, chat text, or photos.

一个约 120 行的 Node.js WebSocket 中继，用于 TrackMint 实时组队。它只在同一
房间内转发 AES-256-GCM 密文，不落盘、不记录消息内容，也拿不到邀请密钥、明文位置、
聊天文字或图片。

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

The `{room}` placeholder is required; TrackMint replaces it with the random 128-bit
public room id parsed from the invite, never with the invite secret. The relay must
keep the URL path exactly as `/room/<id>`.

在 TrackMint「设置 → 组队中继」中选择自建 WS 中继，并填入包含 `{room}` 的地址。
`{room}` 会替换为邀请中随机生成的 128 位公共房间标识，不会包含邀请密钥。

## Production notes / 部署提示

- Put the relay behind TLS (Caddy, Nginx, Cloudflare Tunnel). Browsers require `wss://`
  when the app is served over HTTPS.
- `GET /healthz` returns `{ ok, rooms, clients }` for monitoring. No room ids or message
  content are exposed.
- Limits: 128 KB frames, 32 clients per room, 2,000 rooms, 10,000 total clients, and a
  30-second ping/pong heartbeat. Each socket gets a token bucket of 8 messages/second
  with a 40-message burst, plus a 512 KiB/second byte bucket with a 2 MiB burst;
  exceeding either closes the socket with `1008 rate limit`, including binary
  frames that are rejected rather than forwarded. A peer whose queued
  outbound bytes would exceed 512 KiB is closed with `1013 slow consumer`.
  Frames above the configured cap close with `1009 payload too large`.
  Rooms with no traffic for 12 hours are swept every 60 seconds and their sockets
  closed with `1001 room idle`. Adjust the constants at the top of `server.mjs` if needed.
- These caps are per relay process. For a public relay, also add per-IP connection and
  request limiting at the reverse proxy (Nginx `limit_conn`/`limit_req`, Caddy
  `rate_limit`, or a Cloudflare rule); the relay itself does not identify users and
  cannot distinguish clients behind the same NAT.
- The relay is intentionally stateless: no database, no message queue, no replay. Late
  joiners see no history, matching the app's ephemeral chat contract.
- Anyone who knows a room id can join that room and receive its ciphertext. The relay
  cannot decrypt it, but a malicious participant who obtains the full invite (room id
  and secret) can. Share invites only through trusted channels and use a private relay
  if you want to reduce metadata exposure.

## Test / 测试

```bash
cd relay
npm test
```

The test starts two rooms on an ephemeral port, checks same-room forwarding,
cross-room isolation, binary-frame rejection, the health endpoint, abusive socket
limits, idle cleanup, byte-rate enforcement, slow-consumer isolation, and the
128 KB image-frame boundary (100 KB accepted, 129 KB rejected).
