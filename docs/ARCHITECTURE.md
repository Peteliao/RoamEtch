# RoamEtch architecture / 架构说明

RoamEtch is a static, local-first TypeScript PWA. There is no application server,
account system, cloud trip library, or analytics endpoint. The production artifact
is a folder of static files (`dist/`) that can be hosted on GitHub Pages, nginx, or
any static host.

RoamEtch 是纯静态、本地优先的 TypeScript PWA，没有业务后端、账号体系、云端行程库
或统计上报。构建产物是可部署到任意静态托管的 `dist/`。

## Runtime at a glance

```text
Browser APIs                       Core modules                     UI (native DOM)
────────────                       ────────────                     ───────────────
geolocation  ──► recorder ──► Dexie / IndexedDB ──► stats worker ──► views
wake lock         │                 │                                 record
fullscreen        │                 ├── trips / segments / chunks      trips ── detail (analysis / share)
visibility        │                 ├── waypoints / media / elevCache  meet
                  │                 └── settings (localStorage)        settings
                  ├── rewalk / simulator
                  ├── poster / replay + footprint video / promo
                  └── meetup crypto ──► MQTT WSS or WS relay
```

Key principles:

- **Local-first.** All trip data is written to IndexedDB before it is used for
  analysis or export. There is no account, server copy, or automatic background
  sync; device-to-device sync runs only while the user pairs two devices in
  Settings.
- **Pure logic stays separate.** `src/core/` contains framework-free TypeScript
  usable from tests and workers; `src/ui/` owns DOM, maps, charts, and dialogs.
- **WGS-84 is the storage contract.** Coordinates are stored, computed, shared,
  exported, and backed up as WGS-84. GCJ-02 exists only at the map rendering and
  picking boundary.
- **No framework.** Views are functions that create DOM nodes, subscribe to the
  event bus, and expose `resize` / `refresh` / `focus` / `destroy` hooks.

## Source layout

| Path | Responsibility |
| --- | --- |
| `src/main.ts` | Bootstrap: i18n, theme, region probe, damaged-row isolation, deep links (`#meet=`, `#t=`), `?demo=1`, `?sim=1`, and the `window.__lt` diagnostics handle. |
| `src/ui/shell.ts` | Top bar, region chip, four-tab navigation, view lifecycle, language rebuild, and recording/team status shortcuts. |
| `src/ui/state.ts` | Active trip, nested trip-detail section, and current view state shared by views. |
| `src/core/store.ts` | Dexie schema and low-level CRUD: trips, segments, 400-point track chunks, original snapshots, waypoints, media, elevation cache, and bounded previews. Raw table access stays in this storage layer and the repository adapters below. |
| `src/core/repositories.ts` | `TripRepository`, `MediaRepository`, and `BackupService` contracts plus their Dexie/backup adapters, used by services and views that must not open tables directly. |
| `src/core/routeRepository.ts` | Route loading/summary/segment boundary; preserves the optional-argument call shape used by lightweight mocks. |
| `src/core/syncDataRepository.ts` | Page-wise `SyncDataRepository` over trips, segments, media, track chunks, and waypoints. |
| `src/core/recorder.ts` | GPS watch, fix validation, gap segmentation, incremental persistence, live stats, wake lock and keep-alive. |
| `src/worker/compute.worker.ts`, `computeTasks.ts` | Shared compute workers and the pure task dispatcher: statistics, splits, simplification, coordinate transforms, cleanup/repair previews, GPX/GeoJSON/KML export, streamed GPX import, heatmaps, track comparison, annual reports, profile resampling, and backup archives. |
| `src/core/workerBridge.ts` | Worker pool/fallback, per-task cancellation, dedicated abortable workers, transferables, idle release, session tokens, and GPX streaming with acknowledgements. |
| `src/ui/map.ts` | MapLibre setup, region-specific raster styles, tile providers, and GCJ-02 render adapter. |
| `src/ui/analysis.ts` | Compact metric card (4 hero + 9 details), elevation/speed charts with hover and touch scrubbing, gap repair, GPS quality report, timeline and waypoints. |
| `src/ui/trips.ts` | Trip library plus nested trip detail (Overview / Data / Share): favorites, tags, search, filters, sorting, yearly footprint, import/export, and explicit trip actions. |
| `src/ui/backupFlow.ts` | Shared backup/restore UX: download (optionally password-encrypted), restore preview, integrity status, duplicate strategy, pre-restore snapshot, and privacy-safe operation history. |
| `src/ui/export.ts` | Share detail: privacy review, posters, replay videos, standalone HTML, files, and share link, with trip-version-aware output invalidation. |
| `src/core/trackVideo.ts` | Realtime canvas replay, four camera paths, photo cut-ins, synchronized profile cursor, intro/outro cards, and muxing the generated music track. |
| `src/core/shareStyle.ts` | Normalized presentation schema shared by posters, videos, and HTML/book export; no privacy or geometry logic. |
| `src/core/story.ts` | Local-day story chapters built independently of recording segments, with per-day stats, nodes, photos, daylight, and summaries. |
| `src/core/photoMatch.ts` | EXIF time/GPS candidate matching for trip photos; candidates are previewed before anything is written. |
| `src/core/weather.ts` | Open-Meteo URL/parse/summarize/cache helpers, manual weather merge, and explicit source/network/cache disclosure. Sunrise/sunset stays in `solar.ts`. |
| `src/core/travelBook.ts` | Printable single-file travel-book HTML; privacy cropping runs before day grouping and export. |
| `src/core/syncIdentity.ts`, `syncProtocol.ts`, `syncEngine.ts`, `syncStore.ts`, `syncTransport.ts`, `syncService.ts` | Device identity/pairing, wire format and hashes, incremental ledger engine, separate sync DB, encrypted blind-relay signaling plus authenticated WebRTC data channel, and the UI-facing service boundary. |
| `src/core/footprintShare.ts` | Aggregate-only yearly footprint artwork: 1080×1350 image and 9-second 1080×1920 video with original music. |
| `src/core/videoCapture.ts` | Shared MediaRecorder support check and MIME/bitrate selection (MP4/H.264 preferred, WebM fallback). |
| `src/core/promo.ts` | Generic promo artwork: eight designs per theme, preview cycling, immediate-repeat avoidance, and matching captions. |
| `src/core/music.ts` | Four original procedural loops: composition data, Web Audio synthesis, seamless tail wrap, random/manual selection, and MediaStream output. |
| `src/core/backup.ts` | Backup format v3: streamed ZIP inspection, 4 KiB decoder slices, central-directory validation, bounded manifest/media decoding, payload digest, per-media checksums, and transactional restore. |
| `src/core/restoreDrill.ts` | Guided production-pipeline rehearsal using synthetic rows and media in two isolated temporary Dexie databases, with conflict, corruption, cancellation, and cleanup checks. |
| `src/core/backupHistory.ts` | Independent IndexedDB store for the latest 20 allowlisted backup/restore/drill summaries; explicit clear and one-time legacy migration. |
| `src/core/backupCrypto.ts` | Optional backup encryption: PBKDF2-SHA-256 → AES-256-GCM `TRKMBKP1` envelope (`.roametch.enc`; older `.trackmint.enc` backups remain restorable). |
| `src/core/integrity.ts` | Deterministic JSON serialization and SHA-256 helpers. |
| `src/core/footprint.ts` | Year/month aggregation over `statsCache` for the footprint card. |
| `src/core/gpsQuality.ts` | Accuracy, poor fixes, time gaps, altitude jumps, and 0–100 quality score. |
| `src/core/meet*.ts` | Meetup invitations, HKDF/AES-256-GCM envelopes, ECDH pairwise channels, epoch-key rotation, per-teammate visibility, nonce and replay guards, MQTT/WS transport, session state. |
| `src/core/chatImage.ts` | Shared weak-network image ladder, byte/base64 caps, MIME/dimension/coordinate validation, cooldown and retention constants. |
| `src/ui/camera.ts` | Embedded `getUserMedia` viewfinder, chat compression/preview, local photo encoding, OLED idle/lock timers, track and object-URL cleanup. |
| `src/core/privacy.ts` | Start/end privacy cropping, sensitive waypoint hiding, EXIF stripping. |
| `src/core/gpx.ts`, `batch.ts`, `shareLink.ts`, `htmlExport.ts` | File, batch, compact-link, and standalone HTML formats. |
| `src/core/region.ts`, `providers.ts`, `coords.ts` | Service routing and China/global map adaptation. |
| `vite.config.ts` | PWA manifest, Workbox precache, bounded map-tile caches, chunk splitting. |
| `relay/` | Optional minimal WebSocket blind relay, deployed separately. |

## Data model

Dexie database `localtrace`, schema version 4:

- `trips`: id, activity, status, timestamps, name, tags, favorite, privacy,
  `statsCache`, and the optional `story` object (title, introduction, day notes,
  manual weather). Rows are ordered by `updatedAt`.
- `segments`: one continuous recording interval, indexed by trip and order.
- `trackChunks`: up to 400 points per row, linked to a trip and segment by sequence.
  Chunking keeps IndexedDB writes small and avoids rewriting a whole track.
- `trackSnapshots`: durable pre-clean point snapshots, linked to a trip and segment.
- `waypoints`: nodes with type, note, time, hidden flag, and linked media ids.
- `media`: EXIF-stripped photo blobs and thumbnails, linked to a trip.
- `elevCache`: elevation lookups with fetch time.
- `shareImports`: durable share-fragment fingerprint to imported trip mappings;
  this internal deduplication index is not part of user backup payloads.
- `quarantine`: recoverable copies of rows isolated during a damaged-data start,
  grouped by batch and source table.

`loadTripFull` assembles a trip with ordered segments, flattened chunks, waypoints,
and media metadata. `loadTripPreview` caps startup/recovery reads at 16 chunks and
500 points and omits media blobs. User preferences live separately in
`localStorage` through `core/settings.ts`; that is why a preferences reset cannot
delete trips. Backup/restore summaries live in the independent
`localtrace-backup-history` database so trip deletion, preference reset, and full
trip-database erasure do not remove them; only its explicit clear action does.

Backups serialize every table plus binary media into a `.trip` ZIP:

- `manifest.json` contains tables, counts, `mediaMeta`, and an `integrity` object.
- `integrity.payload` is SHA-256 over a deterministic, undefined-normalized JSON
  payload (key order and non-finite numbers do not change the digest).
- `integrity.files` records byte length and SHA-256 per media file.
- Version 1 archives are still accepted and reported as “no checksum”; version 2
  and v3 archives require valid integrity metadata and block restore when payload
  or media verification fails. A prepared inspection is reverified before restore,
  with media Blobs hashed incrementally again so mutating the cached manifest or
  files cannot reuse a stale successful result.
- Ordinary ZIP inspection consumes `File.stream()` incrementally. Decoder input is
  sliced at 4 KiB so a highly compressible chunk cannot allocate an unbounded
  decoded buffer before entry limits run. The manifest is decoded under a 16 MiB
  cap, and each media entry is hashed and assembled from bounded parts while
  enforcing actual-byte, entry, archive, and compression-ratio limits. The ZIP end
  record and central directory must agree with observed local entries. Legacy
  encrypted envelopes remain a one-shot compatibility path because AES-GCM
  decryption currently materializes the complete ciphertext and plaintext.
- Inspection enforces size, entry-count, compression-ratio, duplicate-path,
  manifest-size, point-count, and path/ID whitelist limits before decompression.
  Manifest counts and trip/segment/chunk/waypoint/media relationships are checked
  before restore; missing media blocks the restore.
- Restore reuses the inspected archive and writes all tables plus overwrite
  deletions in one IndexedDB transaction, so a failed media write rolls back
  previously deleted trips. Abort is checked inside the transaction; once the
  transaction commits, a late cancellation does not turn stored data into a
  reported failure.
- Full-library backups can optionally be password-encrypted into a
  `.roametch.enc` file (older `.trackmint.enc` backups remain restorable): a
  `TRKMBKP1` header, 16-byte random salt, 12-byte nonce,
  and AES-256-GCM ciphertext keyed by PBKDF2-SHA-256 with 600,000 iterations.
  The header (magic, version, KDF parameters) is authenticated as AAD, so
  tampering or a wrong password fails decryption cleanly. Encryption wraps the
  entire `.trip` archive; the inner archive keeps its own integrity digests.
- Unencrypted backups are **tamper-evident but not secret**: integrity is
  detection, not authenticity, because an attacker who rewrites the archive can
  recompute the checksums. Use the password option whenever the file leaves your
  own devices.

## Storage and service boundaries

`core/store.ts` owns the Dexie schema and low-level primitives; the adapters
below expose capabilities without leaking tables:

- `TripRepository` (list/get/create/update/delete/full load, segments, chunked
  point appends, waypoints) keeps views and services off raw tables.
- `MediaRepository` lists media metadata for a trip.
- `RouteRepository` loads a full route, a preview, or segment summaries and keeps
  the optional-argument call shape used by lightweight test mocks.
- `BackupService` exposes export/inspect/restore; archive construction runs in
  the compute worker.
- `SyncDataRepository` provides paged row iteration, get/put/delete, and trip
  enumeration for the sync ledger.
- `SyncService` is the only sync entry point for UI code: identity, invites,
  peers, summary, erase, and `sync()` with status/progress/abort callbacks.
  `syncService` wires the encrypted transport to `SyncEngine` and the sync DB and
  always closes the peer connection in `finally`.

Contract tests in `tests/repositories.test.ts` exercise each adapter against
fake IndexedDB, including transactional point edits, snapshots, media, and a
backup export/inspect round-trip. New storage implementations must satisfy the
same interfaces; track statistics, comparison, and export algorithms consume
plain route objects and do not import Dexie.

Only infrastructure modules open Dexie tables directly: `store.ts` (schema and
CRUD), the repository adapters above, `backup.ts` (cross-table export/restore),
`storageHealth.ts` (integrity scans and repairs), migrations/checkpoint recovery,
and the dedicated backup-history database. Feature views, services, sync code,
and recorder/editor flows use store helpers or repository methods instead of
`db.*`.

The device-sync ledger lives in a separate `roametch-sync` Dexie database
(`identity`, `ledger`, `peers`, and `meta`). It never stores trip rows, and
erasing sync state cannot touch `localtrace`. Preferences remain in
`localStorage`, backup history in `localtrace-backup-history`, and PWA UI state
in memory/session history, so each reset action has a bounded blast radius.

## Maintenance and atomic edits

- Gap repair resolves routes before writing, then replaces every affected segment
  in one transaction. The transaction rechecks `updatedAt` and exact point identity;
  undo/redo rejects deleted or subsequently edited target segments. Cancellation is
  rechecked after progress callbacks and bound to the active write transaction.
- GPS cleaning uses the same transaction-local chunk replacement helpers. Its
  Worker preview returns removal indexes and compact issue summaries rather than a
  second full trajectory; submission recomputes the plan before applying it.
  Cleanup and snapshot restoration bind cancellation to their write transactions.
- Storage-health scans use primary-key cursors in 500-row batches, yield between
  batches, retain only counters/sets/sample IDs, and expose progress plus abort.
  Media rows are processed one at a time and their Blob bytes are hashed in 64 KiB
  chunks, so same-size replacements do not evade revision checks or retain a media
  batch in memory. Table counts detect concurrent structural changes; a final
  cursor pass and count check share one read transaction and compare bounded
  content revisions to detect equal-count updates. The scan retries and fails
  explicitly if writes continue instead of returning a false corruption report.
- Original-track snapshot summaries aggregate through a cursor instead of loading
  every snapshot chunk into memory.
- The guided restore drill seeds synthetic rows and media in two uniquely named
  temporary databases, runs the real v3 export/inspect/restore pipeline, verifies
  exact media hashes plus skip/overwrite and corruption rollback, then deletes both
  databases. The main trip database is never passed as a target.
- Record finish, rename, quick-photo save/undo, and interrupted-trip recovery use
  track/waypoint reads or bounded previews. Active-recording reattachment also uses
  a bounded preview. Full media blobs are loaded only when analysis or export is
  explicitly opened.

## Recording pipeline

1. The UI starts a trip through `recorder.startRecording`, optionally in simulator
   mode (`?sim=1`).
2. `watchPosition` uses the selected accuracy preset. Each fix is validated for
   accuracy, stale timestamps, impossible jumps, and pause state.
3. A fix more than 5 minutes or 500 m from the previous accepted point starts a new
   segment. Background silence can also force a segment break on return.
4. Accepted points are buffered and flushed to `trackChunks` in small batches.
   Flushes are serialized; a failed write stays buffered, raises a visible error,
   and retries every five seconds. `pagehide` writes a synchronous localStorage
   spill that is replayed into the segment on the next boot. The chunk append,
   segment end time, and trip update time share one IndexedDB transaction.
   Live distance, ascent, speed, and accuracy are updated incrementally.
5. Wake lock, keep-alive audio, recorder locks, and visibility handling reduce the
   chance of the browser suspending a long recording. The OLED pocket lock is a
   passive, true-black dashboard that stays in the foreground and adds no
   hidden/blackout mode, because a hidden page lets browsers suspend geolocation.
   It has no recording-state controls; a 1.5-second hold unlocks it. Operating-system
   limits still apply; recording is not guaranteed with the screen off on every
   device.
6. Pause and finish refuse to complete while buffered points remain unwritten,
   and a failed resume restores the paused state instead of silently recording
   without geolocation.
7. Finishing writes `statsCache` through the statistics worker so the trip list and
   footprint can render without recomputing every track.
8. The record view can open the embedded camera while recording or paused. A
   shot is encoded locally as a 1600 px JPEG plus thumbnail and saved with a
   fresh-enough WGS-84 fix as a `photo` waypoint linked to `media` in one
   transaction; paused or stale captures request a one-shot position without
   creating a track point. Undo atomically removes the waypoint and only deletes
   media no other waypoint references. The OLED pocket lock pauses MapLibre
   rendering without destroying the live map, preserving loaded GeoJSON and the
   camera's map state. Normal-page finishing requires a 1.2-second hold or a right
   swipe; keyboard and assistive-technology activation remain available.

## Statistics and charts

`core/stats.ts` derives per-segment and total distance, wall duration, recorded
(active) time, moving/stopped time, gap time, speed, pace, ascent/descent, altitude
range, calories, and a difficulty / quality score. Only intervals up to 60 seconds
count as recorded time; pause and long-silence gaps are reported separately rather
than counted as standing still. The compute worker runs statistics,
simplification, coordinate transforms, cleanup/repair previews, GPX/GeoJSON/KML
conversion, heatmaps, track comparison, annual reports, profile resampling, and
backup archive construction. Shared workers receive ordinary tasks; a task with
an `AbortSignal` gets a dedicated worker so cancelling or timing out one job
cannot terminate another. Large point sets move as transferable columnar arrays,
idle shared workers are released, and every host carries a session token so a
late reply cannot settle a newer task. GPX files at or above 256 KiB stream
through a dedicated worker with acknowledgement backpressure. `workerBridge.ts`
falls back to synchronous execution only when a worker cannot start.
`analysis.ts` renders uPlot elevation and speed charts and links
cursor position to the MapLibre marker. Touch uses pointer capture for continuous
scrubbing and an adjacent readout, while `touch-action: pan-y` on the plot leaves
vertical page scrolling intact. `gpsQuality.ts` evaluates the raw samples that
produced the track, not a synthetic model.

## Maps and coordinates

The region detector chooses service routing (`cn` vs `global`) from a manual
override, a short tile probe, or timezone/language. It does not transform stored
coordinates. China basemaps that expect GCJ-02 receive a render-time conversion in
`ui/map.ts`; picking converts back to WGS-84 before anything is stored. Map tile
caches are bounded per provider and evicted on quota errors.

## Embedded camera

`ui/camera.ts` owns one active full-screen viewfinder. `getUserMedia` is invoked
synchronously from the opening click or OLED pointer-up so iOS treats it as a
user gesture; the page is not handed off to the system camera. Video dimensions
are read dynamically, frames are drawn to canvas, and every close/retake path
stops only camera tracks, revokes owned object URLs, clears timers, and re-arms
the 1 px iOS keepalive video. GPS watches and meetup relays are never stopped by
the camera.

Three modes share the viewfinder:

- `chat`: adaptive WebP/JPEG compression, immediate frozen preview, final size
  readout, optional caption, and encrypted send with coordinates refreshed at
  shutter time. Preview jobs are generation-scoped so a discarded capture cannot
  overwrite a newer one. Album inputs are bounded to 32 MB and 40 MP, and their
  JPEG/PNG/WebP headers are checked before object URL creation or canvas decode.
- `quick`: 1600 px JPEG plus a 300 px thumbnail, saved as a local photo waypoint.
  Each shot also holds a full-resolution JPEG in the camera closure, exposed as
  “save original” through Web Share files, the File System Access save picker,
  or an anchor download. The shutter stays available after every save so a burst
  becomes separate waypoints; the node editor can also open this mode and append
  each shot to the pending photo strip. Originals live only in camera memory and
  are never written to IndexedDB or backups.
- `oled`: opened by a predominantly horizontal left drag of at least 120 px from
  the bottom-right knob; taps and short drags are ignored. It auto-closes after
  20 seconds without interaction, and after a shot releases the camera and shows
  a 3-second return-to-lock card.

## Sharing and export

- GPX, GeoJSON, KML, batch ZIP, standalone HTML, poster, and replay video are
  generated locally from IndexedDB data.
- Compact share links put simplified, privacy-cropped data in the URL `#` fragment;
  fragments never reach the hosting server, and links contain no photos. A durable
  IndexedDB fingerprint index and transactional import prevent repeated links from
  creating duplicate trips across reloads or concurrent tabs.
- Posters and videos read the active theme palette and regenerate when the theme
  changes. A shared `shareStyle` schema normalizes background, layout, font, map
  ratio, track color/width, stats card, title, video camera, and photo cut-ins;
  the UI preview and every generator consume the same normalized value.
- Replay videos synthesize one of four original loops on-device with Web Audio
  oscillators and a generated reverb impulse. The loop's reverb tail is wrapped
  into its start for seamless repetition; the user chooses a track or leaves the
  default random selection. The audio track is muxed with the canvas stream, so
  no external music file or network request is involved. Camera presets are
  deterministic functions of replay progress (auto push-in/follow/pull-back,
  follow-only, aerial, fixed overview); photo cut-ins and the elevation/profile
  cursor are frame-derived, so cancel and retry produce the same result.
- Standalone HTML embeds the viewer data and script. Progress and profile pointer
  input set an explicit held replay value, so the next animation frame cannot
  overwrite a drag. Map progress, current marker, stats sheet, and profile cursor
  read that value; recording segments stay separate, and the photo lightbox and
  keyboard shortcuts are local script features with no network dependency.
- Yearly footprint sharing builds a 1080×1620 card or a 9-second 1080×1920 video
  from aggregate totals only. Names, track geometry, coordinates, waypoints, and
  photos are never passed to the artwork or its caption.
- Promo artwork is generic product art: eight feature templates plus 17 audience
  variants per theme, randomly selected without an immediate repeat, with a
  caption that matches the chosen layout. It reads no trip data.
- Story chapters are derived from the trip's local days rather than recording
  segments, so a midnight-spanning recording still reads as two days. Photo
  matching only proposes candidates; EXIF time/GPS values are previewed and
  require confirmation before a media row and waypoint link are written.
  Weather is fetched per day/location, labeled with source, sample time, cache
  state, and missing fields, and never presented as offline data. The travel
  book applies the same privacy object as other exports before grouping days,
  then emits a printable single-file HTML with disclosure text.
- Privacy checks (start/end circles, hidden waypoints, independent start/end
  marker hiding, EXIF stripping) are shown before sharing or export.

## Live meetup and relay

Version 2 invitations carry a random 128-bit public room id and an independent
256-bit secret in the URL `#` fragment or QR code; packets use protocol v3 over
the versioned wire envelope. Joining accepts a pasted code, a live camera QR
scan, or a QR image selected from the album; the latter two decode one frame and
normalize the text through the same invite parser, with `BarcodeDetector` where
available and jsQR as the cross-browser fallback. The secret derives a
non-extractable AES-256-GCM base room key via HKDF-SHA-256 with v2 domain
separation; the room id is used for routing and bound into the packet AAD.
Each session also generates ephemeral ECDH P-256 device keys. Presence packets
advertise the protocol range, feature version, epoch generation, and public key;
peers outside protocol 3, below feature 4, or without a key are refused with an
explicit reason instead of being silently downgraded. On join, leave, kick, or
host election the host creates a new 32-byte epoch secret and delivers it only
inside pairwise AES-256-GCM boxes derived from each visible peer's ECDH key.
Removed peers receive no new secret, and previous epoch keys are retained for
only 20 seconds for in-flight packets. A teammate can be hidden individually;
location, marker, and rally packets then stop using the room broadcast and are
sent only to other visible teammates as pairwise direct packets, while chat
remains on the room channel. Positions and ephemeral chat are encrypted
on-device and sent through the default public MQTT WSS providers
(`roametch/v2/meet/<roomId>`) or a custom WebSocket relay. Existing saved legacy or custom topic prefixes remain valid. The three public endpoints connect concurrently; the first successful
connection reports the session ready, all connected endpoints receive outgoing
ciphertext for redundancy, and duplicate envelopes are dropped by the per-sender
sequence and chat-id guards. An empty custom URL means this automatic set,
while a non-default custom URL replaces it. Each
device uses a random nonce prefix plus a monotonic counter, and every packet type
passes a per-sender strictly increasing sequence guard before it is accepted;
timestamps and chat ids are additional checks. Messages live in memory only: no
history, no late-joiner backfill, no persistence after the session ends. Chat
photos add MIME/base64/byte/dimension/coordinate validation, a 5-second sender
cooldown, a 4.25-second receiver gap, a 56 KB raw-image cap, and a latest-20
in-memory payload limit; encoded WebP/JPEG headers must match the declared size
and stay within a 720 px edge / 518,400 pixel budget before decoding. The
encrypted transport cap is 128 KB. Temporary `mk` markers and the host-only
`goal` rally point use the same envelope; marker expiry is anchored at receipt,
capped per peer/session, and re-published on reconnect with remaining lifetime
rather than extended. Sender-side sliding windows bound text, voice, markers, and
rally updates. Optional signed invite expiry (`iexp`/`isig`) is verified by the
joiner independently of the session timer, and exchanging protocol ranges lets
clients refuse incompatible peers explicitly instead of silently changing
packet semantics. Version 1 invitations and packets are rejected explicitly, so
an upgraded client cannot silently fall back to the old 60-bit protocol. Location publishing adapts to
movement: roughly every 5 seconds while the device is moving and a 25-second
heartbeat while stationary, so idle teammates stop consuming airtime. `relay/`
is a minimal blind-forwarding template with frame-size, message-rate, byte-rate,
per-peer send-buffer, room/client, and idle-TTL limits; it preserves text framing
and rate-limits rejected binary frames. It is not required by the static app.

## Device-to-device sync

Sync is an explicit, user-started operation, not a background account service.

- **Pairing.** The host creates an `RMS1.` code containing a short-lived random
  room id, an access secret, and the host device's public JWK/name. The guest may
  paste or scan it. Both sides derive a signal key with HKDF-SHA-256 and exchange
  AES-256-GCM signaling envelopes through the meetup blind relay (MQTT or WS).
  The relay therefore sees only a random room and ciphertext. Once ICE succeeds,
  ledger and record traffic move only over an ordered, DTLS-encrypted WebRTC data
  channel.
- **Identity.** Each installation generates an ECDSA P-256 key pair. Its
  public-key hash yields a stable `dev-…` id and a grouped fingerprint for human
  comparison. A signed hello binds the peer id, invite, role, and a nonce; a
  self-invite responder is rejected. The first successful pairing stores the peer
  fingerprint (TOFU), and later mismatches raise `sync-identity-changed` instead
  of silently re-pinning. Removing a peer deletes only local identity/ledger
  rows.
- **Ledger.** Tables are `trips`, `segments`, `media`, `trackChunks`, and
  `waypoints`. Each row gets a deterministic SHA-256 over normalized content,
  plus a version stamp and device id. The manifest pages entries (400 per page,
  up to 1,000,000), and each side sends `want` keys for missing or winning rows.
  Last-writer-wins uses stamp/device/hash ordering; a row that disappears after
  having been synced becomes a tombstone, so deletions propagate. A final digest
  over the whole sorted ledger must match before the summary reports success.
- **Limits and integrity.** Wire messages are capped at 384 KiB, media at 64 MiB
  per payload, 16 KiB per media chunk, 2,000 track points per row, and 2,000
  wanted keys per message. Records are re-hashed before send and after receive;
  media is reassembled with declared byte counts and SHA-256 checks. A local
  mutation during the run raises `sync-local-changed` rather than committing a
  mixed snapshot. Failed or cancelled transfers do not write the partial row.
- **Scope and lifecycle.** In-progress or paused trips that were never synced are
  excluded so an active recording cannot fork between devices; once finished, a
  later run includes them, and a trip previously synced while finished keeps
  converging if resumed. Settings, backup history, elevation cache, repair
  snapshots, quarantine, and chat are outside the ledger. Sync uses its own
  IndexedDB, so app-data reset/erase has separate effects. There is no server
  copy, account, or automatic retry when both devices are offline.

## Offline and updates

`vite-plugin-pwa` precaches the app shell, fonts, icons, and small media, while
runtime caches cover map tiles and elevation lookups with entry and age limits.
`registerType: prompt` keeps a new service worker waiting until the user confirms
an in-app update notice. The button is disabled while recording or paused, so a
reload cannot interrupt an active trip; recording state is never destroyed without
a confirmed update. During development, hard-refresh or clear the service worker
if an old build appears.

## Tests and CI

Vitest covers pure modules: coordinates, geo math, statistics, privacy cropping,
GPX/KML/GeoJSON, compact links, demo data, meetup crypto and cadence, protocol
rejection, ECDH key rotation and per-teammate visibility, MQTT frame validation,
QR pixel decoding, chat-image compression/validation, backup integrity and
encryption, footprint aggregation and recap summaries, GPS quality, procedural
video-music composition, share-style normalization, story day grouping, photo
matching, weather parsing/manual merge, travel-book privacy and export,
sync invite/identity/protocol/engine/transport/TOFU, repository contracts, and
Worker dispatch, transfer, cancellation, and session-token behavior. Playwright smoke tests run the demo and
simulator flows in Chromium: nested trip navigation and browser-back history,
chart series visibility and touch scrubbing, privacy cropping, poster canvas
rendering, text-only HTML export, encrypted backup export → wipe → restore, the
iOS storage nudge, fake-camera coverage for quick photo bursts, original-image
download, multi-select node photos, two-client encrypted text and image chat,
camera and image QR join, passive OLED anti-mistouch, hold-to-unlock, 3-second
auto-lock, and 20-second idle close. A separate opt-in Playwright test (`MEET_PUBLIC_E2E=1`)
creates a public-broker room in two isolated browser contexts and verifies text
and encrypted image delivery without duplicates.
GitHub Actions
runs typecheck, the full test suite, the production build, the Playwright suite,
and a separate relay test job. The Pages workflow runs the same tests before
publishing `dist/`. Pushing a `v*` tag triggers the release workflow, which
attaches `roametch-dist.zip` and publishes `ghcr.io/peteliao/roametch` and
`ghcr.io/peteliao/roametch-relay` to GHCR.

## Related documents

- [README](../README.md) / [README.en.md](../README.en.md) — features and usage.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — workflow and invariants.
- [SECURITY.md](../SECURITY.md) — threat model and reporting.
- [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) — community standards.
- [relay/README.md](../relay/README.md) — self-hosted blind relay.
