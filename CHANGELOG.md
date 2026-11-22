# Changelog

All notable changes to TrackMint are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions use
[Semantic Versioning](https://semver.org/).

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
