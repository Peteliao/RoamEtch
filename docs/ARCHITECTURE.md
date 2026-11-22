# TrackMint architecture / 架构说明

TrackMint is a static, local-first TypeScript PWA. There is no application server,
account system, cloud trip library, or analytics endpoint. The production artifact
is a folder of static files (`dist/`) that can be hosted on GitHub Pages, nginx, or
any static host.

TrackMint 是纯静态、本地优先的 TypeScript PWA，没有业务后端、账号体系、云端行程库
或统计上报。构建产物是可部署到任意静态托管的 `dist/`。

## Runtime at a glance

```text
Browser APIs                       Core modules                     UI (native DOM)
────────────                       ────────────                     ───────────────
geolocation  ──► recorder ──► Dexie / IndexedDB ──► stats worker ──► views
wake lock         │                 │                                 record
fullscreen        │                 ├── trips / segments / chunks      meet
visibility        │                 ├── waypoints / media / elevCache  trips
                  │                 └── settings (localStorage)        analysis
                  ├── rewalk / simulator                            export
                  ├── poster / replay + footprint video / promo     settings
                  └── meetup crypto ──► MQTT WSS or WS relay
```

Key principles:

- **Local-first.** All trip data is written to IndexedDB before it is used for
  analysis or export. There is no background sync.
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
| `src/ui/shell.ts` | Top bar, region chip, tab bar, view lifecycle, language rebuild. |
| `src/ui/state.ts` | Active trip and current view state shared by views. |
| `src/core/store.ts` | Dexie schema and CRUD: trips, segments, 400-point track chunks, waypoints, media, elevation cache. |
| `src/core/recorder.ts` | GPS watch, fix validation, gap segmentation, incremental persistence, live stats, wake lock and keep-alive. |
| `src/worker/compute.worker.ts` | Statistics, simplification, and coordinate transforms off the main thread, with a synchronous fallback. |
| `src/ui/map.ts` | MapLibre setup, region-specific raster styles, tile providers, and GCJ-02 render adapter. |
| `src/ui/analysis.ts` | Compact metric card (4 hero + 9 details), elevation/speed charts with hover and touch scrubbing, gap repair, GPS quality report, timeline and waypoints. |
| `src/ui/trips.ts` | Trip library: favorites, tags, search, filters, sorting, yearly footprint and its image/video share preview, import/export, backup entry points. |
| `src/ui/backupFlow.ts` | Shared backup/restore UX: download, restore preview, integrity status, duplicate strategy, pre-restore snapshot. |
| `src/ui/export.ts` | Posters, replay videos, standalone HTML, share link, privacy review. |
| `src/core/trackVideo.ts` | Realtime canvas replay, intro/outro cards, and muxing the generated music track. |
| `src/core/footprintShare.ts` | Aggregate-only yearly footprint artwork: 1080×1350 image and 9-second 1080×1920 video with original music. |
| `src/core/videoCapture.ts` | Shared MediaRecorder support check and MIME/bitrate selection (MP4/H.264 preferred, WebM fallback). |
| `src/core/promo.ts` | Generic promo artwork: three designs per theme, immediate-repeat avoidance, and matching captions. |
| `src/core/music.ts` | Four original procedural loops: composition data, Web Audio synthesis, seamless tail wrap, random/manual selection, and MediaStream output. |
| `src/core/backup.ts` | Backup format v2: ZIP manifest, payload digest, per-media checksums, inspect/restore. |
| `src/core/integrity.ts` | Deterministic JSON serialization and SHA-256 helpers. |
| `src/core/footprint.ts` | Year/month aggregation over `statsCache` for the footprint card. |
| `src/core/gpsQuality.ts` | Accuracy, poor fixes, time gaps, altitude jumps, and 0–100 quality score. |
| `src/core/meet*.ts` | Meetup codes, HKDF/AES-GCM envelopes, MQTT/WS transport, session state. |
| `src/core/privacy.ts` | Start/end privacy cropping, sensitive waypoint hiding, EXIF stripping. |
| `src/core/gpx.ts`, `batch.ts`, `shareLink.ts`, `htmlExport.ts` | File, batch, compact-link, and standalone HTML formats. |
| `src/core/region.ts`, `providers.ts`, `coords.ts` | Service routing and China/global map adaptation. |
| `vite.config.ts` | PWA manifest, Workbox precache, bounded map-tile caches, chunk splitting. |
| `relay/` | Optional minimal WebSocket blind relay, deployed separately. |

## Data model

Dexie database `localtrace`, schema version 1:

- `trips`: id, activity, status, timestamps, name, tags, favorite, privacy, and
  `statsCache`. Rows are ordered by `updatedAt`.
- `segments`: one continuous recording interval, indexed by trip and order.
- `trackChunks`: up to 400 points per row, linked to a trip and segment by sequence.
  Chunking keeps IndexedDB writes small and avoids rewriting a whole track.
- `waypoints`: nodes with type, note, time, hidden flag, and linked media ids.
- `media`: EXIF-stripped photo blobs and thumbnails, linked to a trip.
- `elevCache`: elevation lookups with fetch time.

`loadTripFull` assembles a trip with ordered segments, flattened chunks, waypoints,
and media metadata. User preferences live separately in `localStorage` through
`core/settings.ts`; that is why a preferences reset cannot delete trips.

Backups serialize every table plus binary media into a `.trip` ZIP:

- `manifest.json` contains tables, counts, `mediaMeta`, and an `integrity` object.
- `integrity.payload` is SHA-256 over a deterministic, undefined-normalized JSON
  payload (key order and non-finite numbers do not change the digest).
- `integrity.files` records byte length and SHA-256 per media file.
- Version 1 archives are still accepted and reported as “no checksum”; version 2
  archives block restore when payload or media verification fails.
- Inspection enforces size, entry-count, compression-ratio, duplicate-path,
  manifest-size, point-count, and path/ID whitelist limits before decompression.
  Manifest counts and trip/segment/chunk/waypoint/media relationships are checked
  before restore; missing media blocks the restore.
- Restore reuses the inspected archive and writes all tables plus overwrite
  deletions in one IndexedDB transaction, so a failed media write rolls back
  previously deleted trips.
- Backups are **not encrypted**. Integrity is tamper detection, not secrecy or
  authenticity: an attacker who rewrites the archive can recompute the checksums.

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
   true-black dashboard that stays in the foreground and adds no hidden/blackout
   mode, because a hidden page lets browsers suspend geolocation. Operating-system
   limits still apply; recording is not guaranteed with the screen off on every
   device.
6. Pause and finish refuse to complete while buffered points remain unwritten,
   and a failed resume restores the paused state instead of silently recording
   without geolocation.
7. Finishing writes `statsCache` through the statistics worker so the trip list and
   footprint can render without recomputing every track.

## Statistics and charts

`core/stats.ts` derives per-segment and total distance, wall duration, recorded
(active) time, moving/stopped time, gap time, speed, pace, ascent/descent, altitude
range, calories, and a difficulty / quality score. Only intervals up to 60 seconds
count as recorded time; pause and long-silence gaps are reported separately rather
than counted as standing still. The compute worker runs statistics, simplification, and coordinate
transforms; `workerBridge.ts` falls back to synchronous execution if the worker
cannot start. `analysis.ts` renders uPlot elevation and speed charts and links
hover position to the MapLibre marker. Touch uses pointer capture for continuous
scrubbing, while `touch-action: pan-y` on the plot leaves vertical page scrolling
intact. `gpsQuality.ts` evaluates the raw samples that produced the track, not a
synthetic model.

## Maps and coordinates

The region detector chooses service routing (`cn` vs `global`) from a manual
override, a short tile probe, or timezone/language. It does not transform stored
coordinates. China basemaps that expect GCJ-02 receive a render-time conversion in
`ui/map.ts`; picking converts back to WGS-84 before anything is stored. Map tile
caches are bounded per provider and evicted on quota errors.

## Sharing and export

- GPX, GeoJSON, KML, batch ZIP, standalone HTML, poster, and replay video are
  generated locally from IndexedDB data.
- Compact share links put simplified, privacy-cropped data in the URL `#` fragment;
  fragments never reach the hosting server, and links contain no photos.
- Posters and videos read the active theme palette and regenerate when the theme
  changes.
- Replay videos synthesize one of four original loops on-device with Web Audio
  oscillators and a generated reverb impulse. The loop's reverb tail is wrapped
  into its start for seamless repetition; the user chooses a track or leaves the
  default random selection. The audio track is muxed with the canvas stream, so
  no external music file or network request is involved.
- Yearly footprint sharing builds a 1080×1350 card or a 9-second 1080×1920 video
  from aggregate totals only. Names, track geometry, coordinates, waypoints, and
  photos are never passed to the artwork or its caption.
- Promo artwork is generic product art: three layouts per theme (local-first,
  yearly footprint, encrypted meetup), randomly selected without an immediate
  repeat, with a caption that matches the chosen layout. It reads no trip data.
- Privacy checks (start/end circles, hidden waypoints, EXIF stripping) are shown
  before sharing or export.

## Live meetup and relay

A 12-character code is used to derive a domain-separated room id and AES-GCM key
via HKDF-SHA-256. Positions and ephemeral chat are encrypted on-device and sent
through the default public MQTT WSS broker or a custom WebSocket relay. The relay
sees only ciphertext, room identifiers, and transport metadata. Messages live in
memory only: no history, no late-joiner backfill, no persistence after the session
ends. `relay/` is a minimal blind-forwarding template; it is not required by the
static app.

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
GPX/KML/GeoJSON, compact links, demo data, meetup crypto, backup integrity,
footprint aggregation and recap summaries, GPS quality, and procedural
video-music composition. GitHub Actions
runs typecheck, the full test suite, the production build, and a separate relay
test job. The Pages workflow runs the same tests before publishing `dist/`.

## Related documents

- [README](../README.md) / [README.en.md](../README.en.md) — features and usage.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — workflow and invariants.
- [SECURITY.md](../SECURITY.md) — threat model and reporting.
- [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) — community standards.
- [relay/README.md](../relay/README.md) — self-hosted blind relay.
