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
  await page.locator('.trip-detail-back').click();
  await expect(page.locator('#trip-detail')).toBeHidden();

  const card = page.locator('.footprint-card');
  const toggle = card.locator('.footprint-toggle');
  const content = card.locator('#yearly-footprint-content');
  await expect(card).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(content).toBeHidden();
  const [cardBox, searchBox, firstTripBox] = await Promise.all([
    card.boundingBox(),
    page.locator('.search-bar').boundingBox(),
    page.locator('.trip-item').first().boundingBox()
  ]);
  expect(cardBox!.y).toBeLessThan(searchBox!.y);
  expect(cardBox!.y).toBeLessThan(firstTripBox!.y);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(content).toBeVisible();
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

test('annual footprint exports keep city KPIs and privacy text separated across themes', async ({ page }) => {
  test.setTimeout(120_000);
  await blockExternal(page);
  await page.route(/^https:\/\/(?:(?:webrd|webst|wprd)0\d\.is\.autonavi\.com|tile\.openstreetmap\.org)\//, async (route) => {
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dfe8e5"/></svg>'
    });
  });
  await openDemo(page);

  const outputs = await page.evaluate(async () => {
    const { setLanguage } = await import('/src/core/i18n.ts');
    const { setThemeModeOverride } = await import('/src/core/theme.ts');
    const { generateFootprintImage, generateFootprintVideo } = await import('/src/core/footprintShare.ts');
    const originalFillText = CanvasRenderingContext2D.prototype.fillText;
    const seen = new Set<string>();
    const draws: any[] = [];
    const privacyText = 'Yearly totals and city names only · no tracks, precise coordinates or photos';
    const fp = {
      year: 2026, trips: 3, distance: 17_500, ascent: 350, duration: 7_200_000, days: 2,
      cities: [
        { name: 'Hangzhou', lat: 30.27, lon: 120.15, trips: 2 },
        { name: 'Shanghai', lat: 31.23, lon: 121.47, trips: 1 },
        { name: 'Beijing', lat: 39.9, lon: 116.4, trips: 1 }
      ],
      months: Array.from({ length: 12 }, (_, i) => ({
        month: i + 1,
        trips: i === 10 ? 2 : i === 5 ? 1 : 0,
        distance: i === 10 ? 12_000 : i === 5 ? 5_500 : 0,
        ascent: i === 10 ? 250 : i === 5 ? 100 : 0,
        days: i === 10 ? 1 : i === 5 ? 1 : 0
      }))
    };

    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      const height = this.canvas.height;
      const inKpi = height === 1620 ? y > 506 && y < 690 : height === 1920 && y > 650 && y < 876;
      const inMonths = height === 1620 ? y > 1132 && y < 1422 : height === 1920 && y > 1310 && y < 1580;
      if (this.canvas.width === 1080 && (inKpi || inMonths || String(text) === privacyText)) {
        const value = String(text);
        const key = `${height}|${value}|${x}|${y}|${this.textAlign}|${this.font}`;
        if (!seen.has(key)) {
          seen.add(key);
          const metrics = this.measureText(value);
          const fontSize = Number(this.font.match(/(\d+(?:\.\d+)?)px/)?.[1]) || 18;
          const left = x - (this.textAlign === 'right' ? metrics.width : this.textAlign === 'center' ? metrics.width / 2 : 0);
          draws.push({
            text: value, x, y, align: this.textAlign, font: this.font, width: metrics.width,
            left,
            right: left + metrics.width,
            top: y - (metrics.actualBoundingBoxAscent || fontSize * 0.8),
            bottom: y + (metrics.actualBoundingBoxDescent || fontSize * 0.2)
          });
        }
      }
      return maxWidth === undefined ? originalFillText.call(this, text, x, y) : originalFillText.call(this, text, x, y, maxWidth);
    };

    const results: any[] = [];
    try {
      await setLanguage('en');
      for (const theme of ['dark', 'light', 'contrast', 'matrix']) {
        setThemeModeOverride(theme);
        seen.clear();
        draws.length = 0;
        const image = await generateFootprintImage(fp);
        const bitmap = await createImageBitmap(image.blob);
        const result: any = { theme, image: { width: bitmap.width, height: bitmap.height, draws: draws.slice() } };
        bitmap.close();
        if (theme === 'contrast' || theme === 'matrix') {
          seen.clear();
          draws.length = 0;
          const video = await generateFootprintVideo(fp, { music: 'dawn' });
          result.video = { width: video.width, height: video.height, draws: draws.slice() };
        }
        results.push(result);
      }
    } finally {
      CanvasRenderingContext2D.prototype.fillText = originalFillText;
      setThemeModeOverride(null);
    }
    return results;
  });

  const privacyText = 'Yearly totals and city names only · no tracks, precise coordinates or photos';
  const topMonthText = 'Nov led the way · 2 trips · 12.00km';
  const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const kpis = [
    ['17.50km', 'Distance'], ['3', 'Trips'], ['2', 'Record days'],
    ['3', 'City footprint'], ['350m', 'Ascent']
  ];

  for (const output of outputs) {
    for (const kind of output.video ? ['image', 'video'] : ['image']) {
      const render = output[kind];
      const height = render.height;
      expect(render.width).toBe(1080);
      expect(height).toBe(kind === 'image' ? 1620 : 1920);
      const kpiDraws = render.draws.filter((draw: any) => height === 1620 ? draw.y > 506 && draw.y < 690 : draw.y > 650 && draw.y < 876);
      const labels = kpis.map(([, label]) => kpiDraws.find((draw: any) => draw.text === label));
      expect(labels.every(Boolean)).toBe(true);
      expect(new Set(labels.map((label: any) => label.y)).size).toBe(1);
      for (const [value, label] of kpis) {
        const labelDraw = kpiDraws.find((draw: any) => draw.text === label);
        expect(kpiDraws.some((draw: any) => draw.text === value && draw.x === labelDraw.x && draw.y < labelDraw.y)).toBe(true);
      }

      const topMonth = render.draws.find((draw: any) => draw.text === topMonthText);
      expect(topMonth).toBeTruthy();
      const labelsInChart = monthLabels.map((label) => render.draws.find((draw: any) => draw.text === label));
      expect(labelsInChart.every(Boolean)).toBe(true);
      const lowestLabelBottom = Math.max(...labelsInChart.map((draw: any) => draw.bottom));
      expect(topMonth.top - lowestLabelBottom).toBeGreaterThanOrEqual(12);

      const privacy = render.draws.find((draw: any) => draw.text === privacyText);
      expect(privacy).toBeTruthy();
      expect(privacy.align).toBe('right');
      const highContrast = output.theme === 'contrast';
      const qrSize = kind === 'image' ? 100 : 150;
      const footerY = kind === 'image' ? 1432 : 1620;
      const right = highContrast ? 986 : 1008;
      const textLeft = highContrast ? 222 + (kind === 'video' ? 50 : 0) : 202 + (kind === 'video' ? 50 : 0);
      expect(privacy.x).toBeCloseTo(right, 3);
      expect(privacy.left).toBeGreaterThanOrEqual(textLeft);
      expect(privacy.right).toBeLessThanOrEqual(right + 0.5);
      expect(privacy.y).toBeGreaterThan(footerY + qrSize);
      const safeBottom = highContrast ? footerY + qrSize + 38 - 10 : height - 36;
      expect(privacy.bottom).toBeLessThanOrEqual(safeBottom);
    }
  }
});
