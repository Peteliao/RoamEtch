# Contributing to TrackMint / 贡献指南

Thanks for helping improve TrackMint. The project is deliberately small: a static,
offline-first TypeScript PWA with no backend, no framework, and no telemetry.
Please keep contributions aligned with that shape. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map and data flow.

感谢参与 TrackMint。项目刻意保持轻量：纯静态、离线优先、TypeScript + 原生 DOM，
没有后端、没有前端框架、没有统计上报。提交前请先读完下面的约定。

## Development setup

Requirements: Node.js 22+ and npm.

```bash
npm install
npm run dev        # Vite dev server
npm run typecheck  # tsc --noEmit
npm test           # Vitest unit tests
npm run build      # typecheck + production build (dist/)
npm run preview    # preview the production build
```

The relay template is a separate npm package:

```bash
cd relay
npm install
npm test
```

## Before opening a PR

1. Keep the change focused. One problem per PR, with a short explanation of the
   user-visible effect.
2. Add or update tests for pure logic you touch. `tests/` covers coordinate
   conversion, track math, statistics, privacy cropping, backups and integrity
   checks, yearly footprints, GPS quality, GPX/KML/GeoJSON, compact links, meetup
   crypto, procedural video music, and the demo track.
3. Run `npm run typecheck && npm test && npm run build`. If you changed the relay,
   also run `cd relay && npm test`.
4. For UI changes, test in a real browser at desktop and mobile widths. Include a
   screenshot or short recording in the PR when the layout changes.
5. Use a commit message in the existing style: `feat(scope): ...`, `fix(scope): ...`,
   `docs: ...`, `test: ...`, `chore: ...`.

## Project invariants

These are the rules that are easy to break accidentally:

- **Coordinates:** storage, analysis, share payloads, GPX/GeoJSON/KML, and backups
  are always WGS-84. GCJ-02 conversion happens only in the map render/pick
  adapter (`src/core/coords.ts`). Never persist display coordinates.
- **Meetup secrets:** the invite secret belongs only in the URL `#` fragment and
  in memory. Never put it in a query string, HTTP path, MQTT topic, relay log,
  analytics event, or error report. The random room id may appear in the topic;
  keep it independent from the key (`src/core/meetLink.ts`), and never silently
  accept v1 invites or packets.
- **Ephemeral chat:** messages and positions are memory-only. Do not add chat
  history, server persistence, replayed messages, or late-joiner backfill
  without an explicit product decision and a security review.
- **Local-first:** no account system, no cloud trip library, no telemetry, no
  remote font/SDK. New runtime dependencies need a clear reason and a review.
- **Bilingual UI:** every user-facing string goes in `src/core/i18n.ts` with both
  `zh` and `en` entries. Keep the Chinese copy aligned with the product
  terminology already in the file (for example 组队 / 实时组队, not 会合).
- **UI language vs. region:** they are independent. Do not derive one from the
  other, and do not let a region switch rewrite stored data.
- **Settings reset:** “restore defaults” resets preferences only. Trips,
  waypoints, photos, and backups must survive.
- **Theme-aware exports:** poster, replay video, and promo canvases must read the
  active palette instead of hard-coded colours. `light` and `oled` are distinct;
  OLED is not a separate theme.
- **Offline assets:** the app shell must work from the service worker cache.
  Map tiles are a bounded extra cache, not a prerequisite for recording or
  analysis.

## Debugging and manual checks

- `?demo=1` loads the built-in demo trip and opens analysis — useful when testing
  without GPS.
- `?sim=1` replays the demo track through the real recorder pipeline as
  simulated GPS fixes. Settings also exposes the playback simulator and network
  region simulation (CN / Global / offline / CORS failure).
- `window.__lt` exposes recorder, store, coords, theme, rewalk, batch, keepalive,
  and meetup internals in development and production builds for diagnostics.
- For service-worker changes, verify a production build (`npm run build` +
  `npm run preview`), not just the dev server.

## Security and privacy

Please read [SECURITY.md](SECURITY.md) before changing meetup transport, share
links, photo handling, or backup/restore. Report vulnerabilities through GitHub
private advisories, not public issues. Never include real meetup codes or
personal tracks in a test fixture, screenshot, or issue.

## License

By contributing, you agree that your contribution is licensed under GPL-3.0-only,
the same license as the project.
