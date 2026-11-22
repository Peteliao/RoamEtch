# Changelog

All notable changes to TrackMint are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions use
[Semantic Versioning](https://semver.org/).

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

- KML exports used an invalid `<color>` value with a space; the TrackMint accent
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
