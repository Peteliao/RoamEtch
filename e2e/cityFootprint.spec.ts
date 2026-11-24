import { test, expect } from '@playwright/test';
import { blockExternal, gotoTab, openDemo } from './utils';

test('city footprint asks for consent, lights the map and reaches the share image', async ({ page }) => {
  await blockExternal(page);
  let geocodeRequests = 0;
  const tileZooms: number[] = [];
  await page.route(/^https:\/\/(?:(?:webrd|webst|wprd)0\d\.is\.autonavi\.com|tile\.openstreetmap\.org)\//, async (route) => {
    const url = route.request().url();
    const zoom = Number(url.match(/[?&]z=(\d+)/)?.[1] || url.match(/\/(\d+)\/\d+\/\d+\.png/)?.[1]);
    if (Number.isFinite(zoom)) tileZooms.push(zoom);
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dfe8e5"/><path d="M0 180L256 70" stroke="#fff" stroke-width="18"/></svg>'
    });
  });
  await page.route('https://photon.komoot.io/**', async (route) => {
    geocodeRequests++;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ features: [{ properties: { city: '杭州' } }] })
    });
  });
  await openDemo(page);
  await gotoTab(page, 'settings');
  await page.getByRole('button', { name: '国内方案', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__lt.region.effective)).toBe('cn');
  await gotoTab(page, 'trips');

  const card = page.locator('.footprint-card');
  await expect(card.locator('.footprint-map')).toBeVisible();
  await expect(card.locator('.city-footprint-marker')).toHaveCount(0);
  await expect(card).not.toContainText('null');
  const beforeConsent = geocodeRequests;

  await card.getByRole('button', { name: '点亮城市', exact: true }).click();
  const consent = page.locator('.modal-backdrop .modal');
  await expect(consent).toContainText('隐私圈');
  expect(geocodeRequests).toBe(beforeConsent);
  await consent.getByRole('button', { name: '同意并点亮' }).click();

  await expect(card.locator('.city-footprint-marker').first()).toBeVisible({ timeout: 30_000 });
  await expect(card.locator('.city-footprint-marker')).toHaveCount(1);
  expect(geocodeRequests).toBeGreaterThan(beforeConsent);
  await expect(card.locator('.footprint-city-list')).toContainText('杭州');
  expect(await page.evaluate(() => localStorage.getItem('roametch.cityFootprintConsent.v1'))).toBe('yes');

  await page.evaluate(() => {
    const probe: any = { cityLabels: 0, videoCityLabels: 0, audioContexts: 0, imageArcs: [] };
    (window as any).__footprintDrawProbe = probe;
    const arc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.arc = function (x, y, radius, start, end, counterclockwise) {
      if (this.canvas.width === 1080 && this.canvas.height === 1620 && y > 722 && y < 1112) probe.imageArcs.push({ x, y, radius });
      return arc.call(this, x, y, radius, start, end, counterclockwise);
    };
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (String(text).includes('杭州')) {
        if (this.canvas.width === 1080 && this.canvas.height === 1620) probe.cityLabels++;
        if (this.canvas.width === 1080 && this.canvas.height === 1920) probe.videoCityLabels++;
      }
      return maxWidth === undefined ? fillText.call(this, text, x, y) : fillText.call(this, text, x, y, maxWidth);
    };
    const Offline = (window as any).OfflineAudioContext;
    if (Offline) {
      (window as any).OfflineAudioContext = class extends Offline {
        constructor(...args: any[]) {
          super(...args);
          probe.audioContexts++;
        }
      };
    }
  });
  tileZooms.length = 0;
  await card.getByRole('button', { name: '分享图片', exact: true }).click();
  await expect(page.locator('.promo-preview-img')).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__footprintDrawProbe.cityLabels)).toBeGreaterThan(0);
  const marker = await page.evaluate(async () => {
    const cached = JSON.parse(localStorage.getItem('roametch.cities.v1') || '{}');
    const city = Object.values(cached)[0] as any;
    const coordsUrl = '/src/core/coords.ts';
    const mapUrl = '/src/core/mapPaint.ts';
    const { toDisplay } = await import(coordsUrl);
    const { mercatorFit } = await import(mapUrl);
    const [lon, lat] = toDisplay(city.lon, city.lat, 'GCJ02');
    const point = { lon, lat };
    const fit = mercatorFit([point], 936, 390, 50, 10);
    const [px, py] = fit.toPx(point);
    return {
      expectedX: 72 + px,
      expectedY: 722 + py,
      actual: (window as any).__footprintDrawProbe.imageArcs.find((item: any) => item.radius >= 10 && item.radius <= 20)
    };
  });
  expect(marker.actual).toBeTruthy();
  expect(marker.actual.x).toBeCloseTo(marker.expectedX, 3);
  expect(marker.actual.y).toBeCloseTo(marker.expectedY, 3);
  expect(tileZooms.length).toBeGreaterThan(0);
  const footprintMaxZoom = Math.max(...tileZooms);
  expect(footprintMaxZoom).toBeLessThanOrEqual(10);
  await page.keyboard.press('Escape');

  tileZooms.length = 0;
  await card.getByRole('button', { name: '生成足迹视频', exact: true }).click();
  const video = page.locator('.fp-video');
  await expect(video).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__footprintDrawProbe.videoCityLabels)).toBeGreaterThan(0);
  // Video may reuse already loaded tiles; both outputs share the verified zoom-limited map helper.
  expect(tileZooms.every((zoom) => zoom <= 10)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__footprintDrawProbe.audioContexts)).toBeGreaterThan(0);
  await expect.poll(() => video.evaluate(async (element) => {
    const media = element as HTMLVideoElement;
    await media.play();
    return (media as any).captureStream().getAudioTracks().length;
  })).toBeGreaterThan(0);
});
