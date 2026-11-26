import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { gotoTab } from './utils';

test('mobile Chromium preserves media and exports a verified backup offline', async ({ page, context }) => {
  const pageErrors: string[] = [];
  const recordPageError = (error: Error) => {
    if (!/no-response|autonavi|webrd/i.test(error.message)) pageErrors.push(error.message);
  };
  page.on('pageerror', recordPageError);
  await context.addInitScript(() => {
    try { localStorage.setItem('roametch.installNudge.v1', '1'); } catch { /* storage unavailable */ }
  });
  await page.goto('/?demo=1');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  await expect(page.locator('#view-analysis .stat-hero-item').first()).toBeVisible({ timeout: 60_000 });

  const seeded = await page.evaluate(async () => {
    const { store } = (window as any).__lt;
    const trips = await store.listTrips();
    const full = await store.loadTripFull(trips[0].id);
    const firstPoint = full.segments.flatMap((segment: any) => segment.points)[0];
    const result = await store.addPhotoWaypoint({
      tripId: trips[0].id,
      photo: {
        blob: new Blob(['offline-original'], { type: 'image/jpeg' }),
        thumb: new Blob(['offline-thumbnail'], { type: 'image/jpeg' }),
        width: 1,
        height: 1
      },
      fix: { lat: firstPoint.lat, lon: firstPoint.lon },
      takenAt: Date.now(),
      nameFor: () => 'Offline media'
    });
    return { tripId: trips[0].id, mediaId: result.media.id };
  });

  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  }
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');

  await context.setOffline(true);
  await page.close();
  const offline = await context.newPage();
  offline.on('pageerror', recordPageError);
  await offline.goto('/');
  await expect.poll(() => offline.evaluate(() => Boolean((window as any).__lt))).toBe(true);

  const persisted = await offline.evaluate(async ({ tripId, mediaId }) => {
    const { store } = (window as any).__lt;
    const full = await store.loadTripFull(tripId);
    const media = await store.getMedia(mediaId);
    return {
      referenced: full.waypoints.some((waypoint: any) => waypoint.mediaIds?.includes(mediaId)),
      original: Array.from(new Uint8Array(await media.blob.arrayBuffer())),
      thumbnail: Array.from(new Uint8Array(await media.thumb.arrayBuffer()))
    };
  }, seeded);
  expect(persisted.referenced).toBe(true);
  expect(Buffer.from(persisted.original).toString()).toBe('offline-original');
  expect(Buffer.from(persisted.thumbnail).toString()).toBe('offline-thumbnail');

  await gotoTab(offline, 'settings');
  await offline.getByRole('button', { name: '整库备份' }).click();
  const backupModal = offline.locator('.modal-backdrop .modal');
  await backupModal.locator('input[type="checkbox"]').uncheck();
  const [backupDownload] = await Promise.all([
    offline.waitForEvent('download'),
    backupModal.getByRole('button', { name: '开始导出' }).click()
  ]);
  const backup = readFileSync((await backupDownload.path())!);
  const entries = unzipSync(backup);
  const manifest = JSON.parse(strFromU8(entries['manifest.json']));
  expect(manifest.counts.media).toBe(1);
  expect(entries[`media/${seeded.mediaId}.jpg`]).toBeDefined();
  expect(entries[`media/${seeded.mediaId}.thumb.jpg`]).toBeDefined();

  const inspection = await offline.evaluate(async (bytes) => {
    return (window as any).__lt.backup.inspectBackup(new File([new Uint8Array(bytes)], 'offline.trip'));
  }, Array.from(backup));
  expect(inspection.integrity).toMatchObject({ ok: true, checked: 2, failed: [] });
  expect(pageErrors).toEqual([]);
});
