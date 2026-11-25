import { expect, test, type Page } from '@playwright/test';
import { blockExternal } from './utils';

async function seedTrip(page: Page, activity: 'drive' | 'hike') {
  await blockExternal(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  const id = await page.evaluate(async (initialActivity) => {
    const { store } = (window as any).__lt;
    await store.eraseAll();
    const trip = await store.createTrip({
      name: '活动编辑验收', activity: initialActivity, status: 'finished',
      createdAt: Date.UTC(2026, 0, 2)
    });
    const start = Date.UTC(2026, 0, 2, 10);
    const segment = await store.addSegment(trip.id, start);
    await store.appendPoints(segment.id, trip.id, [
      { lat: 30, lon: 120, alt: 100, t: start },
      { lat: 30.0008, lon: 120, alt: 100, t: start + 60_000 },
      { lat: 30.0048, lon: 120, alt: 100, t: start + 120_000 }
    ]);
    const waypoint = await store.addWaypoint({
      tripId: trip.id, name: '原始节点', desc: '保留', lat: 30.001, lon: 120,
      time: start + 30_000
    });
    const media = await store.addMedia({
      tripId: trip.id, blob: new Blob(['raw-media'], { type: 'text/plain' }),
      thumb: 'data:image/png;base64,', width: 1, height: 1
    });
    await store.updateWaypoint(waypoint.id, { mediaIds: [media.id] });
    await store.updateTrip(trip.id, {
      tags: ['原始'], favorite: true,
      privacy: { radius: 321, hideSensitive: false },
      customMetadata: { source: 'keep-me' }, reportedDistance: 1234,
      statsCache: { distance: 1234, movingMs: 120_000, calories: null, segments: [] }
    }, { touch: false });
    return trip.id;
  }, activity);
  await page.evaluate((tripId) => {
    (window as any).__lt.shell.navigate('trips', { detail: true, tripId, section: 'overview' });
  }, id);
  await expect(page.locator('.trip-detail-title')).toHaveText('活动编辑验收');
  await expect(page.locator('#view-analysis .stat-hero-item').first()).toBeVisible();
  return id;
}

async function rawSnapshot(page: Page, id: string) {
  return page.evaluate(async (tripId) => {
    const { db } = (window as any).__lt.store;
    const [segments, chunks, waypoints, media] = await Promise.all([
      db.segments.where('tripId').equals(tripId).toArray(),
      db.trackChunks.where('tripId').equals(tripId).toArray(),
      db.waypoints.where('tripId').equals(tripId).toArray(),
      db.media.where('tripId').equals(tripId).toArray()
    ]);
    return {
      segments, chunks, waypoints,
      media: media.map((item: any) => ({ ...item, blob: { size: item.blob.size, type: item.blob.type } }))
    };
  }, id);
}

async function stableTripFields(page: Page, id: string) {
  return page.evaluate(async (tripId) => {
    const trip = await (window as any).__lt.store.getTrip(tripId);
    const { createdAt, status, privacy, favorite, customMetadata } = trip;
    return { createdAt, status, privacy, favorite, customMetadata };
  }, id);
}

async function openEditor(page: Page) {
  await page.locator('#trip-detail .trip-detail-actions').getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑行程' });
  await expect(editor).toBeVisible();
  return editor;
}

async function saveEditor(page: Page, editor: ReturnType<Page['getByRole']>) {
  await editor.locator('.m-foot').getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toBeHidden();
}

test('drive to hike to drive recalculates stats, refreshes export, and preserves raw data', async ({ page }) => {
  const id = await seedTrip(page, 'drive');
  await expect.poll(() => page.evaluate(async (tripId) => {
    const trip = await (window as any).__lt.store.getTrip(tripId);
    return trip.statsCache?.movingMs;
  }, id)).toBe(120_000);
  const beforeRaw = await rawSnapshot(page, id);
  const beforeStable = await stableTripFields(page, id);

  let editor = await openEditor(page);
  const activity = editor.getByRole('combobox', { name: '活动', exact: true });
  await expect(activity).toHaveValue('drive');
  await expect(activity.locator('option')).toHaveText(['徒步', '自驾', '骑行', '跑步', '旅行']);
  await editor.locator('.m-body input[type="text"]').nth(0).fill('  徒步转换  ');
  await editor.locator('.m-body input[type="text"]').nth(1).fill('#new，repeat;repeat;其他');
  await activity.selectOption('hike');
  await saveEditor(page, editor);

  await expect.poll(() => page.evaluate(async (tripId) => {
    const trip = await (window as any).__lt.store.getTrip(tripId);
    return trip.statsCache?.calories;
  }, id)).toBeGreaterThan(0);
  const hike = await page.evaluate(async (tripId) => (window as any).__lt.store.getTrip(tripId), id);
  expect(hike).toMatchObject({
    activity: 'hike', name: '徒步转换', tags: ['new', 'repeat', '其他'], reportedDistance: null
  });
  expect(hike.statsCache.distance).toBeLessThan(1234);
  expect(hike.statsCache.movingMs).toBeLessThan(120_000);
  expect(await rawSnapshot(page, id)).toEqual(beforeRaw);
  expect(await stableTripFields(page, id)).toEqual(beforeStable);
  const calories = page.locator('#view-analysis .stat-mini').filter({ hasText: '消耗热量' }).locator('.v');
  await expect(calories).toContainText('kcal');

  await page.locator('#trip-detail button[data-section="share"]').click();
  const exportLabel = page.locator('#view-export .share-trip-card .small.muted');
  await expect(exportLabel).toContainText('徒步');
  editor = await openEditor(page);
  await editor.getByRole('combobox', { name: '活动', exact: true }).selectOption('drive');
  await saveEditor(page, editor);

  await expect.poll(() => page.evaluate(async (tripId) => {
    const trip = await (window as any).__lt.store.getTrip(tripId);
    return trip.statsCache && { calories: trip.statsCache.calories, movingMs: trip.statsCache.movingMs };
  }, id)).toEqual({ calories: null, movingMs: 120_000 });
  await expect(exportLabel).toContainText('自驾');
  await page.locator('#trip-detail button[data-section="overview"]').click();
  await expect(calories).toHaveText('—');
  expect(await rawSnapshot(page, id)).toEqual(beforeRaw);
  expect(await stableTripFields(page, id)).toEqual(beforeStable);

  const sentinel = await page.evaluate(async (tripId) => {
    const { store } = (window as any).__lt;
    const trip = await store.getTrip(tripId);
    const statsCache = { ...trip.statsCache, marker: 'unchanged-cache' };
    await store.updateTrip(tripId, { statsCache, reportedDistance: 777 }, { touch: false });
    return statsCache;
  }, id);
  editor = await openEditor(page);
  await expect(editor.getByRole('combobox', { name: '活动', exact: true })).toHaveValue('drive');
  await editor.locator('.m-body input[type="text"]').nth(0).fill('同名活动保存');
  await editor.locator('.m-body input[type="text"]').nth(1).fill('#same，same;keep');
  await saveEditor(page, editor);

  await expect.poll(() => page.evaluate(async (tripId) => {
    const trip = await (window as any).__lt.store.getTrip(tripId);
    return { name: trip.name, tags: trip.tags, activity: trip.activity, statsCache: trip.statsCache, reportedDistance: trip.reportedDistance };
  }, id)).toEqual({
    name: '同名活动保存', tags: ['same', 'keep'], activity: 'drive', statsCache: sentinel, reportedDistance: 777
  });
  expect(await rawSnapshot(page, id)).toEqual(beforeRaw);
  expect(await stableTripFields(page, id)).toEqual(beforeStable);
});

test('editor retains inputs on persistence failure and distinguishes durable edits when stats writing fails', async ({ page }) => {
  const id = await seedTrip(page, 'hike');
  await expect.poll(() => page.evaluate(async (tripId) => {
    const trip = await (window as any).__lt.store.getTrip(tripId);
    return trip.statsCache?.calories;
  }, id)).toBeGreaterThan(0);

  await page.evaluate(() => {
    const { db } = (window as any).__lt.store;
    const original = db.trips.update;
    (window as any).__restoreTripUpdate = () => { db.trips.update = original; };
    db.trips.update = () => Promise.reject(new Error('metadata-write-failed'));
  });
  let editor = await openEditor(page);
  await editor.locator('.m-body input[type="text"]').nth(0).fill('失败后保留输入');
  await editor.getByRole('combobox', { name: '活动', exact: true }).selectOption('run');
  await editor.locator('.m-foot').getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor.getByRole('alert')).toHaveText('名称保存失败，请重试');
  await expect(editor).toBeVisible();
  await expect(editor.locator('.m-body input[type="text"]').nth(0)).toHaveValue('失败后保留输入');
  await expect(editor.getByRole('combobox', { name: '活动', exact: true })).toHaveValue('run');
  expect(await page.evaluate(async (tripId) => {
    const trip = await (window as any).__lt.store.getTrip(tripId);
    return { name: trip.name, activity: trip.activity };
  }, id)).toEqual({ name: '活动编辑验收', activity: 'hike' });

  await page.evaluate(() => {
    const { db } = (window as any).__lt.store;
    (window as any).__restoreTripUpdate();
    const original = db.trips.update;
    let calls = 0;
    db.trips.update = function (...args: any[]) {
      if (++calls === 2) return Promise.reject(new Error('stats-write-failed'));
      return original.apply(this, args);
    };
  });
  await editor.locator('.m-foot').getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('行程已更新');
  await expect(editor.getByRole('alert')).toContainText('stats-write-failed');
  await expect(editor).toBeVisible();
  await expect.poll(() => page.evaluate(async (tripId) => {
    const trip = await (window as any).__lt.store.getTrip(tripId);
    return { name: trip.name, activity: trip.activity, statsCache: trip.statsCache };
  }, id)).toEqual({ name: '失败后保留输入', activity: 'run', statsCache: null });

  await page.evaluate(() => (window as any).__restoreTripUpdate());
  await editor.getByRole('combobox', { name: '活动', exact: true }).selectOption('hike');
  await saveEditor(page, editor);
  await expect.poll(() => page.evaluate(async (tripId) => {
    const trip = await (window as any).__lt.store.getTrip(tripId);
    return { activity: trip.activity, calories: trip.statsCache?.calories };
  }, id)).toMatchObject({ activity: 'hike', calories: expect.any(Number) });
  expect(await page.evaluate(async (tripId) => {
    const trip = await (window as any).__lt.store.getTrip(tripId);
    return trip.statsCache.calories;
  }, id)).toBeGreaterThan(0);
});
