# Security policy / 安全策略

TrackMint is a local-first static PWA. There is no TrackMint account service, no
business backend, and no cloud trip library. This document describes the security
model, the meetup encryption design, and how to report a vulnerability.

TrackMint 是本地优先的静态 PWA，没有账号服务、业务后端或云端行程库。本文说明
安全边界、组队加密设计以及漏洞反馈方式。

## Reporting a vulnerability / 漏洞反馈

Please use GitHub private vulnerability reporting:

**https://github.com/Peteliao/TrackMint/security/advisories/new**

Do **not** open a public issue containing an exploit, a meetup code, a shared
trip link, a personal track, or other sensitive data. If private reporting is
unavailable, open a minimal public issue asking the maintainer to enable a
private channel — without technical details.

请优先使用 GitHub 的私密漏洞报告入口，不要在公开 Issue 中贴出利用代码、组队码、
分享链接或个人轨迹。维护者会尽力在 7 天内确认收到报告，并在修复可用后协调披露。
This is a volunteer project; there is no bug bounty.

## Supported versions / 支持范围

Only the current `main` branch and the latest hosted build are supported. The
hosted demo is served from GitHub Pages and is rebuilt on every push to `main`.

## Security model / 安全边界

### Local-first data

- Trips, track points, waypoints, photos, and preferences are stored in the
  browser (IndexedDB / localStorage). They are not uploaded to a TrackMint
  server because no such server exists.
- Local data is **not encrypted at rest by the app**. It relies on the browser
  profile and OS disk protection. Anyone who can unlock the device and open the
  same browser profile can read it.
- Clearing browser data or uninstalling the PWA deletes local trips. Users should
  export a full backup before doing so.
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

- Shared trip data and meetup codes live in the URL `#` fragment. Browsers do not
  send fragments to the web server. A share link is a bearer capability: anyone
  who receives it can read the embedded trip or join the meetup.
- Compact share links are simplified and privacy-cropped locally, and contain no
  photos. A received link is imported into the recipient's local database.

### Meetup end-to-end encryption

The meetup code is a bearer secret and is never sent to a relay. The relay only
receives a room identifier and ciphertext.

| Item | Design |
| --- | --- |
| Code | 12 Crockford base32 characters (`0-9A-HJKMNP-TV-Z`), generated with `crypto.getRandomValues`; 60 bits of entropy |
| Room id | First 16 bytes of `SHA-256("trackmint-meet-code:" + code)`, hex-encoded (32 chars) |
| Encryption key | `HKDF-SHA-256(ikm = "trackmint-meet-code:" + code, salt = "trackmint-meet-v1", info = "aes-128-gcm meet payload")`, derived as a non-extractable AES-128-GCM key |
| Cipher | AES-128-GCM with a fresh 96-bit IV per packet |
| AAD | `"trackmint-meet-aad:" + roomId` |
| Envelope | 1 version byte + 12-byte IV + ciphertext/tag, base64url-encoded |
| Replay window | Packets carry a millisecond timestamp; packets older or newer than 5 minutes are dropped |
| Dedupe | Random message ids and a bounded seen-set for chat packets |
| Transport limits | Client and relay cap packets at ~8 KB |
| MQTT topic | `${prefix}/${roomId}` (default prefix `trackmint/v1/meet`) |
| WS path | `/room/{room}` (the relay must preserve this path) |

The room id is domain-separated from the key: a party that observes the MQTT
topic or WS path learns the hashed room id, but **cannot derive the AES key from
it without brute-forcing the 60-bit code**. The code itself never appears in a
topic, URL query, HTTP path, or relay log.

### What a relay can see / 中继可见信息

A public MQTT broker or a self-hosted relay can observe the room id, connection
timestamps, packet sizes and timing, and the client's IP address. It cannot see
positions, names, chat text, or the meetup code. Neither transport stores
messages or provides history replay.

### Known limitations / 已知局限

- **No per-sender authentication.** Any participant who holds the code can send
  packets with an arbitrary display name, colour, sender id, or host claim.
  Host controls (expiry announcements, kick requests) are cooperative UI
  features, not a cryptographic access-control boundary.
- **No forward secrecy.** The code derives one session key. If the code leaks,
  ciphertext captured during that session can be decrypted. Reset the code to
  start a new room and key.
- **Public relay availability.** The default `broker.emqx.io` is a shared public
  test broker. It can be rate-limited, disconnected, or observed. Use the custom
  MQTT or WS relay option for private groups, and send codes through a trusted
  channel.
- **Client-side enforcement only.** A malicious client can keep or re-share data
  it has already decrypted. The app cannot force another device to delete
  positions or messages.
- **Not an emergency tool.** Meetup is not SOS, rescue, or safety-critical
  communication. GPS pauses when the OS suspends the browser.

### Third-party network requests

Map tiles, elevation, place names, and routing services receive the coordinates
or viewport needed for the feature being used, plus ordinary network metadata.
Photo EXIF location is stripped before storage. Meetup, sharing, and core
recording/analysis do not send tracks to a TrackMint server. See the project
README for the full data-boundary description.

## Dependency and cache hygiene

- The production bundle is built from pinned `package-lock.json` dependencies.
  `npm audit --omit=dev` reports zero vulnerabilities; MapLibre GL JS is pinned
  to a release that includes the style sanitizer fix.
- The Workbox build toolchain currently carries moderate `glob` / `minimatch`
  advisories. They run only during the local/CI production build, are not part
  of the shipped bundle, and have no upstream fixed release yet; re-check with
  `npm audit` when updating `vite-plugin-pwa`.
- The service worker caches only same-origin app assets and viewed map tiles,
  with bounded LRU caches and quota-error eviction.
- Third-party SDKs, remote fonts, analytics, and telemetry are intentionally not
  used. Please keep it that way in contributions.

## 中文摘要

- 组队码只存在于 URL `#` 片段与本机内存；中继只看到 SHA-256 房间标识与 AES-GCM 密文。
- 房间标识与加密密钥使用不同域字符串分别派生，看到 Topic/路径无法直接得到密钥。
- 组队端到端加密没有发送者身份认证，也没有前向保密；组队码泄露等同于房间内容泄露。
- 本机数据不加密，依赖设备解锁；整库备份 ZIP 同样未加密，请妥善保管。请定期导出整库备份。恢复时会把压缩包视为不可信输入：限制大小、条目数、压缩比与点数，拒绝异常路径，并在单个事务中写入。漏洞请走私密报告入口。
