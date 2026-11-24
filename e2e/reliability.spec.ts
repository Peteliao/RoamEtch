import { test, expect } from '@playwright/test';
import { blockExternal, gotoTab, openDemo } from './utils';

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

  await gotoTab(page, 'trips');
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
  await gotoTab(page, 'trips');
  const thumbnail = page.locator('.trip-item .thumb img').first();
  await expect(thumbnail).toBeVisible();
  const offlineSrc = await thumbnail.getAttribute('src');
  const beforeOnline = tileRequests;

  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => tileRequests).toBeGreaterThan(beforeOnline);
  await expect.poll(() => thumbnail.getAttribute('src')).not.toBe(offlineSrc);
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
