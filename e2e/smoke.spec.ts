import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { blockExternal, gotoTab, openDemo } from './utils';

test('demo trip renders charts and privacy crop feedback', async ({ page }) => {
  await blockExternal(page);
  await openDemo(page);

  const chartCard = page.locator('#view-analysis .chart-card');
  await expect(chartCard.locator('.chart-wrap canvas').first()).toBeVisible();

  const speedTab = chartCard.locator('.seg-toggle button', { hasText: '速度' });
  await speedTab.click();
  await expect(speedTab).toHaveClass(/active/);
  await expect(chartCard.locator('.chart-wrap canvas').first()).toBeVisible();

  await gotoTab(page, 'export');
  const radius = page.locator('#view-export input[type="number"]');
  await radius.fill('5000');
  await radius.press('Tab');
  await expect(page.locator('#view-export')).toContainText(/隐私圈隐藏 [1-9]\d* 个轨迹点/);
});

test('vector-only poster renders a preview at export resolution', async ({ page }) => {
  await blockExternal(page);
  await openDemo(page);
  await gotoTab(page, 'export');

  const privacyCard = page.locator('#view-export .card').filter({ hasText: '纯矢量模式' });
  await privacyCard.locator('.switch').last().click();

  const posterCard = page.locator('#view-export .card').filter({ hasText: '图片海报' });
  await posterCard.getByRole('button', { name: '生成' }).click();

  const preview = posterCard.locator('.poster-preview img');
  await expect(preview).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => preview.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1080);
  await expect(posterCard.locator('button[aria-label="下载海报"]')).toBeVisible();
});

test('text-only self-contained HTML export downloads without photos', async ({ page }) => {
  await blockExternal(page);
  await openDemo(page);
  await gotoTab(page, 'export');

  const card = page.locator('#view-export .card').filter({ hasText: '自包含网页' });
  await card.getByRole('button', { name: '纯文字（无照片）' }).click();

  const photos = card.locator('label.row input[type="checkbox"]');
  await expect(photos).toBeDisabled();
  await expect(photos).not.toBeChecked();
  await expect(card).toContainText(/预计约/);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    card.getByRole('button', { name: '自包含网页' }).click()
  ]);
  expect(download.suggestedFilename()).toMatch(/\.html$/);
  const path = await download.path();
  const html = readFileSync(path!, 'utf8');
  expect(html).toContain('<canvas');
  expect(html.length).toBeGreaterThan(20_000);
});

test('encrypted backup export, wipe and restore round-trip', async ({ page }) => {
  await blockExternal(page);
  await openDemo(page);
  expect(await page.evaluate(() => window.__lt.store.listTrips())).toHaveLength(1);

  await gotoTab(page, 'settings');
  await page.getByRole('button', { name: '整库备份' }).click();

  const modal = page.locator('.modal-backdrop .modal');
  await expect(modal).toContainText('导出整库备份');
  const passwords = modal.locator('input[type="password"]');
  await passwords.nth(0).fill('trackmint-e2e-1234');
  await passwords.nth(1).fill('trackmint-e2e-1234');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    modal.getByRole('button', { name: '开始导出' }).click()
  ]);
  expect(download.suggestedFilename()).toMatch(/\.trackmint\.enc$/);
  const backupPath = await download.path();
  expect(backupPath).toBeTruthy();

  await page.evaluate(() => window.__lt.store.eraseAll());
  expect(await page.evaluate(() => window.__lt.store.listTrips())).toHaveLength(0);

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '恢复备份' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(backupPath!);

  const unlock = page.locator('.modal-backdrop .modal').filter({ hasText: '输入备份密码' });
  await expect(unlock).toBeVisible();
  await unlock.locator('input[type="password"]').fill('trackmint-e2e-1234');
  await unlock.getByRole('button', { name: '解锁' }).click();

  const preview = page.locator('.modal-backdrop .modal').filter({ hasText: '恢复备份' });
  await expect(preview).toContainText('加密');
  await expect(preview).toContainText('SHA-256 校验通过');
  await preview.locator('.backup-snapshot input[type="checkbox"]').uncheck();
  await preview.locator('.m-foot').getByRole('button', { name: '恢复', exact: true }).click();

  await expect(page.locator('#toast-root .toast.ok').last()).toContainText(/已恢复 1 条行程/);
  expect(await page.evaluate(() => window.__lt.store.listTrips())).toHaveLength(1);
});
