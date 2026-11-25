import { expect, test } from '@playwright/test';
import { blockExternal, gotoTab } from './utils';

const SETTINGS_KEY = 'localtrace.settings.v1';

async function selectMatrix(page: import('@playwright/test').Page) {
  await gotoTab(page, 'settings');
  const matrix = page.getByRole('button', { name: '矩阵', exact: true });
  await expect(matrix).toBeVisible();
  await matrix.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'matrix');
  return matrix;
}

function expectMatrixPixel(pixel: number[]) {
  expect(pixel[1]).toBeGreaterThan(pixel[0] + 1);
  expect(pixel[1]).toBeGreaterThan(pixel[2]);
  expect(Math.max(...pixel)).toBeLessThan(80);
}

test('Matrix persists across reload and wraps cleanly on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await blockExternal(page);
  await page.goto('/');
  const matrix = await selectMatrix(page);

  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#000300');
  const styles = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return { bg: root.getPropertyValue('--bg').trim(), accent: root.getPropertyValue('--accent').trim() };
  });
  expect(styles).toEqual({ bg: '#000300', accent: '#39ff88' });
  const toggle = matrix.locator('..');
  await expect(toggle.locator('button')).toHaveCount(15);
  const boxes = await toggle.locator('button').evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width };
  }));
  expect(boxes.every((box) => box.left >= 0 && box.right <= 360 && box.width > 0)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'matrix');
  await gotoTab(page, 'settings');
  await expect(page.getByRole('button', { name: '矩阵', exact: true })).toHaveClass(/active/);
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}').theme, SETTINGS_KEY)).toBe('matrix');
});

test('runtime Matrix switching restyles MapLibre controls while recording continues', async ({ page }) => {
  await blockExternal(page);
  await page.goto('/?sim=1');
  await expect(page.locator('#view-record.active')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__lt.recorder.rec.status), { timeout: 30_000 }).toBe('recording');

  await selectMatrix(page);
  await gotoTab(page, 'record');
  const group = page.locator('.maplibregl-ctrl-group').first();
  const attribution = page.locator('.maplibregl-ctrl-attrib').first();
  await expect(group).toBeVisible();
  await expect(attribution).toBeAttached();
  const mapStyles = await page.evaluate(() => {
    const control = document.querySelector('.maplibregl-ctrl-group')!;
    const attrib = document.querySelector('.maplibregl-ctrl-attrib')!;
    return {
      controlBg: getComputedStyle(control).backgroundColor,
      controlBorder: getComputedStyle(control).borderTopColor,
      attribBg: getComputedStyle(attrib).backgroundColor
    };
  });
  expect(mapStyles.controlBg).toBe('rgb(2, 8, 5)');
  expect(mapStyles.controlBorder).toContain('57, 255, 136');
  expect(mapStyles.attribBg).toContain('0, 20, 8');
  expect(await page.evaluate(() => (window as any).__lt.recorder.rec.status)).toBe('recording');
});

test('reduced motion stops Matrix rain and OLED lock restores the saved theme', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await blockExternal(page);
  await page.goto('/?sim=1');
  await expect(page.locator('#view-record.active')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__lt.recorder.rec.status), { timeout: 30_000 }).toBe('recording');
  await selectMatrix(page);
  await gotoTab(page, 'record');

  const motion = await page.evaluate(() => ({
    name: getComputedStyle(document.querySelector('#app')!, '::before').animationName,
    scanlines: getComputedStyle(document.querySelector('#app')!, '::after').pointerEvents
  }));
  expect(motion).toEqual({ name: 'none', scanlines: 'none' });

  await page.locator('.power-lock-entry').click();
  await expect(page.locator('#oled-dash.active')).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'matrix');
  await expect(page.locator('#oled-dash button')).toHaveCount(1);
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}').theme, SETTINGS_KEY)).toBe('matrix');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('#app')!, '::before').display)).toBe('none');
  expect(await page.evaluate(() => (window as any).__lt.recorder.rec.status)).toBe('recording');

  await page.locator('.ps-unlock').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#oled-dash.active')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'matrix');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#000300');
});

test('Matrix reaches promo, poster, footprint and standalone HTML exports', async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ theme: 'matrix' }));
  }, SETTINGS_KEY);
  await blockExternal(page);
  await page.goto('/?demo=1');
  await expect(page.locator('#trip-detail.active')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'matrix');

  const result = await page.evaluate(async () => {
    const lt = (window as any).__lt;
    const trips = await lt.store.listTrips();
    const full = await lt.store.loadTripFull(trips[0].id);
    const { generatePromo } = await import('/src/core/promo.ts');
    const { generatePoster } = await import('/src/core/poster.ts');
    const { generateFootprintImage } = await import('/src/core/footprintShare.ts');
    const { buildSelfContainedHTML } = await import('/src/core/htmlExport.ts');

    const sample = async (source: Blob | HTMLCanvasElement) => {
      const bitmap = await createImageBitmap(source, 0, 0, 1, 1);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const pixel = Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
      bitmap.close();
      return pixel;
    };

    const promo = await generatePromo(0);
    const poster = await generatePoster(full, { vectorOnly: true });
    const footprint = await generateFootprintImage({
      year: 2026, trips: 1, distance: 1200, ascent: 35, duration: 600, days: 1, cities: [],
      months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, trips: i === 0 ? 1 : 0, distance: i === 0 ? 1200 : 0, ascent: i === 0 ? 35 : 0, days: i === 0 ? 1 : 0 }))
    });
    const html = await buildSelfContainedHTML(full, { includePhotos: false });
    return {
      promo: await sample(promo.blob),
      poster: await sample(poster.canvas),
      footprint: await sample(footprint.blob),
      html: {
        initial: html.html.includes('data-theme="matrix"'),
        palette: html.html.includes('"matrix":'),
        cycle: html.html.includes('"themeCycle":["dark","light","contrast","matrix","neon","starship","aurora","amber","deepsea","vermilion","sakura","butterfly","pearl","rose"]'),
        scanlines: html.html.includes('html[data-theme="matrix"] body::after')
      }
    };
  });

  expectMatrixPixel(result.promo);
  expectMatrixPixel(result.poster);
  expectMatrixPixel(result.footprint);
  expect(result.html).toEqual({ initial: true, palette: true, cycle: true, scanlines: true });
});
