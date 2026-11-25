import { test, expect } from '@playwright/test';
import { blockExternal, gotoTab, openDemo } from './utils';

test('a distant re-walk opens explicit map navigation and resumes local guidance on arrival', async ({ page }) => {
  let tripId: string | null = null;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition(success: any) {
          queueMicrotask(() => success({
            coords: { latitude: 27.993, longitude: 120.699, accuracy: 8, heading: 0 },
            timestamp: Date.now()
          }));
          return 1;
        },
        getCurrentPosition(success: any) {
          queueMicrotask(() => success({
            coords: { latitude: 27.993, longitude: 120.699, accuracy: 8, heading: 0 },
            timestamp: Date.now()
          }));
        },
        clearWatch() {}
      }
    });
  });
  await blockExternal(page);
  await openDemo(page);
  try {
    tripId = await page.evaluate(async () => {
      const trip = await window.__lt.store.createTrip({
        name: '杭州跨城重走回归', activity: 'hike', status: 'finished', createdAt: Date.now()
      });
      const segment = await window.__lt.store.addSegment(trip.id);
      await window.__lt.store.appendPoints(segment.id, trip.id, [
        { lat: 30.25, lon: 120.15, t: Date.now() - 20_000 },
        { lat: 30.251, lon: 120.151, t: Date.now() - 10_000 },
        { lat: 30.252, lon: 120.152, t: Date.now() }
      ]);
      return trip.id;
    });

    await gotoTab(page, 'trips');
    await page.locator('.trip-detail-back').click();
    const tripItem = page.locator('.trip-item').filter({ hasText: '杭州跨城重走回归' });
    await tripItem.click();
    await page.locator('#trip-detail').getByRole('button', { name: '重走行程' }).click();
    await page.locator('.sheet-row').filter({ hasText: '起点 → 终点' }).click();
    await expect(page.locator('.rewalk-card')).toBeVisible();
    await expect(page.locator('.rw-phase')).toHaveText('前往目标');
    const navigate = page.getByRole('button', { name: '导航到起点' });
    await expect(navigate).toBeVisible();
    await page.evaluate(() => {
      (window as any).__openedNavigation = [];
      window.open = ((url: string) => {
        (window as any).__openedNavigation.push(url);
        return { opener: window };
      }) as typeof window.open;
    });

    await navigate.click();
    const dialog = page.locator('.modal-backdrop');
    await expect(dialog).toContainText('外部地图会获取你的当前位置');
    await expect(dialog).toContainText('不会上传实时轨迹');
    await dialog.getByRole('button', { name: '打开地图' }).click();
    await expect.poll(() => page.evaluate(() => window.__lt.rewalk.rewalk.externalNav)).toBe(true);
    const opened = await page.evaluate(() => (window as any).__openedNavigation[0] as string);
    expect(opened).toContain('https://uri.amap.com/navigation?');
    expect(new URL(opened).searchParams.get('mode')).toBe('car');
    await expect(page.locator('.rewalk-card')).toContainText('外部地图语音导航中');
    await expect(navigate).toBeHidden();

    await page.evaluate(() => window.__lt.rewalk.feedFix(30.25, 120.15, 5, 180));
    await expect.poll(() => page.evaluate(() => window.__lt.rewalk.rewalk.phase)).toBe('follow');
    await expect.poll(() => page.evaluate(() => window.__lt.rewalk.rewalk.externalNav)).toBe(false);
    await expect(page.locator('.rw-phase')).toHaveText('沿轨迹');
  } finally {
    await page.evaluate(() => window.__lt.rewalk.stopRewalk());
    if (tripId) await page.evaluate(async (id) => {
      await window.__lt.store.deleteTrip(id);
    }, tripId);
  }
});
