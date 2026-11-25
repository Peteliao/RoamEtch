import { test, expect } from '@playwright/test';
import { blockExternal, openDemo } from './utils';

test.use({
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true
});

test('iOS browser shows a closable storage eviction warning', async ({ page }) => {
  await blockExternal(page);
  await openDemo(page);
  const installGuide = page.locator('.modal-backdrop .modal').filter({ hasText: '把 RoamEtch迹刻放到手机桌面' });
  await expect(installGuide).toBeVisible();
  await installGuide.getByRole('button', { name: '知道了', exact: true }).click();
  await expect.poll(() => page.evaluate(() => history.state?.lt?.type)).toBe('view');
  await page.locator('.trip-detail-back').click();
  await expect(page.locator('#trip-detail')).toBeHidden();
  await expect.poll(() => page.evaluate(() => history.state?.lt?.detail)).toBe(false);

  const nudge = page.locator('.ios-storage-nudge');
  await expect(nudge).toBeVisible();
  await expect(nudge).toContainText('Safari 可能清理本地数据');
  await expect(nudge.getByRole('button', { name: '添加到主屏幕' })).toBeVisible();
  await expect(nudge.getByRole('button', { name: '立即备份' })).toBeVisible();

  await nudge.locator('.ios-nudge-close').click();
  await expect(nudge).toBeHidden();

  await page.reload();
  await expect(page.locator('#view-trips.active')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#trip-detail.active')).toBeVisible({ timeout: 30_000 });
  await page.locator('.trip-detail-back').click();
  await expect(page.locator('#trip-detail')).toBeHidden();
  await expect(page.locator('.ios-storage-nudge')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('roametch.iosStorageNudge.v1'))).toBeTruthy();
});
