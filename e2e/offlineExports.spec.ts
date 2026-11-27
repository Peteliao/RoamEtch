import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { gotoTripSection, gotoTab } from './utils';

async function waitForApp(page: import('@playwright/test').Page) {
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
}

test('iPhone WebKit boots offline and exports trip data from the production shell', async ({ page, context }) => {
  const pageErrors: string[] = [];
  const recordPageError = (error: Error) => {
    if (!/no-response|autonavi|webrd|tile\.openstreetmap\.org/i.test(error.message)) pageErrors.push(error.message);
  };
  page.on('pageerror', recordPageError);
  await context.addInitScript(() => {
    try { localStorage.setItem('roametch.installNudge.v1', '1'); } catch { /* storage unavailable */ }
  });
  await page.goto('/?demo=1');
  await waitForApp(page);
  await expect(page.locator('#view-analysis .stat-hero-item').first()).toBeVisible({ timeout: 60_000 });
  const seeded = await page.evaluate(async () => {
    const { store } = (window as any).__lt;
    const trips = await store.listTrips();
    const full = await store.loadTripFull(trips[0].id);
    return {
      tripId: trips[0].id,
      points: full.segments.reduce((sum: number, segment: any) => sum + segment.points.length, 0)
    };
  });
  expect(seeded.points).toBeGreaterThan(0);

  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
    await page.reload();
    await waitForApp(page);
  }
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');

  await context.setOffline(true);
  await page.close();
  const offline = await context.newPage();
  offline.on('pageerror', recordPageError);
  await offline.goto('/');
  await waitForApp(offline);
  const offlineData = await offline.evaluate(async (tripId) => {
    const { store } = (window as any).__lt;
    const trip = await store.getTrip(tripId);
    const point = await store.loadFirstTrackPoint(tripId);
    return { name: trip?.name || '', point, schemaVersion: store.db.verno };
  }, seeded.tripId);
  expect(offlineData.name).toBeTruthy();
  expect(offlineData.point).toMatchObject({ lat: expect.any(Number), lon: expect.any(Number) });
  expect(offlineData.schemaVersion).toBe(4);

  await gotoTripSection(offline, 'share');
  const [gpxDownload] = await Promise.all([
    offline.waitForEvent('download'),
    offline.locator('#view-export button').filter({ hasText: 'GPX' }).first().click()
  ]);
  const gpx = readFileSync((await gpxDownload.path())!, 'utf8');
  expect(gpx).toContain('<gpx');
  expect(gpx).toContain('<trkpt');

  const htmlCard = offline.locator('#view-export .card').filter({ hasText: '自包含网页' });
  await htmlCard.getByRole('button', { name: '纯文字（无照片）' }).click();
  await expect(htmlCard.locator('label.row input[type="checkbox"]')).toBeDisabled();
  const [htmlDownload] = await Promise.all([
    offline.waitForEvent('download'),
    htmlCard.getByRole('button', { name: '自包含网页', exact: true }).click()
  ]);
  const html = readFileSync((await htmlDownload.path())!, 'utf8');
  expect(html).toContain('<canvas');
  expect(html.length).toBeGreaterThan(20_000);

  await offline.locator('#view-export .privacy-adjust').click();
  const vectorCard = offline.locator('#view-export .card').filter({ hasText: '纯矢量模式' });
  await vectorCard.locator('.switch').last().click();
  const posterCard = offline.locator('#view-export .card').filter({ hasText: '图片海报' });
  await posterCard.getByRole('button', { name: '生成' }).click();
  await expect(posterCard.locator('button[aria-label="下载海报"]')).toBeVisible({ timeout: 90_000 });
  const [posterDownload] = await Promise.all([
    offline.waitForEvent('download'),
    posterCard.locator('button[aria-label="下载海报"]').click()
  ]);
  const poster = readFileSync((await posterDownload.path())!);
  expect(poster.subarray(1, 4).toString()).toBe('PNG');

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
  expect(manifest.format).toBe('localtrace-backup');
  expect(manifest.counts.trips).toBeGreaterThan(0);
  expect(manifest.counts.trackChunks).toBeGreaterThan(0);
  const inspection = await offline.evaluate(async (bytes) => {
    return (window as any).__lt.backup.inspectBackup(new File([new Uint8Array(bytes)], 'offline.trip'));
  }, Array.from(backup));
  expect(inspection.integrity).toMatchObject({ ok: true, failed: [] });
  expect(pageErrors).toEqual([]);
});
