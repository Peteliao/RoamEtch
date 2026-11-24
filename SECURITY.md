# Security policy / 安全策略

RoamEtch is a local-first static PWA. There is no RoamEtch account service, no
business backend, and no cloud trip library. This document describes the security
model, the meetup encryption design, and how to report a vulnerability.

RoamEtch 是本地优先的静态 PWA，没有账号服务、业务后端或云端行程库。本文说明
安全边界、组队加密设计以及漏洞反馈方式。

## Reporting a vulnerability / 漏洞反馈

Please use GitHub private vulnerability reporting:

**https://github.com/Peteliao/RoamEtch/security/advisories/new**

Do **not** open a public issue containing an exploit, a meetup invite, a shared
trip link, a personal track, or other sensitive data. If private reporting is
unavailable, open a minimal public issue asking the maintainer to enable a
private channel — without technical details.

请优先使用 GitHub 的私密漏洞报告入口，不要在公开 Issue 中贴出利用代码、组队邀请、
分享链接或个人轨迹。维护者会尽力在 7 天内确认收到报告，并在修复可用后协调披露。
This is a volunteer project; there is no bug bounty.

## Supported versions / 支持范围

Only the current `main` branch and the latest hosted build are supported. The
hosted demo is served from GitHub Pages and is rebuilt on every push to `main`.

## Security model / 安全边界

### Local-first data

- Trips, track points, waypoints, photos, and preferences are stored in the
  browser (IndexedDB / localStorage). They are not uploaded to a RoamEtch
  server because no such server exists.
- Local data is **not encrypted at rest by the app**. It relies on the browser
  profile and OS disk protection. Anyone who can unlock the device and open the
  same browser profile can read it.
- Clearing browser data or uninstalling the PWA deletes local trips. Users should
  export a full backup before doing so.
- Quick camera shots keep the stored 1600 px JPEG and, during the open camera
  session only, a full-resolution original in memory. The original is not written
  to IndexedDB or a backup; it leaves the app only when the user taps “save
  original” and completes the system share, save-picker, or download flow. A
  browser cannot silently insert files into the OS photo gallery.
- Meetup QR scanning decodes only a single frame or a user-selected image. Album
  QR images pass the same JPEG/PNG/WebP header, byte, and pixel bounds as other
  local image inputs before any pixel decode, and recognized text is normalized
  through the v2 invite parser.
- Full-library backup ZIPs are **not encrypted**. They contain complete tracks,
  waypoints, and photos, and can be read by anyone who obtains the file. They do
  carry SHA-256 checksums so the app can detect corruption or modification before
  restoring, but checksums are neither confidentiality nor authenticity: an
  attacker who rewrites the archive can also recompute the checksums.
- Restore treats the archive as untrusted: it caps compressed/uncompressed size,
  entry count, per-entry size, manifest size, point count, and compression ratio;
  rejects duplicate or non-whitelisted paths; and verifies manifest counts and
  record relationships before a single transactional write.

### Share links

- Shared trip data and meetup invites live in the URL `#` fragment. Browsers do
  not send fragments to the web server. A share link is a bearer capability:
  anyone who receives it can read the embedded trip or join the meetup.
- Compact share links are simplified and privacy-cropped locally, and contain no
  photos. A received link is imported into the recipient's local database.

### Meetup end-to-end encryption

Live meetups use protocol v2. The invite is a bearer capability that contains a
public room id and a high-entropy secret; only the room id reaches the relay.
Version 1 invites and packets are rejected rather than downgraded.

| Item | Design |
| --- | --- |
| Invite | `TM2.<roomId>.<secret>`; both components are base64url and live only in the URL `#` fragment / QR code |
| Room id | 16 random bytes from `crypto.getRandomValues` (128 bits, 22 base64url chars); independent of the secret |
| Invite secret | 32 random bytes from `crypto.getRandomValues` (256 bits, 43 base64url chars) |
| Encryption key | `HKDF-SHA-256(ikm = 32-byte secret, salt = "trackmint-meet-v2", info = "aes-256-gcm meet payload v2\|room:<roomId>")`, derived as a non-extractable AES-256-GCM key |
| Cipher | AES-256-GCM |
| Nonce | 96 bits = 64-bit random per-device prefix + 32-bit monotonic counter; a new prefix is generated for every session, and exhaustion aborts sends |
| AAD | `"trackmint-meet-v2-aad:" + roomId` |
| Envelope | `0x02` version byte + 12-byte nonce + ciphertext/tag, base64url-encoded |
| Ordinary-packet replay protection | Positions, chat, and ordinary control packets carry a per-sender, strictly increasing sequence number. Repeated or older sequences are dropped. Timestamps are a secondary ±5-minute sanity check, and locations also enforce newer sequence ordering. |
| RTC signaling | The encrypted `k: "rtc"` branch carries message, session, sender and target ids plus type, timestamp and payload. It is processed before the ordinary sequence guard because redundant brokers can reorder signaling independently; misaddressed, malformed, older-than-30-second or over-5-second-future signals are rejected. A 500-entry sender/message-id deduplicator and a 40-signals-per-3-seconds per-sender limiter bound replay and flooding. Outgoing signaling uses a separate bounded queue so it cannot block the location/chat send chain. |
| Chat dedupe | Random message ids plus a bounded seen-set, in addition to the sender sequence |
| Transport limits | Client and relay cap packets at 128 KB. The bundled relay also enforces a per-socket token bucket (8 msg/s, 40 burst), 32 clients per room, 2,000 rooms, 10,000 clients, and a 12-hour idle-room sweep |
| Public MQTT nodes | Concurrent subscriptions to `broker-cn.emqx.io:8084`, `broker.emqx.io:8084`, and `mqtt-dashboard.com:8884`; the fastest response starts the session immediately and every connected node also receives outgoing ciphertext as redundancy. A custom URL replaces this set unless it is the legacy default |
| MQTT topic | `${prefix}/${roomId}` (new default prefix `roametch/v2/meet`; existing saved legacy prefixes remain valid) |
| WS path | `/room/{room}` (the relay must preserve this path) |

The `trackmint-meet-v2` salt/AAD are legacy wire identifiers retained for protocol
compatibility; changing them would break existing rooms. New installs default to
`roametch/v2/meet`, while saved custom or legacy topic prefixes remain valid.

The room id is random and carries no key material. A party that observes the
MQTT topic or WS path learns only that public id and cannot derive the AES key
from it. The 256-bit invite secret never appears in a topic, URL query, HTTP
path, or relay log. Anyone who obtains the full invite can decrypt the session
and must be treated as a room member.

### On-demand WebRTC originals

- P2P original transfer is **off by default** and requires an explicit local opt-in with an IP-visibility notice. The encrypted thumbnail is sent first; no peer connection is created until a receiver chooses **Load original**. The requester generates a session id, and the file holder reuses it and always acts as Offerer, avoiding SDP glare.
- Only `pull-req`, `pull-reject`, `offer`, `answer`, `ice`, and `abort` are accepted. Signals include message/session/sender/target ids and timestamps, are AES-256-GCM encrypted inside the meetup envelope, and use the RTC-specific replay and rate controls above. Leaving, being removed, resetting the invite, or disabling local P2P closes affected sessions.
- The original travels over an ordered, reliable WebRTC DataChannel protected by DTLS, not over MQTT/WS. Signaling and file metadata are encrypted; the relay never receives original bytes. A configured TURN server can carry the encrypted DataChannel traffic when a direct route is unavailable.
- Files use JSON metadata and exact 16 KiB binary chunks with an explicit chunk count and EOF. The receiver rejects short, empty, extra, or out-of-budget chunks. SCTP buffered-byte thresholds are 256 KB/64 KB; a sender handles at most two simultaneous transfers and rejects additional requests as busy.
- The connection must reach DataChannel-open within 10 seconds. Connected or stalled transfers close after 30 seconds without activity. Cancellation, abort, room teardown, timeout, checksum failure, and protocol errors close the session without interrupting location, text, or thumbnails.
- The receiver verifies SHA-256 and the encoded JPEG/PNG/WebP header, declared dimensions, byte size, and pixel budget before exposing the blob to the UI. Album-derived originals are bounded to 32 MB and 40 MP. A wrong file id/hash/size cannot reopen or replace another transfer.
- Sender memory is an LRU of at most 10 originals/50 MB; evicted files are expired. Receiver blob/object-URL state is bounded to 4 files/64 MB and keyed by peer + file id + SHA-256. Neither thumbnails nor originals are written to IndexedDB, backups, or a RoamEtch server.

### Ephemeral chat photos

- Chat photos are captured by an in-PWA `getUserMedia` viewfinder so the page
  normally stays in the foreground; there is no system-camera handoff. Optional
  album import briefly opens the system picker, then the camera, GPS and relay
  resume without being stopped by the app.
- Images use WebP where supported, otherwise JPEG, with quality and dimension
  stepping. The long edge starts at 720 px (480 px in low-data mode) and the raw
  image is capped at 56 KB before encryption and base64 expansion. The encrypted
  transport envelope is capped at 128 KB.
- A sender may send one image every 5 seconds; receivers enforce a 4.25-second
  per-sender image gap in addition to the existing text-rate limit. Packets are
  checked for base64 shape/size, allowed MIME, integer dimensions, and valid
  optional WGS-84 coordinates/accuracy before entering session state. Before any
  pixel decode or object URL creation, the encoded WebP/JPEG header must be valid,
  match those declared dimensions, and stay within the 720 px edge and 518,400
  pixel budget. Local album inputs are separately bounded to 32 MB and 40 MP,
  with JPEG/PNG/WebP headers checked before object URL creation or pixel decode.
- Chat thumbnails exist only in session memory. The latest 20 image payloads are
  kept; older payloads are nulled and show an expired placeholder. HD originals
  use the separate bounded P2P caches described above. Object URLs are bounded
  and revoked, and neither thumbnails nor originals are written to IndexedDB,
  uploaded to a RoamEtch server, or added to backup archives.
- Closing the camera stops only its media tracks and re-arms the iOS keepalive
  video. It does not stop geolocation or the meetup relay. Capture coordinates,
  when available, travel inside the encrypted image packet.

### What a relay can see / 中继可见信息

A public MQTT broker or a self-hosted meetup relay can observe the random room
id, connection timestamps, packet sizes and timing, and the client's IP address.
It cannot see positions, names, chat text, thumbnails, HD originals, or the
invite secret. Larger ciphertext frames can reveal that a chat thumbnail or RTC
signal is being transmitted, but not its contents. Original bytes bypass this
relay entirely. Neither transport stores messages or provides history replay.

When P2P originals are enabled, the two devices can observe each other's network
IP addresses during ICE negotiation and transfer. STUN servers see binding
requests and public address mappings; a configured TURN server sees relay
allocation, traffic timing/volume, and the client's address as well. TURN relays
encrypted DataChannel bytes and cannot read their contents. WebRTC is therefore
not an anonymity mechanism, and custom STUN/TURN operators become additional
network observers.

### Known limitations / 已知局限

- **No per-sender authentication.** The v2 protocol fixes invite entropy,
  nonce uniqueness, and replay handling, but anyone who holds the invite can
  still send packets with an arbitrary display name, colour, sender id, or host
  claim. Host controls (expiry announcements, kick requests) are cooperative UI
  features, not a cryptographic access-control boundary. Ephemeral device
  identity keys, authenticated host authority, and key rotation after a member
  leaves are the next protocol phase.
- **Host-kick authority depends on the transport.** On the public MQTT broker,
  anyone who knows the room id can subscribe and publish, and the broker offers
  no kick API, so the host has no connection-level authority at all. On a
  self-hosted relay, the operator can close sockets or block an IP, but the
  relay cannot verify which device is the actual host, so such blocks are
  coarse and affect every member behind the same address. In both cases an
  in-app kick asks collaborating clients to drop the member; a modified client
  can ignore it and keep receiving ciphertext.
- **No forward secrecy.** The invite secret derives one session key. If the
  invite leaks, ciphertext captured during that session can be decrypted. Reset
  the invite to create a new room and key. Periodic key ratcheting / MLS is not
  implemented yet.
- **Public relay availability.** The default public MQTT nodes
  (`broker-cn.emqx.io`, `broker.emqx.io`, and `mqtt-dashboard.com`) are shared
  test brokers. They can be rate-limited, disconnected, or observed. Connecting
  to several concurrently improves reachability but does not make them private;
  use the custom MQTT or WS relay option for private groups, and send invites
  through a trusted channel.
- **Client-side enforcement only.** A malicious client can keep or re-share data
  it has already decrypted. The app cannot force another device to delete
  positions, messages, thumbnails, or originals.
- **P2P reveals network metadata.** Opting into originals exposes peer network IP
  addresses during ICE negotiation/transfer and relevant metadata to STUN/TURN.
  A TURN fallback can relay encrypted bytes. The setting is off by default and
  does not change the encrypted MQTT/WS path used by location, text, thumbnails,
  and signaling.
- **Not an emergency tool.** Meetup is not SOS, rescue, or safety-critical
  communication. GPS pauses when the OS suspends the browser.

### Third-party network requests

Map tiles, elevation, place names, and routing services receive the coordinates
or viewport needed for the feature being used, plus ordinary network metadata.
Photo EXIF location is stripped before storage. Meetup, sharing, and core
recording/analysis do not send tracks to a RoamEtch server. See the project
README for the full data-boundary description.

## Dependency and cache hygiene

- The production bundle is built from pinned `package-lock.json` dependencies.
  `npm audit --omit=dev` reports zero vulnerabilities; i18next is pinned to the
  patched 26.3.4 release, and MapLibre GL JS is pinned to a release that includes
  the style sanitizer fix.
- The Workbox build toolchain currently carries moderate `glob` / `minimatch`
  advisories. They run only during the local/CI production build, are not part
  of the shipped bundle, and have no upstream fixed release compatible with the
  current Workbox 7.4.1 pin yet; re-check with `npm audit` when updating
  `vite-plugin-pwa` / Workbox.
- The service worker caches only same-origin app assets and viewed map tiles,
  with bounded LRU caches and quota-error eviction.
- Third-party SDKs, remote fonts, analytics, and telemetry are intentionally not
  used. Please keep it that way in contributions.

## 中文摘要

- 组队邀请同时包含随机房间标识（128 位）与随机密钥（256 位），只存在于 URL `#` 片段与本机内存；中继只看到房间标识与 AES-256-GCM 密文。
- 房间标识与密钥相互独立，主题/路径不包含邀请密钥；每个会话使用独立 nonce 前缀与单调计数器。普通包按发送者严格递增序号防重放；RTC 信令因多中继可能乱序而单独按发送者/消息 ID 去重，校验 30 秒时效并限制每发送者 3 秒 40 条，使用独立有界发送队列。
- 旧版 12 位组队码与 v1 数据包会被明确拒绝，不会静默降级；升级后需重新生成邀请。
- 组队端到端加密目前仍没有发送者身份认证，也没有前向保密；邀请泄露等同于房间内容泄露。设备身份签名、发起人认证、成员变动后的密钥轮换与 MLS/前向保密属于下一阶段。
- 聊天缩略图在网页内存中压缩后加密发送，原始图片上限 56 KB，加密传输包上限 128 KB；发送冷却 5 秒，接收按发送者限流，仅保留最新 20 张，不写入 IndexedDB 或备份。中继可看到密文大小与时间，但看不到图片内容或可选拍摄坐标。
- 高清原图默认不传输。用户主动开启并加载后，才建立 DTLS 加密的一对一 WebRTC DataChannel：文件持有者固定为 Offerer，16 KiB 分片、SHA-256 与图片头校验，10 秒建连、30 秒空闲关闭；发送方最多 2 路并发、10 张/50 MB 缓存，接收方最多 4 张/64 MB。原图不经过组队中继、不落盘；但双方设备可见彼此网络 IP，STUN/TURN 可观察连接信息，TURN 还可能转发仍加密的字节。
- 本机数据不加密，依赖设备解锁；整库备份 ZIP 同样未加密，请妥善保管。请定期导出整库备份。恢复时会把压缩包视为不可信输入：限制大小、条目数、压缩比与点数，拒绝异常路径，并在单个事务中写入。漏洞请走私密报告入口。
