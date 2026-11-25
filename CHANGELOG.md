# Changelog

All notable changes to RoamEtch are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions use
[Semantic Versioning](https://semver.org/).

## [3.1.2] - 2026-11-25

### Added

- Added explicit cross-city re-walk navigation through AMap in mainland China
  and Google Maps elsewhere, with a privacy notice, external turn-by-turn voice
  guidance, and local distance/bearing announcements near the target.
- Added navigation-link, approach-voice, map-editing, and re-walk browser
  regression coverage.

### Changed

- Moved the passive OLED pocket-lock button into the right-side recording map
  tools without adding recording controls.
- Moved Yearly Footprint below the Trips header as an accessible accordion that
  is collapsed by default and loads its map only when expanded.

### Fixed

- Limited map editing and waypoint changes to finished trips opened from Trips
  with “View on map”; ordinary recording and finished-result views stay read-only.
- Restored visible Undo/Redo controls in Edit mode and redraw the trip map after
  edits, undo, and redo.

## [3.1.1] - 2026-11-25

### Fixed

- Restored regular mouse and touch clicks on Finish instead of requiring the
  previous long-press or swipe gesture.
- Kept the suggested activity-and-time trip name in the result sheet, renamed
  its dismissal action to Save, and restored Auto detection with Start after a
  successful finish.
- Updated the bilingual README animated demos to show recording, finishing,
  naming, saving, and the next-trip ready state.

## [3.1.0] - 2026-11-25

### Changed

- Reduced the main navigation to Record, Trips, Team, and Settings. Trip
  Overview, Data, and Share now live under one trip detail with a single active
  trip selection.
- Kept finished tracks visible after recording and added an inline result sheet
  for naming and opening analysis or sharing. OLED pocket lock is now passive:
  recording continues without pause, resume, or finish controls, and a 1.5-second
  hold unlocks it.
- Moved the trip list ahead of yearly footprints, consolidated import and data
  management actions, and reorganized Settings into six sections with team and
  basemap controls under Advanced and seven-tap developer-tool unlock.
- Preserved generated exports across same-trip refreshes, invalidated stale work
  only after real trip changes, added dynamic privacy summaries and shared empty
  states with record, sample, and import actions, and limited share prewarming to
  the visible Share section.
- Added team unread badges, a live team-status indicator, a clickable recording
  indicator, retained ephemeral chat drafts, accessible modal focus management,
  camera/QR focus traps, and live-region toasts.
- Added browser-history handling for trip detail, dialogs, the result sheet,
  camera, and QR scanner, plus normalized and validated cross-view navigation.
- Added chart legend toggles, touch scrubbing readouts, expandable timeline rows,
  chart render caching, and stable recorder metric nodes.
- Made requested pre-restore snapshots mandatory for restore and moved shared-link
  deduplication into a durable transactional IndexedDB index.

## [3.0.0] - 2026-11-24

### Added

- Eight bilingual, data-free promo variants with preview cycling.
- Recap videos with nodes, notes, and photos; city footprints, lit maps, and
  random music.

### Changed

- Rebranded the app as **RoamEtch (迹刻)** and moved the hosted app to
  `https://peteliao.github.io/RoamEtch/`. Roam means roaming, road trips, and
  hiking exploration; Etch means etching journeys.
- Release assets and GHCR images now use `roametch-dist.zip`,
  `ghcr.io/peteliao/roametch`, and `ghcr.io/peteliao/roametch-relay`. Legacy
  protocol identifiers remain for compatibility, and older `.trackmint.enc`
  backups remain restorable alongside new `.roametch.enc` exports.

### Fixed

- Reliable WebRTC originals, offline thumbnail recovery, merged elevation/speed
  charts, rewalk pronunciation, camera tap-to-focus, and background GPS recovery.

### Removed

- **Record:** manual-create button removed without affecting existing trips.

## [2.5.0] - 2026-11-24

### Added

- A 36-emoji picker in encrypted meetup chat, with cursor-aware insertion and
  large emoji-only bubbles. Emoji continue to use the existing ephemeral,
  end-to-end encrypted text-message path.
- WeChat-style press-and-hold voice messages with live waveform, duration,
  slide-up cancellation, keyboard hold support, automatic 15-second stop, and
  one-at-a-time playback. Voice uses bounded 64 KB Opus/WebM, Opus/Ogg or MP4
  packets over the existing encrypted relay and is never persisted.
- Microphone permission and recording-error guidance in Chinese and English,
  plus cleanup of audio players and object URLs when messages expire or chat
  closes.

### Tests

- Added protocol validation, encrypted packet-size, in-memory expiry, emoji and
  voice session tests, plus a real two-client Chromium E2E covering emoji,
  recording, encrypted delivery, playback and slide-to-cancel.

## [2.4.0] - 2026-11-24

### Added

- Opt-in WebRTC delivery for full-resolution meetup chat originals. Encrypted
  thumbnails still use the existing MQTT/WS relay; the original moves only after
  an explicit request over a one-to-one DataChannel, with the file holder always
  acting as Offerer.
- Targeted, encrypted RTC signaling for pull requests, rejection, Offer/Answer,
  ICE and abort. Signals are bounded, expire after 30 seconds, use a 500-entry
  sender/message-id deduplicator, and are rate-limited per sender so redundant
  broker delivery cannot start duplicate sessions.
- Reliable 16 KiB original transfer with SCTP backpressure, SHA-256 and image
  header/dimension verification, 10-second connection timeout, 30-second idle
  cleanup, and a two-session sender limit. The sender keeps at most 10 originals
  or 50 MB in memory; evicted files are reported as expired.
- Original-image progress, cancellation, retry and inline failure states in
  encrypted chat, plus an original viewer and save action. Location, text and
  thumbnails remain usable when a direct connection fails.
- A default-off P2P privacy switch with a first-use IP-visibility notice, three
  bundled STUN defaults, and optional custom STUN/TURN credentials stored only
  in local settings. No public TURN server is bundled.

### Fixed

- Fresh P2P opt-in now survives reload instead of being mistaken for a legacy
  settings record; RTC dedupe is scoped by sender and expires over time.
- RTC signaling has an independent bounded send lane and incoming per-sender
  rate limits, keeping signaling floods away from the location/chat send chain.
- Optional HD preparation failures fall back to the thumbnail, and preparation
  that spans an invite reset can no longer publish into the new room.
- Original requests require an exact SHA-256 match. Cancellation and cache keys
  include the peer/file/hash identity, preventing cancelled transfers from
  reopening and collisions across senders or reused file ids.
- Binary framing rejects empty, short, or extra chunks. The connection deadline
  now lasts until the DataChannel opens, stalled transfers time out, and late
  async completions cannot revive closed sessions.
- Leaving, removal, and invite reset close P2P sessions even for peers no longer
  present in the ordinary member list.
- STUN and TURN textareas now initialize their live values correctly, so the
  default ICE pool and saved custom configuration are visible and editable.

### Security

- Documented the split between strict ordinary-packet sequence replay checks
  and RTC sender/message dedupe, the DTLS DataChannel boundary, memory limits,
  peer/STUN/TURN IP visibility, and the fact that original bytes bypass the
  meetup relay while TURN may carry encrypted traffic.
- Upgraded i18next to the patched 26.3.4 release, restoring a clean
  `npm audit --omit=dev` result. Remaining moderate glob/minimatch advisories
  are confined to the development-only Workbox build chain.

### Tests

- Added transport state-machine tests for fixed-Offerer handshakes, early ICE,
  exact chunk framing, duplicate EOF, checksum rejection, backpressure,
  expiry/privacy refusal, sender limits, channel-open and stalled timeouts,
  oversized requests, and synchronous cancellation.
- Added RTC sender-aware dedupe/rate-limit, ICE configuration, original-cache,
  settings-migration, thumbnail-fallback, and room-reset race regressions.
- Added a real two-client Chromium E2E test that verifies lazy connection,
  encrypted relay signaling, wrong-hash rejection, original
  bytes/hash/dimensions, download, privacy refusal and continued chat after
  failure, plus default-off/custom ICE persistence and failure-path E2E cases.

## [2.3.0] - 2026-11-24

### Added

- One-tap “save original” for every quick camera shot. The full-resolution JPEG
  is kept transiently in the camera session and handed to the system through the
  Web Share files sheet, the File System Access save picker, or a download
  fallback. Browsers cannot silently add files to the OS photo gallery, so the
  saved chip and OLED result card expose this action explicitly instead of
  pretending the original was already in the album.
- Meetup join by QR code: scan a live camera frame or choose a QR image from the
  album. Both paths normalize through the existing v2 invite parser and reject
  legacy or malformed codes explicitly.
- Waypoint editor photo actions now accept multiple album files at once and an
  in-camera burst. Every captured or selected image is appended to the node, and
  the pending strip is cleaned up when the editor closes.
- The quick camera keeps the shutter available after each save, so a burst is
  added as separate photo waypoints until the photographer taps Done.
- Multiple default public MQTT providers (`broker-cn.emqx.io`,
  `broker.emqx.io`, and `mqtt-dashboard.com`) connect concurrently. The app
  subscribes everywhere to maximize reachability and selects the fastest
  responding connection while retaining the others as redundancy; empty custom
  URLs now mean automatic public selection.

### Changed

- The OLED pocket-lock action rail now stacks the swipe-to-shoot track above the
  1.5-second unlock button. Drag feedback is interpolated with
  `requestAnimationFrame` and a CSS custom property, so the knob follows the
  finger without layout churn while the 120 px anti-mistouch threshold, tap
  rejection, 20-second camera idle close, and 3-second relock remain unchanged.

### Fixed

- Public MQTT meetups failed to connect because SUBACK validation rejected real
  3-byte acknowledgements (packet id plus grant byte). The parser now accepts
  standards-compliant SUBACK packets and still rejects malformed or refused
  subscriptions.
- The save-original button no longer shares the undo button class, keeping the
  undo action unambiguous for assistive selectors and automated tests.

### Tests

- Added QR pixel decoding tests, a Playwright camera-scan and image-scan join
  test, and a gated two-client public MQTT test that creates a room, joins from a
  second browser context, sends text and an encrypted image, and asserts each
  message appears exactly once.
- Extended camera E2E coverage for original-image download, three-shot bursts,
  multi-select node photos, and burst photos inside the node editor. The OLED
  test now asserts the camera rail sits below the unlock control.

## [2.2.0] - 2026-11-24

### Added

- Embedded in-PWA camera for encrypted meetup chat photos. It uses
  `getUserMedia`, an inline viewfinder, album/shutter/flip controls, torch where
  supported, a quick preview with compressed dimensions/size, and an optional
  caption. The PWA stays in the foreground instead of handing off to the system
  camera, reducing iOS Safari background pauses.
- Weak-network chat image encoding: WebP where supported with JPEG fallback,
  quality and dimension stepping, a 720 px long edge (480 px in low-data mode),
  and a 56 KB raw-image cap before encryption/base64 expansion.
- Incoming chat photos show an encryption badge, open in an enlarged viewer,
  and can pin their optional WGS-84 capture point on the map.
- One-tap photo capture while recording or paused. Each shot becomes a local
  photo waypoint linked to a fresh-enough WGS-84 position and altitude, with
  flash, vibration, thumbnail, undo, burst capture, and a saved-shot counter.
  Media, waypoint, and trip timestamps commit atomically; paused or stale
  captures request a one-shot fix without adding a track point.
- OLED pocket-lock camera rail: drag the bottom-right knob left by at least
  120 px to open the camera without unlocking. A tap or short drag does nothing;
  the camera closes after 20 seconds without interaction, and a saved shot
  offers “shoot again” or a 3-second automatic return to the black pocket lock.

### Changed

- Meetup relay frame limits are now 128 KB on the client, bundled relay, and
  custom WebSocket receiver so compressed encrypted photos fit after base64
  expansion. Oversized frames are rejected deterministically with close code
  `1009`. The relay also bounds message bytes and queued outbound bytes, closing
  abusive or slow peers with `1008` or `1013`; malformed MQTT frames terminate
  with `1002` and do not reconnect.
- Chat photos use a 5-second sender cooldown and a 4.25-second receiver gap.
  Only the latest 20 image payloads remain in session memory; object URLs are
  bounded and revoked, and chat photos are never written to IndexedDB.
- Camera streams and the iOS 1 px keepalive video are coordinated so closing a
  camera or finishing an OLED shot re-arms keepalive without stopping GPS or the
  meetup relay.

### Security

- Untrusted image packets validate base64 shape and decoded size, MIME, integer
  dimensions, coordinate/accuracy ranges, and encoded WebP/JPEG headers before
  entering chat state or decoding pixels; declared dimensions must match the
  header and stay within the edge/pixel budget.
- Image memory and URL caches are bounded; pruned payloads render an explicit
  expired placeholder instead of retaining old photos.
- Chat captures refresh coordinates at shutter time, and paused photo captures
  request a fresh one-shot fix both when opening and when saving. Local album
  inputs are bounded to 32 MB and 40 MP, with JPEG/PNG/WebP headers checked before
  object URL creation or pixel decode. Discarded preview jobs cannot replace a
  newer capture, and late save results release their thumbnails after camera close.
- MQTT control flags and body lengths are validated; malformed or unsupported
  packets terminate with `1002`. Relay binary frames count against rate/byte
  budgets before rejection, and forwarded ciphertext remains a text frame.

### Tests

- Added image compression/validation unit tests, a 100 KB relay pass / 129 KB
  relay reject boundary test, and Playwright fake-camera coverage for quick
  photo save/undo, pending-save thumbnail cleanup, oversized-album rejection,
  stale-preview isolation, two-client encrypted image delivery and map locate,
  OLED anti-mistouch, 3-second auto-lock, and 20-second idle close.

## [2.1.0] - 2026-11-23

### Added

- Optional password encryption for full-library backups. Encrypted backups use a
  `TRKMBKP1` envelope with PBKDF2-SHA-256 (600,000 iterations), a random 16-byte
  salt, and AES-256-GCM, and are saved as `.trackmint.enc`. Restoring prompts for
  the password, retries without touching local data on failure, and shows the
  integrity and snapshot preview before writing.
- Playwright end-to-end smoke suite covering demo analysis and chart switching,
  privacy crop, poster rendering, text-only HTML export, encrypted backup
  export → wipe IndexedDB → restore, and the iOS storage nudge. CI runs it on
  every push.
- Release workflow for `v*` tags: typecheck, unit tests, build, a
  `trackmint-dist.zip` release asset, and GHCR images `ghcr.io/peteliao/trackmint`
  and `ghcr.io/peteliao/trackmint-relay`.
- Closable 7-day IndexedDB eviction warning on iOS in a browser tab, with
  Add to Home Screen and backup actions. Dismissal is remembered locally.
- Animated bilingual WebP demos in both READMEs, regenerated with
  `npm run promo:webp`.

### Changed

- Meetup publishes adapt to movement: about 5 seconds between updates while
  moving and 25 seconds when stationary, instead of one fixed cadence.
- Re-walk speech is primed synchronously inside the start gesture so iOS
  `speechSynthesis` works on the first waypoint; the global voice toggle is
  persisted across sessions.
- Video export detects WebM-only browsers and explains the limitation before
  and after export.
- Self-contained HTML export offers clear / light / text-only image tiers,
  per-tier photo budgets, and an estimated file size before export.
- The bundled relay now enforces 8 KB frames, a per-socket token bucket,
  room/client caps, and a 12-hour idle-room sweep; docs cover reverse-proxy
  per-IP limiting.
- SECURITY documents that host-kick is advisory and explains how authority
  differs between the public MQTT broker and a self-hosted relay.

### Fixed

- The restore file picker now accepts `.trackmint.enc` backups instead of
  filtering them out.

## [2.0.0] - 2026-11-23

### Added

- Meetup protocol v2: invites are now `TM2.<roomId>.<secret>`, with a random
  128-bit public room id and an independent 256-bit secret. The relay topic and
  WS path contain only the room id.
- HKDF-SHA-256 derives a non-extractable AES-256-GCM key bound to the room id,
  with a per-session nonce prefix and monotonic 32-bit counter.
- Strict per-sender replay protection for every packet type. Locations, status,
  and hello packets cannot be replaced by older or repeated sequences, and chat
  keeps its random message-id dedupe set.
- Protocol tests for invite entropy and normalization, HKDF/AAD separation, v1
  envelope rejection, tamper detection, nonce uniqueness, and replay handling.

### Changed

- The meetup UI shows a public room label, the full invite token, and separate
  copy-invite / copy-link actions. QR codes and deep links carry the v2 invite.
- Default MQTT prefix is `trackmint/v2/meet`; settings migrate only the exact old
  default prefix, and relay docs describe the public random room id.
- README, SECURITY, ARCHITECTURE, and relay documentation now describe the v2
  encryption boundary, legacy retirement, and the remaining Phase 2/3 work
  (sender identity authentication, host authority, key rotation, forward secrecy).

### Fixed

- Replay of an early-session packet is rejected instead of passing a sliding
  window.
- A reset or relay switch during in-flight encryption can no longer publish
  old-room ciphertext to the new room.

### Security

- **Breaking:** the retired 12-character meetup code and v1 invites/packets are
  rejected with an explicit message; there is no silent downgrade. Existing
  teams must create and share a new v2 invite.
- The invite secret never appears in the relay topic, URL query, HTTP path, or
  relay log. Anyone holding the full invite remains a room member by design.

## [1.9.0] - 2026-11-22

### Added

- Failure-safe recording persistence: incremental saves are serialized, failed
  writes stay buffered and retry every five seconds, and `pagehide` spills pending
  fixes to local storage so they can be recovered on the next boot.
- Explicit save status in the live panel and a retry banner when fixes cannot be
  written or a trip cannot be finalized.
- PWA update prompt: a new service worker waits for confirmation, and the update
  action is disabled while recording or paused so a reload cannot interrupt a trip.
- Recorded-time and gap-time rows in the analysis sheet and self-contained HTML
  export; the gap row appears only when a trip actually has inactive intervals.
- Unit tests for archive path traversal, oversized entries, zip-bomb ratios,
  manifest count/relationship errors, missing media, and transactional rollback.

### Changed

- Backup restore now validates every archive entry and manifest relationship
  before writing, then restores trips, segments, chunks, waypoints, media, and
  overwrite deletions in a single IndexedDB transaction. Restore reuses the
  inspected archive instead of unzipping it twice.
- Statistics now separate wall duration, recorded/active time, moving time,
  still time, and gap time. Pauses and intervals longer than 60 seconds no longer
  inflate still time.
- Version strings come from `package.json`; the app, diagnostics, About panel,
  and promo artwork report 1.9.0 from one source.

### Fixed

- Pause and finish no longer report success when pending track points failed to
  reach IndexedDB; they keep the recording state and show a retry action.
- Starting a recording cleans up its lock, wake lock, timers, and a newly created
  trip if setup fails.
- Unsupported geolocation and temporary OS location loss now pause the recording
  instead of continuing without fixes. Synchronous `watchPosition` failures are
  handled, and a failed resume rolls back to the paused state.
- Appending points updates chunks, segment end time, and trip update time
  atomically.

### Security

- Backup archives are capped at 256 MB compressed and 512 MB uncompressed, with
  per-entry, entry-count, manifest-size, point-count, duplicate-path, compression
  ratio, and path-whitelist checks. Missing media and inconsistent record
  references block restore.

## [1.8.0] - 2026-11-22

### Added

- Yearly footprint sharing: export a 1080×1350 summary card or a 9-second
  1080×1920 video with the original on-device soundtrack. Both show yearly
  aggregates only — trip count, distance, ascent, active days, and the 12-month
  rhythm — with preview, save, native share, and copy-caption actions. Trip
  names, tracks, coordinates, waypoints, and photos never enter the artwork.
- Three promo designs per theme: a local-first journey card, a yearly-footprint
  card, and an encrypted-meetup card. “Generate promo image” picks one at random
  without immediate repeats and pairs it with the matching caption.
- Continuous touch scrubbing on the analysis elevation and speed charts: press
  and drag to move the map marker and live readout, while vertical page scrolling
  remains available.
- Unit tests for the footprint recap summary (active months, top month, units,
  and empty years).

### Changed

- The OLED pocket lock is now the only on-screen mode. The artificial blackout /
  “sleep” submode was removed because browsers suspend geolocation while the page
  is hidden or the device is locked; the lock copy now states this plainly.
- The analysis statistics card is more compact: four hero metrics plus nine
  secondary metrics in a 3×3 grid (426 px → 308 px on a 390 px-wide phone).
- Replay and footprint videos now share one MediaRecorder helper with MP4/H.264
  preferred and a WebM fallback.

### Fixed

- Lifting the finger after the 1.5-second OLED unlock no longer synthesizes a
  click on the Start button underneath, which could accidentally begin a trip.

### Security

- Footprint share art and captions expose annual aggregates only. Promo artwork
  is generic and contains no trip or personal data.

## [1.7.0] - 2026-11-22

### Added

- Original soundtrack for replay videos: four instrumental loops (Dawn Mist,
  Far Ridges, Starlight, Breeze) synthesized on-device with Web Audio and a
  generated reverb tail. No audio files, samples, vocals, or third-party
  recordings are bundled.
- Music selection in the video card: random by default, or a specific track. The
  choice persists locally, and the selected track is shown after rendering.
- Audio is muxed into the MP4/WebM export with fade-in/out, looping for the full
  intro + replay + outro duration. Browsers without Web Audio fall back to a
  silent video.
- Refreshed promo artwork for 1.7 with shorter bilingual copy, new footprint,
  verified-backup, encrypted-meetup, and soundtracked-recap tiles, and matching
  share captions.
- Unit tests for the music catalog, random/manual resolution, loop composition,
  tempos, and note bounds.

### Changed

- Replay-video helper text now mentions the original looping music.
- About text and diagnostic version report 1.7.

### Security

- Video music is generated locally and makes no network request; it is not
  derived from copyrighted recordings.

## [1.6.0] - 2026-11-22

### Added

- Backup format v2 with a SHA-256 payload digest and per-file media checksums, plus
  integrity status on export, inspect, and restore. Version 1 backups are still
  accepted and restore without a checksum.
- Restore preview listing export time, trips, waypoints, photos, duplicate IDs, and
  checksum status, with an optional snapshot of the current database before
  restoring. Corrupted or modified archives are blocked.
- Favorites and up to 8 tags per trip, search across names and tags, activity and
  favorite filters, and sorting by recently updated, newest, distance, or name.
- Yearly footprint card: trips, distance, ascent, active days, and a 12-month
  distribution for the selected year.
- GPS quality report in analysis: average accuracy, poor-fix ratio, time gaps,
  altitude jumps, and a 0–100 score derived from recorded samples.
- Backup reminder when no full backup exists or the last one is over 30 days old,
  and storage/backup status in Settings.
- `CODE_OF_CONDUCT.md`, `docs/ARCHITECTURE.md`, and a pull-request template.
- Unit tests for backup integrity and tamper detection, footprints, and GPS quality.

### Changed

- Backup counts now include segments and track chunks, and the Settings data card
  shows the last full backup and storage usage.
- Backup exports record `lastBackupAt`, shared by the Trips and Settings views.

### Fixed

- Backup verification no longer reports a false failure when a photo legitimately
  has no thumbnail or when JSON fields are `undefined`.
- The footprint card renders its KPI and monthly bars correctly.

### Security

- Backup checksums detect modified manifests and media, and restore is blocked when
  verification fails. Checksums are corruption/tamper detection, not signatures.
- Backup screens, READMEs, and SECURITY now state that backup ZIPs are **not
  encrypted** and contain full tracks, waypoints, and photos.

## [1.5.0] - 2026-11-22

### Added

- Built-in demo trip: the empty Trips tab can load a full hike with elevation,
  waypoints, and timestamps, then jump straight into analysis, posters, replay
  video, or self-contained HTML export without GPS.
- `?demo=1` opens the demo trip directly; `?sim=1` replays it through the real
  recorder pipeline as simulated GPS fixes for desktop testing.
- Vitest unit tests for coordinate conversion, track math, statistics, privacy
  cropping, GPX/KML/GeoJSON, compact share links, meetup key derivation and
  AES-GCM envelopes, and the demo track.
- GitHub Actions CI (typecheck, unit tests, production build) and a separate
  relay test job. The Pages deploy workflow now runs tests before publishing.
- Multi-stage `Dockerfile` plus `nginx.conf` for self-hosting with correct PWA
  cache headers.
- Minimal blind WebSocket relay template in `relay/` with room isolation,
  payload limits, heartbeat, rate limiting, health endpoint, Dockerfile, and
  tests.
- `SECURITY.md` with the meetup threat model, key derivation, relay-visible
  metadata, and private reporting instructions.
- `CONTRIBUTING.md`, GitHub issue templates, and this changelog.

### Changed

- Map tile caches now cap each provider bucket at 500 entries (300 for the
  extra global bucket) and evict on storage quota errors, reducing the chance of
  exhausting iOS CacheStorage or IndexedDB quota.
- MapLibre GL JS upgraded to 6.19.0 (ESM-only, WebGL2 required), with the
  worker URL wired through Vite so the rendered map works from the production
  build. This resolves the sanitizer-bypass advisory affecting older releases.
- Statistics now treat an epoch-zero timestamp as a real timestamp instead of
  missing time.
- Version bumped to 1.5.0.

### Fixed

- KML exports used an invalid `<color>` value with a space; the RoamEtch accent
  is now written as valid `AABBGGRR`.
- Tracks beginning at timestamp `0` no longer lose their first interval from
  duration and moving-time calculations.

### Security

- Production dependencies now audit clean: MapLibre GL JS 6.19.0 fixes the
  style sanitizer bypass present through 6.4.0.
- Documented the existing domain separation between the meetup room id and the
  AES key, the 5-minute replay window, and the lack of sender authentication or
  forward secrecy.
- Confirmed that the 12-character code never enters MQTT topics, WS paths, query
  strings, or relay message payloads.

## [1.4.0] - 2026-11-21

### Added

- Dual-region adaptive maps (AMap / Tianditu vs. OpenStreetMap / OpenTopoMap /
  Esri) with manual override, custom tiles, and GCJ-02 render-only adaptation.
- Re-walk mode with off-route alerts and spoken waypoint announcements.
- BRouter / OSRM gap repair for track breaks.
- End-to-end encrypted live meetup and ephemeral team chat over public MQTT or a
  custom WebSocket relay, with host handover hints, kick requests, code reset,
  and a two-to-eight-hour self-destruct timer.
- Branded promo sharing, one-tap settings reset, OLED pocket lock, bilingual
  READMEs, and zh/en screenshots.
