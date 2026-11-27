import { test, expect, type Page } from '@playwright/test';
import { blockExternal, gotoTab } from './utils';

async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('localtrace.settings.v1', JSON.stringify({
      language: 'zh', regionMode: 'cn', theme: 'dark', units: 'metric',
      sim: { enabled: true, network: 'offline', playbackSpeed: 20 }
    }));
  });
  await blockExternal(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
}

async function seedTrip(page: Page, options: {
  name: string;
  createdAt: number;
  distanceM: number;
  photo?: boolean;
}) {
  return page.evaluate(async ({ name, createdAt, distanceM, photo }) => {
    const { store } = (window as any).__lt;
    const trip = await store.createTrip({ name, activity: 'hike', status: 'finished', createdAt, hasTime: true });
    const segment = await store.addSegment(trip.id, createdAt);
    const count = Math.round(distanceM / 100) + 1;
    const lonStep = 100 / (111_320 * Math.cos(30 * Math.PI / 180));
    const points = Array.from({ length: count }, (_, index) => ({
      lat: 30, lon: 120 + index * lonStep, t: createdAt + index * 60_000,
      alt: 100 + index * 0.5, acc: 5, speed: 100 / 60, heading: 90
    }));
    await store.appendPoints(segment.id, trip.id, points);
    if (photo) {
      const blob = new Blob(['fixture'], { type: 'image/png' });
      await store.addPhotoWaypoint({
        tripId: trip.id, photo: { blob, thumb: blob, width: 1, height: 1 },
        fix: points[Math.floor(points.length / 2)], takenAt: createdAt + 60_000
      });
    }
    const statsUrl = '/src/core/stats.ts';
    const { computeStats } = await import(statsUrl);
    const full = await store.loadTripFull(trip.id);
    const current = await store.getTrip(trip.id);
    await store.cacheTripStats(trip.id, current.updatedAt, computeStats(full.segments, { activity: 'hike' }));
    return trip.id;
  }, options);
}

test('advanced filters, all-history heatmap, annual records and track comparison work together', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await boot(page);
  const longId = await seedTrip(page, {
    name: '十二公里徒步', createdAt: new Date(2026, 0, 15, 8).getTime(), distanceM: 12_000
  });
  const shortId = await seedTrip(page, {
    name: '两公里拍照徒步', createdAt: new Date(2025, 5, 20, 8).getTime(), distanceM: 2_000, photo: true
  });
  await gotoTab(page, 'trips');
  await expect(page.locator('.trip-item')).toHaveCount(2);

  await page.locator('.trip-filter-btn').click();
  let dialog = page.getByRole('dialog', { name: '筛选行程' });
  await dialog.locator('[data-filter="minDistance"]').fill('3');
  await dialog.getByRole('button', { name: '应用', exact: true }).click();
  await expect(page.locator('.trip-item')).toHaveCount(1);
  await expect(page.locator('.trip-item')).toContainText('十二公里徒步');
  await expect(page.locator('.trip-filter-btn')).toContainText('(1)');

  await page.locator('.trip-filter-btn').click();
  dialog = page.getByRole('dialog', { name: '筛选行程' });
  await dialog.locator('[data-filter="minDistance"]').fill('');
  await dialog.locator('[data-filter="maxDistance"]').fill('3');
  await dialog.getByRole('button', { name: '应用', exact: true }).click();
  await expect(page.locator('.trip-item')).toHaveCount(1);
  await expect(page.locator('.trip-item')).toContainText('两公里拍照徒步');
  await page.locator('.trip-filter-btn').click();
  dialog = page.getByRole('dialog', { name: '筛选行程' });
  await dialog.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(page.locator('.trip-item')).toHaveCount(2);

  const footprint = page.locator('.footprint-card');
  await footprint.locator('.footprint-toggle').click();
  await footprint.locator('.footprint-year[aria-label="年度足迹"]').selectOption('all');
  await expect(footprint.locator('.footprint-map-status')).toContainText('2 段', { timeout: 30_000 });
  await expect(footprint.locator('.footprint-map-status')).not.toContainText('正在汇总');

  await footprint.getByRole('button', { name: '年度报告', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '年度运动报告' });
  await expect(dialog.locator('.growth-year')).toHaveValue('2026');
  await expect(dialog.locator('.growth-kpis')).toContainText('11.99 km');
  await expect(dialog.locator('.growth-report')).not.toContainText('null');
  await expect.poll(async () => (await dialog.locator('.growth-bar-track').first().boundingBox())?.height || 0).toBeGreaterThan(0);
  await expect(dialog.locator('.growth-record')).toHaveCount(2, { timeout: 30_000 });
  await dialog.locator('.growth-record-source summary').first().click();
  await expect(dialog.locator('.growth-record-source').first()).toContainText('数据来源');
  await dialog.getByRole('button', { name: '打开行程', exact: true }).first().click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#trip-detail')).toHaveClass(/active/);

  await page.locator('#view-analysis').getByRole('button', { name: '轨迹对比', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '双轨迹对比' });
  await expect(dialog.locator('.compare-result')).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator('.compare-summary')).toHaveCount(2);
  await expect(dialog.locator('.compare-sample').first()).toBeVisible();
  const beforeA = await dialog.getByLabel('轨迹 A').inputValue();
  const beforeB = await dialog.getByLabel('轨迹 B').inputValue();
  expect([beforeA, beforeB].sort()).toEqual([longId, shortId].sort());
  await dialog.getByRole('button', { name: '交换 A / B', exact: true }).click();
  await expect(dialog.getByLabel('轨迹 A')).toHaveValue(beforeB);
  await expect(dialog.getByLabel('轨迹 B')).toHaveValue(beforeA);
  await expect(dialog.locator('.compare-result')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(pageErrors).toEqual([]);
});

test('map tools load local overlays, persist layer preferences and locate coordinates', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await boot(page);
  await seedTrip(page, {
    name: '地图工具 A', createdAt: new Date(2026, 1, 10, 8).getTime(), distanceM: 1_500
  });
  await seedTrip(page, {
    name: '地图工具 B', createdAt: new Date(2026, 1, 11, 8).getTime(), distanceM: 1_800
  });
  await gotoTab(page, 'trips');
  await page.locator('button[title="更多操作"]').click();
  await page.locator('.sheet-row').filter({ hasText: '地图工具' }).click();
  const dialog = page.getByRole('dialog', { name: '地图工具' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '全选', exact: true }).click();
  await expect(dialog.locator('.mt-layer[data-status="ready"]')).toHaveCount(2, { timeout: 30_000 });
  await expect(dialog.locator('.mt-map-caption-text')).toContainText('2 条可见轨迹');

  const firstLayer = dialog.locator('.mt-layer').first();
  const slopeSwitch = firstLayer.locator('.mt-switch-row').filter({ hasText: '坡度着色' }).locator('.switch');
  const visibilitySwitch = firstLayer.locator('.mt-switch-row').filter({ hasText: '显示' }).locator('.switch');
  await slopeSwitch.click();
  await expect(firstLayer.getByLabel(/^坡度着色:/)).toBeChecked();
  await firstLayer.getByLabel(/^透明度:/).fill('65');
  await visibilitySwitch.click();
  await expect(firstLayer.getByLabel(/^显示:/)).not.toBeChecked();
  await expect(dialog.locator('.mt-map-caption-text')).toContainText('1 条可见轨迹');
  const preferences = await page.evaluate(() => JSON.parse(localStorage.getItem('roametch.mapTools.v1') || '{}'));
  const saved = Object.values(preferences.layers || {}) as any[];
  expect(saved).toHaveLength(2);
  expect(saved.some((layer) => layer.slope && layer.opacity === 0.65 && !layer.visible)).toBe(true);

  const firstId = await dialog.locator('.mt-layer').first().getAttribute('data-trip-id');
  const secondId = await dialog.locator('.mt-layer').nth(1).getAttribute('data-trip-id');
  await dialog.locator('.mt-layer').first().getByRole('button', { name: /^下移/ }).click();
  await expect(dialog.locator('.mt-layer').first()).toHaveAttribute('data-trip-id', secondId!);
  await expect(dialog.locator('.mt-layer').nth(1)).toHaveAttribute('data-trip-id', firstId!);
  const reordered = await page.evaluate(() => JSON.parse(localStorage.getItem('roametch.mapTools.v1') || '{}'));
  expect(reordered.order).toEqual([secondId, firstId]);
  await dialog.locator('.mt-layer').nth(1).getByRole('button', { name: /^上移/ }).click();
  await expect(dialog.locator('.mt-layer').first()).toHaveAttribute('data-trip-id', firstId!);

  await dialog.getByPlaceholder('39.9042, 116.4074').fill('39.9042, 116.4074');
  await dialog.getByRole('button', { name: '定位', exact: true }).click();
  await expect(dialog.locator('.mt-coordinate-message')).toContainText('WGS-84');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(pageErrors).toEqual([]);
});
