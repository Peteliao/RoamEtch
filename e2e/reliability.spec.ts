import { test, expect } from '@playwright/test';
import { blockExternal, openDemo } from './utils';

test('historical trip thumbnails are rebuilt from saved segments', async ({ page }) => {
  await blockExternal(page);
  let tileRequests = 0;
  await page.route(/^https:\/\/(?:(?:webrd|webst|wprd)0\d\.is\.autonavi\.com|tile\.openstreetmap\.org)\//, async (route) => {
    tileRequests++;
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dfe8e5"/><path d="M0 180L256 70M80 0L120 256" stroke="#fff" stroke-width="18"/><circle cx="120" cy="180" r="70" fill="#b7d9ef"/></svg>'
    });
  });
  await openDemo(page);

  await page.evaluate(async () => {
    const store = window.__lt.store;
    const trips = await store.listTrips();
    await store.updateTrip(trips[0].id, { thumbPoints: null }, { touch: false });
    const trip = await store.createTrip({
      name: '缩略图回归行程', activity: 'hike', status: 'finished', createdAt: Date.now() - 60_000
    });
    const segment = await store.addSegment(trip.id);
    await store.appendPoints(segment.id, trip.id, [
      { lat: 30.25, lon: 120.15, t: Date.now() - 30_000 },
      { lat: 30.26, lon: 120.16, t: Date.now() - 20_000 },
      { lat: 30.27, lon: 120.17, t: Date.now() - 10_000 }
    ]);
  });

  await page.locator('.trip-detail-back').click();
  await expect(page.locator('#trip-detail')).toBeHidden();
  await expect.poll(() => page.evaluate(() => history.state?.lt?.detail)).toBe(false);
  const thumbnails = page.locator('.trip-item .thumb img');
  await expect(thumbnails).toHaveCount(2);
  await expect(thumbnails.first()).toBeVisible();
  await expect.poll(() => thumbnails.evaluateAll((images) => images.every((img) => {
    const image = img as HTMLImageElement;
    return image.complete && image.naturalWidth === 108 && image.src.startsWith('data:image/webp');
  }))).toBe(true);
  expect(tileRequests).toBeGreaterThan(0);
  const stored = await page.evaluate(async () => {
    const trips = await window.__lt.store.listTrips();
    return trips.map((trip) => trip.thumbPoints?.length || 0);
  });
  expect(stored.every((length) => length >= 2)).toBe(true);
});

test('trip thumbnails retry their basemap when connectivity returns', async ({ page }) => {
  await blockExternal(page);
  let tileRequests = 0;
  await page.route(/^https:\/\/(?:(?:webrd|webst|wprd)0\d\.is\.autonavi\.com|tile\.openstreetmap\.org)\//, async (route) => {
    tileRequests++;
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dfe8e5"/><path d="M0 180L256 70" stroke="#fff" stroke-width="18"/></svg>'
    });
  });
  await openDemo(page);
  tileRequests = 0;
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await page.locator('.trip-detail-back').click();
  await expect(page.locator('#trip-detail')).toBeHidden();
  await expect.poll(() => page.evaluate(() => history.state?.lt?.detail)).toBe(false);
  const thumbnail = page.locator('.trip-item .thumb img').first();
  await expect(thumbnail).toBeVisible();
  const offlineSrc = await thumbnail.getAttribute('src');
  const beforeOnline = tileRequests;

  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => tileRequests).toBeGreaterThan(beforeOnline);
  await expect.poll(() => thumbnail.getAttribute('src')).not.toBe(offlineSrc);
});

test('GPS cleaning previews anomalies and restores the persistent original snapshot', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await blockExternal(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  const id = await page.evaluate(async () => {
    const { store } = (window as any).__lt;
    const trip = await store.createTrip({ name: '可逆清洗验收', activity: 'drive', status: 'finished' });
    const segment = await store.addSegment(trip.id);
    const point = (lon: number, t: number) => ({ lat: 30, lon: 120 + lon / 95_600, t, acc: 5, alt: 100 });
    const forward = [0, -100, -200, -300, -400].map((lon, i) => point(lon, i * 5_000));
    const falseCluster = [-100, -200, -300].map((lon, i) => point(lon, (i + 5) * 5_000));
    await store.appendPoints(segment.id, trip.id, [...forward, ...falseCluster, point(-450, 40_000)]);
    return trip.id;
  });
  await page.evaluate((tripId) => {
    (window as any).__lt.shell.navigate('trips', { detail: true, tripId, section: 'data' });
  }, id);

  const quality = page.locator('#view-analysis .quality-card');
  await expect(quality).toContainText('发现 3 个可清理的异常点');
  await expect(quality.locator('.gps-issue')).toHaveCount(1);
  await expect(page.locator('#trip-detail')).toHaveAttribute('data-section', 'data');
  await quality.locator('.gps-issue').click();
  await expect(page.locator('#trip-detail')).toHaveAttribute('data-section', 'overview');
  await expect(page.locator('.analysis-map canvas').first()).toBeVisible();
  await expect(page.locator('.analysis-map .chart-hover-dot')).toBeVisible();
  await page.locator('#trip-detail button[data-section="data"]').click();
  await expect(page.locator('#trip-detail')).toHaveAttribute('data-section', 'data');
  await quality.getByRole('button', { name: '清洗异常定位', exact: true }).click();
  const cleanDialog = page.getByRole('dialog', { name: '清洗异常定位' });
  await expect(cleanDialog).toContainText('独立快照');
  await cleanDialog.getByRole('button', { name: '清洗异常定位', exact: true }).click();
  await expect(quality).toContainText('已保留清洗前快照');
  await expect.poll(() => page.evaluate(async (tripId) => {
    const full = await (window as any).__lt.store.loadTripFull(tripId);
    const snapshot = await (window as any).__lt.store.getTrackSnapshotSummary(tripId);
    return { points: full.segments[0].points.length, snapshotPoints: snapshot?.points };
  }, id)).toEqual({ points: 6, snapshotPoints: 9 });

  await quality.getByRole('button', { name: '恢复原始轨迹', exact: true }).click();
  const restoreDialog = page.getByRole('dialog', { name: '恢复清洗前轨迹' });
  await expect(restoreDialog).toContainText('也会被覆盖');
  await restoreDialog.getByRole('button', { name: '恢复原始轨迹', exact: true }).click();
  await expect.poll(() => page.evaluate(async (tripId) => {
    const full = await (window as any).__lt.store.loadTripFull(tripId);
    return full.segments[0].points.length;
  }, id)).toBe(9);
  await expect(quality).toContainText('已保留清洗前快照');
  expect(pageErrors).toEqual([]);
});

test('fixed-distance splits link the selected row to the map and chart', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('localtrace.settings.v1', JSON.stringify({
      language: 'zh', regionMode: 'cn', theme: 'dark',
      sim: { enabled: true, network: 'offline', playbackSpeed: 20 }
    }));
  });
  await blockExternal(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  const id = await page.evaluate(async () => {
    const { store } = (window as any).__lt;
    const trip = await store.createTrip({ name: '固定距离分段验收', activity: 'hike', status: 'finished' });
    const start = Date.now() - 3_600_000;
    const lonStep = 75 / (111_320 * Math.cos(30 * Math.PI / 180));
    for (const [segmentIndex, lat, lon] of [[0, 30, 120], [1, 30.01, 120.01]] as const) {
      const segment = await store.addSegment(trip.id, start + segmentIndex * 600_000);
      const points = Array.from({ length: 11 }, (_, index) => ({
        lat, lon: lon + index * lonStep, t: start + segmentIndex * 600_000 + index * 30_000,
        alt: 100 + index, acc: 5, speed: 2.5, heading: 90
      }));
      await store.appendPoints(segment.id, trip.id, points);
    }
    return trip.id;
  });
  await page.evaluate((tripId) => {
    (window as any).__lt.shell.navigate('trips', { detail: true, tripId, section: 'overview' });
  }, id);

  const card = page.locator('#view-analysis .split-card');
  const rows = card.locator('.split-row');
  await expect(card).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText('不足一段');
  await card.getByLabel('分段距离').selectOption('500');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText('不足一段');
  await card.getByLabel('分段距离').selectOption('2000');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('不足一段');
  await card.getByLabel('分段距离').selectOption('5000');
  await expect(rows).toHaveCount(1);
  await card.getByLabel('分段距离').selectOption('1000');
  await expect(rows).toHaveCount(2);

  const mapCanvas = page.locator('.analysis-map canvas').first();
  const chartCanvas = page.locator('.chart-wrap canvas').first();
  await expect(mapCanvas).toBeVisible();
  await expect(chartCanvas).toBeVisible();
  const mapBefore = await mapCanvas.screenshot();
  const chartBefore = await chartCanvas.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(rows.nth(1)).toHaveClass(/selected/);
  await expect.poll(async () => !(await mapCanvas.screenshot()).equals(mapBefore)).toBe(true);
  await expect.poll(() => chartCanvas.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).not.toBe(chartBefore);
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'false');

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('storage health reports issues without modifying records', async ({ page }) => {
  await blockExternal(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  await page.evaluate(async () => {
    const { store } = (window as any).__lt;
    const trip = await store.createTrip({ name: '存储健康验收', activity: 'hike', status: 'finished' });
    const segment = await store.addSegment(trip.id);
    await store.appendPoints(segment.id, trip.id, [{ lat: 30, lon: 120, t: Date.now() }]);
    await store.addMedia({ tripId: trip.id, blob: new Blob(['unused']), width: 1, height: 1 });
    await store.db.trackChunks.add({
      id: 'orphan-health-check', tripId: 'missing-trip', segmentId: 'missing-segment', seq: 0, points: []
    });
  });
  await page.evaluate(() => (window as any).__lt.shell.navigate('settings'));
  await expect(page.locator('#view-settings')).toContainText('持久存储');
  await page.getByRole('button', { name: '检查存储完整性', exact: true }).click();
  const health = page.locator('.storage-health');
  await expect(health).toBeVisible();
  await expect(health).toContainText('孤立轨迹块');
  await expect(health).toContainText('未被节点引用的媒体');
  await expect(health).toContainText('此检查只读');
  expect(await page.evaluate(async () => {
    const { db } = (window as any).__lt.store;
    return {
      orphan: await db.trackChunks.get('orphan-health-check'),
      media: await db.media.count(),
      chunks: await db.trackChunks.count()
    };
  })).toMatchObject({ orphan: { id: 'orphan-health-check' }, media: 1, chunks: 2 });
});

test('temporary location loss stays recording and recovers automatically', async ({ page }) => {
  await page.addInitScript(() => {
    const mock: any = { watchCalls: 0, currentCalls: 0, error: false, succeed: null, fail: null };
    const fix = () => ({
      coords: { latitude: 30.25, longitude: 120.15, accuracy: 5, altitude: 10, altitudeAccuracy: 8, speed: 1, heading: 0 },
      timestamp: Date.now()
    });
    const unavailable = { code: 2, message: 'temporarily unavailable' };
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition(success: any, failure: any) {
          mock.watchCalls++;
          mock.succeed = success;
          mock.fail = failure;
          queueMicrotask(() => mock.error ? failure(unavailable) : success(fix()));
          return mock.watchCalls;
        },
        getCurrentPosition(success: any, failure: any) {
          mock.currentCalls++;
          queueMicrotask(() => mock.error ? failure(unavailable) : success(fix()));
        },
        clearWatch() {}
      }
    });
    (window as any).__geoMock = mock;
  });
  await blockExternal(page);
  await openDemo(page);

  expect(await page.evaluate(() => window.__lt.recorder.startRecording({ name: '后台恢复回归', activity: 'hike' }))).toBe(true);
  await page.evaluate(() => {
    const mock = (window as any).__geoMock;
    mock.error = true;
    mock.fail({ code: 2, message: 'temporarily unavailable' });
  });
  await expect.poll(() => page.evaluate(() => window.__lt.recorder.rec.geoError)).toBe('unavailable');
  expect(await page.evaluate(() => window.__lt.recorder.rec.status)).toBe('recording');
  await expect.poll(() => page.evaluate(() => (window as any).__geoMock.watchCalls), { timeout: 8000 }).toBeGreaterThan(1);

  await page.evaluate(() => {
    const mock = (window as any).__geoMock;
    mock.error = false;
    mock.succeed({
      coords: { latitude: 30.26, longitude: 120.16, accuracy: 5, altitude: 11, altitudeAccuracy: 8, speed: 1, heading: 0 },
      timestamp: Date.now()
    });
  });
  await expect.poll(() => page.evaluate(() => window.__lt.recorder.rec.geoError)).toBe(null);

  const beforeReturn = await page.evaluate(() => (window as any).__geoMock.watchCalls);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(() => (window as any).__geoMock.watchCalls)).toBeGreaterThan(beforeReturn);
  expect(await page.evaluate(() => window.__lt.recorder.rec.status)).toBe('recording');
  await page.evaluate(() => window.__lt.recorder.stopRecording());
});
