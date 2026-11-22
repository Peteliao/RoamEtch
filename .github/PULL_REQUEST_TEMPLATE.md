## Summary

<!-- What user-visible problem does this change solve, and how? -->

## Type of change

- [ ] Feature
- [ ] Bug fix
- [ ] Refactor / internal
- [ ] Documentation
- [ ] Tests / CI
- [ ] Security

## Verification

Describe what you ran and what you observed. UI changes need a real browser check
at desktop and mobile widths.

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `cd relay && npm test` (only if `relay/` changed)
- [ ] Manual browser check for UI changes

## Screenshots / recordings

<!-- Required for layout or visual changes. Never include real trips, meetup codes,
     personal tracks, or photos from a real device. -->

## Data and privacy checklist

- [ ] Storage, exports, and share payloads remain WGS-84.
- [ ] No meetup code, trip data, or personal track was added to logs, fixtures,
      screenshots, or analytics.
- [ ] New user-facing strings exist in both `zh` and `en` in
      `src/core/i18n.ts`.
- [ ] Settings reset still preserves trips, waypoints, photos, and backups.
- [ ] Any new dependency is necessary for an offline-first, no-telemetry app and
      respects the bundle-size budget.
