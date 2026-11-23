import { test, expect } from '@playwright/test';
import { blockExternal, gotoTab, openDemo } from './utils';

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
  await gotoTab(page, 'trips');

  const nudge = page.locator('.ios-storage-nudge');
  await expect(nudge).toBeVisible();
  await expect(nudge).toContainText('Safari 可能清理本地数据');
  await expect(nudge.getByRole('button', { name: '添加到主屏幕' })).toBeVisible();
  await expect(nudge.getByRole('button', { name: '立即备份' })).toBeVisible();

  await nudge.locator('.ios-nudge-close').click();
  await expect(nudge).toBeHidden();

  await page.reload();
  await expect(page.locator('#view-analysis.active')).toBeVisible({ timeout: 30_000 });
  await gotoTab(page, 'trips');
  await expect(page.locator('.ios-storage-nudge')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('trackmint.iosStorageNudge.v1'))).toBeTruthy();
});
