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

test('GPS repair explains categories, versions changes, and restores the persistent original snapshot', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await blockExternal(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  const id = await page.evaluate(async () => {
    const { store } = (window as any).__lt;
    const trip = await store.createTrip({ name: '可逆修复验收', activity: 'drive', status: 'finished' });
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
  const repair = quality.locator('.gps-repair');
  await expect(quality).toContainText('可解释轨迹修复');
  await expect(repair.locator('.repair-metrics')).toContainText('修复前');
  await expect(repair.locator('.repair-metrics')).toContainText('修复后');
  await expect(repair.locator('.repair-metrics').getByRole('row', { name: /轨迹点\s+9\s+6/ })).toBeVisible();
  const speed = repair.locator('.repair-category').filter({ hasText: '速度跳变' });
  await expect(speed).toContainText('3 项');
  await expect(speed.getByRole('checkbox')).toBeChecked();
  await expect(page.locator('#trip-detail')).toHaveAttribute('data-section', 'data');
  await speed.locator('.repair-reasons summary').click();
  await expect(speed.locator('.repair-reason')).toHaveCount(3);
  await speed.locator('.repair-reason').first().click();
  await expect(page.locator('#trip-detail')).toHaveAttribute('data-section', 'overview');
  await expect(page.locator('.analysis-map canvas').first()).toBeVisible();
  await expect(page.locator('.analysis-map .chart-hover-dot')).toBeVisible();
  await page.locator('#trip-detail button[data-section="data"]').click();
  await expect(page.locator('#trip-detail')).toHaveAttribute('data-section', 'data');
  await repair.locator('.repair-semantics summary').click();
  await expect(repair.locator('.repair-semantics')).toContainText('不生成或插值定位点');
  await repair.getByRole('button', { name: '应用选中修复', exact: true }).click();
  const repairDialog = page.getByRole('dialog', { name: '确认轨迹修复' });
  await expect(repairDialog).toContainText('独立快照');
  await expect(repairDialog).toContainText('断点只分类、不插值');
  await repairDialog.getByRole('button', { name: '应用选中修复', exact: true }).click();
  await expect(quality).toContainText('已保留清洗前快照');
  await expect(quality).toContainText('修复版本对比');
  await expect.poll(() => page.evaluate(async (tripId) => {
    const full = await (window as any).__lt.store.loadTripFull(tripId);
    const snapshot = await (window as any).__lt.store.getTrackSnapshotSummary(tripId);
    const versions = await (window as any).__lt.store.listTrackRepairVersions(tripId);
    return { points: full.segments[0].points.length, snapshotPoints: snapshot?.points, versions: versions.length };
  }, id)).toEqual({ points: 6, snapshotPoints: 9, versions: 1 });

  await quality.getByRole('button', { name: '恢复原始轨迹', exact: true }).click();
  const restoreDialog = page.getByRole('dialog', { name: '恢复清洗前轨迹' });
  await expect(restoreDialog).toContainText('也会被覆盖');
  await restoreDialog.getByRole('button', { name: '恢复原始轨迹', exact: true }).click();
  await expect.poll(() => page.evaluate(async (tripId) => {
    const full = await (window as any).__lt.store.loadTripFull(tripId);
    return full.segments[0].points.length;
  }, id)).toBe(9);
  await expect(quality).toContainText('已保留清洗前快照');

  await quality.locator('.repair-version-saved').getByRole('button', { name: '恢复此版本', exact: true }).click();
  const versionDialog = page.getByRole('dialog', { name: /恢复修复版本 1/ });
  await expect(versionDialog).toContainText('后来新增的记录段保持不变');
  await versionDialog.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await expect.poll(() => page.evaluate(async (tripId) => {
    const full = await (window as any).__lt.store.loadTripFull(tripId);
    return full.segments[0].points.length;
  }, id)).toBe(6);
  await expect(quality).toContainText('修复版本对比');
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
  await expect(health).toContainText('检查与清理预览均为只读');
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

test('mixed GPS scenarios persist through the real recorder and split long gaps', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await blockExternal(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  await page.exposeFunction('__simulationNetwork', async (online: boolean) => {
    await page.context().setOffline(!online);
  });

  const result = await page.evaluate(async () => {
    const { recorder, store, simulation } = (window as any).__lt;
    const started = await recorder.startRecording({ name: '混合轨迹模拟验收', activity: 'hike', simulated: true });
    if (!started) throw new Error('simulated recording did not start');
    const eventTypes: string[] = [];
    try {
      const run = await simulation.runSimulation({
        scenario: 'mixed', durationMs: 60 * 60_000, sampleMs: 10_000, startTime: Date.now(), seed: 7
      }, {
        onFix: (fix) => recorder.handleFix(fix),
        onEvent: async (event) => {
          eventTypes.push(event.type);
          if (event.type === 'network-offline' || event.type === 'network-online') {
            await (window as any).__simulationNetwork(event.type === 'network-online');
          }
          if (event.type === 'background-suspend' || event.type === 'background-resume') {
            Object.defineProperty(document, 'visibilityState', {
              configurable: true,
              get: () => event.type === 'background-suspend' ? 'hidden' : 'visible'
            });
            document.dispatchEvent(new Event('visibilitychange'));
          }
        }
      });
      const during = {
        status: recorder.rec.status,
        filteredCount: recorder.rec.filteredCount,
        stillMs: recorder.rec.live?.stillMs || 0,
        segCount: recorder.rec.live?.segCount || 0
      };
      await recorder.flushBuffer();
      const tripId = recorder.rec.tripId;
      const track = await store.loadTripTrack(tripId);
      const points = track.segments.flatMap((segment) => segment.points);
      const stored = {
        segments: track.segments.length,
        points: points.length,
        maxAlt: Math.max(...points.map((point) => point.alt)),
        firstT: points[0]?.t,
        lastT: points.at(-1)?.t
      };
      const stopped = await recorder.stopRecording();
      const trip = stopped ? await store.getTrip(stopped) : null;
      if (stopped) await store.deleteTrip(stopped);
      return { run, during, stored, eventTypes, stopped: Boolean(stopped), status: trip?.status };
    } finally {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      if (recorder.rec.status === 'recording') await recorder.stopRecording();
    }
  });

  expect(result.stopped).toBe(true);
  expect(result.status).toBe('finished');
  expect(result.during.status).toBe('recording');
  expect(result.during.filteredCount).toBeGreaterThan(0);
  expect(result.during.stillMs).toBeGreaterThan(0);
  expect(result.during.segCount).toBeGreaterThanOrEqual(3);
  expect(result.run.fixes).toBeGreaterThan(250);
  expect(result.stored.segments).toBeGreaterThanOrEqual(3);
  expect(result.stored.points).toBeGreaterThan(150);
  expect(result.stored.points).toBeLessThan(result.run.fixes);
  expect(result.stored.maxAlt).toBeGreaterThan(240);
  expect(result.run.lastFixT - result.run.firstFixT).toBe(60 * 60_000);
  expect(result.stored.lastT - result.stored.firstT).toBeGreaterThan(50 * 60_000);
  expect(result.eventTypes).toEqual(expect.arrayContaining([
    'gps-drift', 'location-loss', 'location-restored', 'altitude-spike', 'stationary',
    'resume-motion', 'sudden-stop', 'background-suspend', 'background-resume',
    'network-offline', 'network-online'
  ]));
  expect(pageErrors).toEqual([]);
});

test('an accelerated eight-hour hike persists every fix without real-time waiting', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await blockExternal(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);

  const result = await page.evaluate(async () => {
    const { recorder, store, simulation } = (window as any).__lt;
    const started = await recorder.startRecording({ name: '八小时加速录制验收', activity: 'hike', simulated: true });
    if (!started) throw new Error('simulated recording did not start');
    try {
      const run = await simulation.runSimulation({
        scenario: 'hike', durationMs: 8 * 60 * 60_000, sampleMs: 10_000, startTime: Date.now(), seed: 4
      }, {
        onFix: (fix) => recorder.handleFix(fix)
      });
      await recorder.flushBuffer();
      const tripId = recorder.rec.tripId;
      const track = await store.loadTripTrack(tripId);
      const points = track.segments.flatMap((segment) => segment.points);
      const stored = {
        segments: track.segments.length,
        points: points.length,
        duration: points.at(-1).t - points[0].t,
        chunks: await store.db.trackChunks.where('tripId').equals(tripId).count()
      };
      const stopped = await recorder.stopRecording();
      if (stopped) await store.deleteTrip(stopped);
      return { run, stored, stopped: Boolean(stopped) };
    } finally {
      if (recorder.rec.status === 'recording') await recorder.stopRecording();
    }
  });

  expect(result.stopped).toBe(true);
  expect(result.run.fixes).toBe(2881);
  expect(result.stored).toMatchObject({ segments: 1, points: 2881, duration: 8 * 60 * 60_000 });
  expect(result.stored.chunks).toBeGreaterThan(1);
  expect(pageErrors).toEqual([]);
});

test('large interrupted trips boot with a bounded read-only map preview', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await blockExternal(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  const tripId = await page.evaluate(async () => {
    const { store } = (window as any).__lt;
    const trip = await store.createTrip({ name: '大轨迹中断恢复', activity: 'hike', status: 'paused' });
    const segment = await store.addSegment(trip.id);
    const start = Date.now() - 10_000_000;
    const points = Array.from({ length: 10_000 }, (_, index) => ({
      lat: 30 + index / 1_000_000,
      lon: 120 + index / 1_000_000,
      t: start + index * 1000,
      acc: 5,
      alt: 100 + index / 100
    }));
    await store.appendPoints(segment.id, trip.id, points);
    await store.addWaypoint({ tripId: trip.id, lat: 30, lon: 120, time: start, name: '恢复节点' });
    await store.addMedia({ tripId: trip.id, blob: new Blob(['unused']), width: 1, height: 1 });
    return trip.id;
  });

  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  await expect(page.locator('#view-record')).toContainText('大轨迹中断恢复');
  await expect(page.locator('.map-tools button[aria-pressed]')).toBeDisabled();

  const loaded = await page.evaluate(async (id) => {
    const { store } = (window as any).__lt;
    const preview = await store.loadTripPreview(id);
    const full = await store.loadTripFull(id);
    return {
      previewPoints: preview.segments.reduce((sum, segment) => sum + segment.points.length, 0),
      readOnly: preview.readOnly,
      previewWaypoints: preview.waypoints.length,
      previewHasMedia: Object.hasOwn(preview, 'media'),
      fullPoints: full.segments.reduce((sum, segment) => sum + segment.points.length, 0),
      fullMedia: full.media.length
    };
  }, tripId);
  expect(loaded).toEqual({
    previewPoints: 500,
    readOnly: true,
    previewWaypoints: 1,
    previewHasMedia: false,
    fullPoints: 10_000,
    fullMedia: 1
  });
  await page.evaluate((id) => (window as any).__lt.store.deleteTrip(id), tripId);
  expect(pageErrors).toEqual([]);
});

test('spill recovery uses chunk sequence order and appends only fresh points', async ({ page }) => {
  await blockExternal(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  const seeded = await page.evaluate(async () => {
    const { store } = (window as any).__lt;
    const trip = await store.createTrip({ name: '溢出恢复回归', activity: 'hike', status: 'paused' });
    const segment = await store.addSegment(trip.id);
    await store.db.trackChunks.add({
      id: 'z-older-chunk', tripId: trip.id, segmentId: segment.id, seq: 0,
      points: [{ lat: 30, lon: 120, t: 1000 }, { lat: 30.001, lon: 120, t: 2000 }]
    });
    await store.db.segments.update(segment.id, { endTime: 2000 });
    localStorage.setItem('roametch.pendingPoints.v1', JSON.stringify({
      tripId: trip.id,
      segmentId: segment.id,
      points: [
        { lat: 30.0005, lon: 120, t: 1500 },
        { lat: 30.003, lon: 120, t: 3000 },
        { lat: 30.002, lon: 120, t: 2500 },
        { lat: 30.004, lon: 120, t: 3000 },
        { lat: 91, lon: 120, t: 4000 }
      ]
    }));
    return { tripId: trip.id, segmentId: segment.id };
  });

  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  const recovered = await page.evaluate(async ({ tripId, segmentId }) => {
    const { store } = (window as any).__lt;
    const chunks = await store.db.trackChunks.where('segmentId').equals(segmentId).toArray();
    return {
      times: chunks.sort((a, b) => a.seq - b.seq).flatMap((chunk) => chunk.points.map((point) => point.t)),
      spill: localStorage.getItem('roametch.pendingPoints.v1'),
      tripId
    };
  }, seeded);
  expect(recovered.times).toEqual([1000, 2000, 2500, 3000]);
  expect(recovered.spill).toBeNull();
  await page.evaluate((id) => (window as any).__lt.store.deleteTrip(id), recovered.tripId);
});

test('altitude patches stay bounded and backfill streams real IndexedDB chunks', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await blockExternal(page);
  let elevationRequests = 0;
  await page.route('**/__elevation**', async (route) => {
    elevationRequests++;
    const url = new URL(route.request().url());
    const count = (url.searchParams.get('latitude') || '').split(',').filter(Boolean).length;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ elevation: Array.from({ length: count }, () => 321) })
    });
  });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);

  const result = await page.evaluate(async () => {
    const { store } = (window as any).__lt;
    const { set } = await import('/src/core/settings.ts');
    set('elevationEndpoint', '/__elevation');
    const { patchFlushedAltitude, backfillTripAltitudes } = await import('/src/core/elevation.ts');
    const trip = await store.createTrip({ name: '海拔分块回归', activity: 'hike', status: 'finished' });
    const segment = await store.addSegment(trip.id);
    const points = Array.from({ length: 40 }, (_, seq) => ({
      lat: 30 + seq / 1000, lon: 120, t: 1000 + seq * 1000, alt: null, altSrc: null
    }));
    for (let seq = 0; seq < points.length; seq++) {
      await store.db.trackChunks.add({
        id: `altitude-chunk-${seq}`, tripId: trip.id, segmentId: segment.id, seq, points: [points[seq]]
      });
    }
    const oldPatch = await patchFlushedAltitude(segment.id, { ...points[0], alt: 111, altSrc: 'svc' });
    const latestPatch = await patchFlushedAltitude(segment.id, { ...points[39], alt: 222, altSrc: 'svc' });
    const filled = await backfillTripAltitudes(trip.id);
    const chunks = await store.db.trackChunks.where('segmentId').equals(segment.id).toArray();
    const values = chunks.sort((a, b) => a.seq - b.seq).flatMap((chunk) => chunk.points);
    return {
      tripId: trip.id,
      oldPatch,
      latestPatch,
      filled,
      oldAlt: values[0].alt,
      latestAlt: values[39].alt,
      allFilled: values.every((point) => point.alt != null && point.altSrc === 'svc')
    };
  });

  expect(elevationRequests).toBeGreaterThan(0);
  expect(result).toMatchObject({
    oldPatch: false,
    latestPatch: true,
    filled: 39,
    oldAlt: 321,
    latestAlt: 222,
    allFilled: true
  });
  await page.evaluate((id) => (window as any).__lt.store.deleteTrip(id), result.tripId);
  expect(pageErrors).toEqual([]);
});

test('persistent save failures show the bounded degraded state and recover', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await blockExternal(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  await page.evaluate(() => (window as any).__lt.shell.navigate('record'));
  await expect(page.locator('#view-record')).toHaveClass(/active/);

  const limited = await page.evaluate(async () => {
    const { recorder, store } = (window as any).__lt;
    const originalAdd = store.db.trackChunks.add;
    const originalPut = store.db.trackChunks.put;
    (window as any).__saveFailureOriginals = { originalAdd, originalPut };
    store.db.trackChunks.add = async () => { throw new DOMException('quota', 'QuotaExceededError'); };
    store.db.trackChunks.put = async () => { throw new DOMException('quota', 'QuotaExceededError'); };
    if (!(await recorder.startRecording({ name: '保存降级回归', activity: 'hike', simulated: true }))) {
      throw new Error('simulated recording did not start');
    }
    const start = Date.now();
    for (let index = 0; index <= 5000; index++) {
      await recorder.handleFix({
        lat: 30 + index * 0.00006, lon: 120, t: start + index * 1000,
        acc: 5, alt: 100 + index * 0.01, altAcc: 5, speed: 6.5
      });
    }
    return {
      tripId: recorder.rec.tripId,
      pending: recorder.rec.saveState.pending,
      degraded: recorder.rec.saveState.degraded,
      pointCount: recorder.rec.live.pointCount
    };
  });

  expect(limited).toMatchObject({ pending: 5000, degraded: true, pointCount: 5000 });
  await expect(page.locator('#view-record .lp-save')).toHaveText('保存受限');
  await expect(page.locator('#view-record')).toContainText('已达到待写入上限');

  const recovered = await page.evaluate(async (tripId) => {
    const { recorder, store } = (window as any).__lt;
    const { originalAdd, originalPut } = (window as any).__saveFailureOriginals;
    store.db.trackChunks.add = originalAdd;
    store.db.trackChunks.put = originalPut;
    delete (window as any).__saveFailureOriginals;
    const flushed = await recorder.flushBuffer();
    const state = { ...recorder.rec.saveState };
    const stopped = await recorder.stopRecording();
    const points = stopped
      ? (await store.loadTripTrack(stopped)).segments.flatMap((segment) => segment.points).length
      : 0;
    if (stopped) await store.deleteTrip(stopped);
    return { flushed, state, stopped: Boolean(stopped), points, tripId };
  }, limited.tripId);

  expect(recovered).toMatchObject({
    flushed: true,
    stopped: true,
    points: 5000,
    state: { pending: 0, error: null, degraded: false }
  });
  await expect(page.locator('#view-record .lp-save')).toHaveText('已保存');
  expect(pageErrors).toEqual([]);
});

test('a second segment write failure rolls back the entire real IndexedDB gap repair', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await blockExternal(page);
  await page.route('https://brouter.de/brouter**', async (route) => {
    const url = new URL(route.request().url());
    const [from, to] = (url.searchParams.get('lonlats') || '').split('|').map((pair) => pair.split(',').map(Number));
    const middle = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ features: [{ geometry: { type: 'LineString', coordinates: [from, middle, to] } }] })
    });
  });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);

  const result = await page.evaluate(async () => {
    const { store } = (window as any).__lt;
    const { repairTrackGaps } = await import('/src/core/gapRepair.ts');
    const trip = await store.createTrip({ name: '断点修复整笔回滚', activity: 'drive', status: 'finished' });
    const segmentStarts = [
      [[120, 30], [120.001, 30]],
      [[120.01, 30.001], [120.011, 30.001]],
      [[120.02, 30.002], [120.021, 30.002]]
    ];
    for (const [segmentIndex, coordinates] of segmentStarts.entries()) {
      const segment = await store.addSegment(trip.id, 1000 + segmentIndex * 10_000);
      await store.appendPoints(segment.id, trip.id, coordinates.map(([lon, lat], pointIndex) => ({
        lat, lon, t: 1000 + segmentIndex * 10_000 + pointIndex * 1000, acc: 5
      })));
    }
    const snapshot = async () => ({
      trip: await store.getTrip(trip.id),
      track: await store.loadTripTrack(trip.id),
      chunks: (await store.db.trackChunks.where('tripId').equals(trip.id).toArray()).sort((a: any, b: any) => a.id.localeCompare(b.id))
    });
    const before = await snapshot();
    const originalAdd = store.db.trackChunks.add;
    let writeCalls = 0;
    let failure = '';
    try {
      store.db.trackChunks.add = async function (row: any) {
        if (++writeCalls === 2) throw new DOMException('forced second-segment failure', 'QuotaExceededError');
        return originalAdd.call(this, row);
      };
      await repairTrackGaps(trip.id);
    } catch (error: any) {
      failure = error?.message || String(error);
    } finally {
      store.db.trackChunks.add = originalAdd;
    }
    const after = await snapshot();
    await store.deleteTrip(trip.id);
    return { before, after, failure, writeCalls };
  });

  expect(result.failure).toContain('forced second-segment failure');
  expect(result.writeCalls).toBe(2);
  expect(result.after).toEqual(result.before);
  expect(result.after.track.segments.every((segment: any) => segment.points.every((point: any) => !point.synth))).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('backup history shows safe export metadata and clears only its own records', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await blockExternal(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  const exported = await page.evaluate(async () => {
    const { exportBackupFlow } = await import('/src/ui/backupFlow.ts');
    return exportBackupFlow({ promptEncryption: false });
  });
  expect(exported).toBe(true);

  await page.evaluate(() => (window as any).__lt.shell.navigate('settings'));
  const history = page.locator('.backup-history');
  await expect(history).toBeVisible();
  await expect(history).toContainText('导出 · 已导出');
  await expect(history).toContainText('roametch-backup-');
  await expect(history).toContainText('来源：手动');
  await expect(page.locator('#view-settings')).toContainText('不保存密码、轨迹或照片');

  await page.getByRole('button', { name: '清空历史', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '清空历史', exact: true });
  await expect(dialog).toContainText('不删除任何行程或备份文件');
  await dialog.getByRole('button', { name: '清空历史', exact: true }).click();
  await expect(history).toBeHidden();
  expect(await page.evaluate(async () => {
    const { listBackupHistory } = await import('/src/core/backupHistory.ts');
    return listBackupHistory();
  })).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('guided restore drill uses temporary databases and records a safe result', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await blockExternal(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  const before = await page.evaluate(async () => {
    const { db } = (window as any).__lt.store;
    const names = ['trips', 'segments', 'trackChunks', 'trackSnapshots', 'waypoints', 'media', 'elevCache', 'shareImports'];
    const counts = await Promise.all(names.map((name) => db[name].count()));
    return { counts, databases: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).map((item: any) => item.name) : [] };
  });

  await page.evaluate(() => (window as any).__lt.shell.navigate('settings'));
  await expect(page.locator('#view-settings')).toContainText('不读写真实行程');
  await page.getByRole('button', { name: '恢复演练', exact: true }).click();
  await expect(page.locator('#restore-drill-status')).toContainText('恢复演练通过', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: '取消演练', exact: true })).toBeHidden();
  const history = page.locator('.backup-history');
  await expect(history).toContainText('恢复演练 · 演练通过');
  await expect(history).toContainText('restore-drill.trip');
  await expect(history).toContainText('来源：恢复演练');

  const after = await page.evaluate(async () => {
    const { db } = (window as any).__lt.store;
    const { listBackupHistory } = await import('/src/core/backupHistory.ts');
    const names = ['trips', 'segments', 'trackChunks', 'trackSnapshots', 'waypoints', 'media', 'elevCache', 'shareImports'];
    const counts = await Promise.all(names.map((name) => db[name].count()));
    const databases = typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).map((item: any) => item.name) : [];
    return { counts, databases, record: (await listBackupHistory()).find((item: any) => item.kind === 'drill') };
  });
  expect(after.counts).toEqual(before.counts);
  expect(after.databases.filter((name) => name.startsWith('localtrace-restore-drill-'))).toEqual([]);
  expect(after.record).toMatchObject({
    kind: 'drill', status: 'drill-passed', source: 'drill', filename: 'restore-drill.trip',
    trips: 1, segments: 1, chunks: 1, waypoints: 1, media: 1, mediaChecked: 2, mediaFailed: 0
  });
  expect(pageErrors).toEqual([]);
});
