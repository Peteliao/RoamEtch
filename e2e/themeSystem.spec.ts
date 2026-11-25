import { expect, test } from '@playwright/test';
import { blockExternal, gotoTab } from './utils';
import { THEME_DEFINITIONS } from '../src/core/themeRegistry';

const NEW_THEMES = ['neon', 'starship', 'aurora', 'amber', 'deepsea', 'vermilion', 'sakura', 'butterfly', 'pearl', 'rose'] as const;
const ALL_THEMES = ['dark', 'light', 'contrast', 'matrix', ...NEW_THEMES];
const REPRESENTATIVE = ['neon', 'starship', 'aurora', 'vermilion', 'sakura', 'butterfly', 'pearl', 'rose'];

test('all new themes restyle controls at runtime and restore safely after OLED lock', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await blockExternal(page);
  await page.goto('/?sim=1');
  await expect(page.locator('#view-record.active')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__lt.recorder.rec.status), { timeout: 30_000 }).toBe('recording');
  await gotoTab(page, 'settings');

  const toggle = page.locator('.theme-toggle');
  await expect(toggle.locator('button')).toHaveCount(15);
  await expect(toggle).toContainText('烈日');
  await expect(toggle).toContainText('霓虹');
  await expect(toggle).toContainText('星舰');
  await expect(toggle).toContainText('极光');
  await expect(toggle).toContainText('琥珀');
  await expect(toggle).toContainText('深海');
  await expect(toggle).toContainText('朱砂');
  await expect(toggle).toContainText('樱雾');
  await expect(toggle).toContainText('蝶梦');
  await expect(toggle).toContainText('珠光');
  await expect(toggle).toContainText('蔷薇');

  for (const id of NEW_THEMES) {
    const definition = THEME_DEFINITIONS[id];
    await toggle.getByRole('button', { name: definition.labels.zh, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', id);
    await gotoTab(page, 'record');
    const styles = await page.evaluate((expectedBg) => {
      const root = getComputedStyle(document.documentElement);
      const probe = document.createElement('span');
      probe.style.backgroundColor = expectedBg;
      document.body.append(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const before = getComputedStyle(document.querySelector('#app')!, '::before');
      const after = getComputedStyle(document.querySelector('#app')!, '::after');
      return {
        accent: root.getPropertyValue('--accent').trim(),
        bgElev: root.getPropertyValue('--bg-elev').trim(),
        expected,
        controlBg: getComputedStyle(document.querySelector('.maplibregl-ctrl-group')!).backgroundColor,
        attribVar: root.getPropertyValue('--map-attrib-bg').trim(),
        attribBg: getComputedStyle(document.querySelector('.maplibregl-ctrl-attrib')!).backgroundColor,
        beforeAnimation: before.animationName,
        afterAnimation: after.animationName,
        beforePointer: before.pointerEvents,
        afterPointer: after.pointerEvents
      };
    }, definition.ui.bgElev);
    expect(styles.accent).toBe(definition.palette.accent);
    expect(styles.bgElev).toBe(definition.ui.bgElev);
    expect(styles.controlBg).toBe(styles.expected);
    expect(styles.attribBg).not.toBe('rgba(0, 0, 0, 0)');
    expect(styles.attribVar).toBe(definition.ui.mapAttrib);
    expect(styles.beforeAnimation).toBe('none');
    expect(styles.afterAnimation).toBe('none');
    expect(styles.beforePointer).toBe('none');
    expect(styles.afterPointer).toBe('none');
    expect(await page.evaluate(() => (window as any).__lt.recorder.rec.status)).toBe('recording');
    await gotoTab(page, 'settings');
  }

  await toggle.getByRole('button', { name: '自动', exact: true }).click();
  const auto = await page.evaluate(() => (window as any).__lt.theme.themeInfo());
  expect(auto.mode).toBe('auto');
  expect(['light', 'dark']).toContain(auto.effective);
  await toggle.getByRole('button', { name: '朱砂', exact: true }).click();
  await gotoTab(page, 'record');
  await page.locator('.power-lock-entry').click();
  await expect(page.locator('#oled-dash.active')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', '');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('#app')!, '::before').display)).toBe('none');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('localtrace.settings.v1') || '{}').theme)).toBe('vermilion');
  await page.locator('.ps-unlock').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#oled-dash.active')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'vermilion');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#ede6da');
});

test('every theme reaches canvas artwork and the offline viewer; videos retain dimensions', async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await blockExternal(page);
  await page.goto('/?demo=1');
  await expect(page.locator('#trip-detail.active')).toBeVisible({ timeout: 30_000 });

  const result = await page.evaluate(async (input) => {
    const lt = (window as any).__lt;
    const trips = await lt.store.listTrips();
    const full = await lt.store.loadTripFull(trips[0].id);
    const { generatePromo } = await import('/src/core/promo.ts');
    const { generatePoster } = await import('/src/core/poster.ts');
    const { generateFootprintImage } = await import('/src/core/footprintShare.ts');
    const { generateTrackVideo } = await import('/src/core/trackVideo.ts');
    const { buildSelfContainedHTML } = await import('/src/core/htmlExport.ts');
    const { paintThemeBackground } = await import('/src/core/themeRegistry.ts');

    const sample = async (source: Blob | HTMLCanvasElement) => {
      const fullBitmap = await createImageBitmap(source);
      const dimensions = [fullBitmap.width, fullBitmap.height];
      fullBitmap.close();
      const bitmap = await createImageBitmap(source, 0, 0, 1, 1);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const pixel = Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
      bitmap.close();
      return { pixel, dimensions };
    };
    const backgroundHashes: Record<string, string> = {};
    for (const theme of input.all) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 96;
      paintThemeBackground(canvas.getContext('2d')!, 96, 96, theme);
      backgroundHashes[theme] = canvas.toDataURL();
    }

    const promos: Record<string, number[]> = {};
    const audiencePromos: Record<string, { pixel: number[]; dimensions: number[] }> = {};
    const posters: Record<string, { pixel: number[]; dimensions: number[] }> = {};
    const footprints: Record<string, { pixel: number[]; dimensions: number[] }> = {};
    for (const theme of input.all) {
      lt.theme.setThemeModeOverride(theme);
      const promo = await generatePromo(0);
      promos[theme] = (await sample(promo.blob)).pixel;
      const audiencePromo = await generatePromo(8);
      audiencePromos[theme] = await sample(audiencePromo.blob);
      if (input.representative.includes(theme)) {
        const poster = await generatePoster(full, { vectorOnly: true });
        const footprint = await generateFootprintImage({
          year: 2026, trips: 1, distance: 1200, ascent: 35, duration: 600, days: 1, cities: [],
          months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, trips: i === 0 ? 1 : 0, distance: i === 0 ? 1200 : 0, ascent: i === 0 ? 35 : 0, days: i === 0 ? 1 : 0 }))
        });
        posters[theme] = await sample(poster.canvas);
        footprints[theme] = await sample(footprint.blob);
      }
    }

    lt.theme.setThemeModeOverride('neon');
    const video = await generateTrackVideo(full, { vectorOnly: true, seconds: 0.25, music: 'dawn' });
    const html = await buildSelfContainedHTML(full, { includePhotos: false });
    const payload = JSON.parse(html.html.match(/window\.__TRIP__=(\{.*?\});<\/script>/)![1]);
    const neonCss = html.html.match(/html\[data-theme="neon"\][^{]*\{[^}]*\}/g)?.join('') || '';
    const starshipCss = html.html.match(/html\[data-theme="starship"\][^{]*\{[^}]*\}/g)?.join('') || '';
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    frame.srcdoc = html.html;
    const frameLoaded = new Promise<void>((resolve) => { frame.onload = () => resolve(); });
    document.body.append(frame);
    await frameLoaded;
    const viewerDoc = frame.contentDocument!;
    const viewerSeen = [viewerDoc.documentElement.getAttribute('data-theme')];
    let auroraAnimation = '';
    let auroraPointer = '';
    for (let i = 0; i < input.all.length; i++) {
      viewerDoc.getElementById('themeBtn')!.click();
      const current = viewerDoc.documentElement.getAttribute('data-theme')!;
      viewerSeen.push(current);
      if (current === 'aurora') {
        const effect = viewerDoc.defaultView!.getComputedStyle(viewerDoc.body, '::before');
        auroraAnimation = effect.animationName;
        auroraPointer = effect.pointerEvents;
      }
    }
    frame.remove();
    lt.theme.setThemeModeOverride(null);
    return {
      backgroundHashes, promos, audiencePromos, posters, footprints,
      video: { size: video.blob.size, width: video.width, height: video.height, mime: video.mime },
      html: {
        initial: html.html.includes('data-theme="neon"'),
        palettes: Object.keys(payload.palettes),
        css: Object.keys(payload.css),
        cycle: payload.themeCycle,
        neonAtmosphere: html.html.includes('html[data-theme="neon"] body::before'),
        neonCss,
        starshipCss,
        starshipAtmosphere: html.html.includes('html[data-theme="starship"] body::before'),
        sakura: html.html.includes('html[data-theme="sakura"] body::before'),
        butterfly: html.html.includes('html[data-theme="butterfly"] body::before'),
        pearl: html.html.includes('html[data-theme="pearl"] body::before'),
        rose: html.html.includes('html[data-theme="rose"] body::before'),
        aurora: html.html.includes('html[data-theme="aurora"] body::before'),
        seal: html.html.includes("content:'迹'"),
        viewerSeen, auroraAnimation, auroraPointer
      }
    };
  }, { all: ALL_THEMES, representative: REPRESENTATIVE });

  expect(new Set(Object.values(result.backgroundHashes)).size).toBe(ALL_THEMES.length);
  expect(new Set(Object.values(result.promos).map((pixel) => pixel.join(','))).size).toBe(ALL_THEMES.length);
  expect(new Set(Object.values(result.audiencePromos).map((sample) => sample.pixel.join(','))).size).toBe(ALL_THEMES.length);
  for (const theme of ALL_THEMES) expect(result.audiencePromos[theme].dimensions).toEqual([1080, 1350]);
  for (const theme of REPRESENTATIVE) {
    expect(result.posters[theme].dimensions).toEqual([1080, 1920]);
    expect(result.footprints[theme].dimensions).toEqual([1080, 1620]);
  }
  expect(new Set(REPRESENTATIVE.map((theme) => result.posters[theme].pixel.join(','))).size).toBe(REPRESENTATIVE.length);
  expect(new Set(REPRESENTATIVE.map((theme) => result.footprints[theme].pixel.join(','))).size).toBe(REPRESENTATIVE.length);
  expect(result.video.width).toBe(1080);
  expect(result.video.height).toBe(1920);
  expect(result.video.size).toBeGreaterThan(0);
  expect(result.video.mime).toMatch(/^video\//);
  expect(result.html.initial).toBe(true);
  expect(result.html.palettes).toEqual(ALL_THEMES);
  expect(result.html.css).toEqual(ALL_THEMES);
  expect(result.html.cycle).toEqual(ALL_THEMES);
  expect(result.html.neonAtmosphere).toBe(true);
  expect(result.html.neonCss).not.toContain('repeating-linear-gradient');
  expect(result.html.neonCss).not.toContain('background-size:48px');
  expect(result.html.starshipAtmosphere).toBe(true);
  expect(result.html.starshipCss).not.toContain('background-size:48px');
  expect(result.html.starshipCss).not.toContain('repeating-linear-gradient');
  expect(result.html.sakura).toBe(true);
  expect(result.html.butterfly).toBe(true);
  expect(result.html.pearl).toBe(true);
  expect(result.html.rose).toBe(true);
  expect(result.html.aurora).toBe(true);
  expect(result.html.seal).toBe(true);
  expect(result.html.viewerSeen).toEqual([
    'neon', 'starship', 'aurora', 'amber', 'deepsea', 'vermilion',
    'sakura', 'butterfly', 'pearl', 'rose', 'dark', 'light', 'contrast', 'matrix', 'neon'
  ]);
  expect(result.html.auroraAnimation).toBe('none');
  expect(result.html.auroraPointer).toBe('none');
});
