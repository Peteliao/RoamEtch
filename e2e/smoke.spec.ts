import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { blockExternal, gotoTab, gotoTripSection, openDemo } from './utils';

test('RoamEtch record view starts directly without manual creation', async ({ page }) => {
  await blockExternal(page);
  await page.goto('/');
  await expect(page).toHaveTitle('RoamEtch迹刻 · 行程记录');
  await gotoTab(page, 'record');
  await expect(page.locator('#view-record .rec-pill.start')).toBeVisible();
  await expect(page.locator('#view-record .rec-pill.ghost')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '手动', exact: true })).toHaveCount(0);
});

test('promo preview lists 25 designs, advances and switches audiences', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await blockExternal(page);
  await page.goto('/');
  await gotoTab(page, 'settings');
  await page.getByRole('button', { name: '生成宣传图', exact: true }).click();
  const preview = page.locator('.promo-preview-img');
  const select = page.locator('.promo-variant-select');
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await expect(select.locator('option')).toHaveCount(25);
  const first = Number(await preview.getAttribute('data-variant'));
  await page.getByRole('button', { name: '换一张', exact: true }).click();
  await expect.poll(async () => Number(await preview.getAttribute('data-variant'))).toBe((first + 1) % 25);

  const previousSrc = await preview.getAttribute('src');
  await select.selectOption('8');
  await expect(preview).toHaveAttribute('data-variant', '8', { timeout: 30_000 });
  await expect(select).toHaveValue('8');
  expect(await preview.getAttribute('src')).not.toBe(previousSrc);
  const overflow = await page.locator('.modal-backdrop .modal').evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('demo trip renders charts and privacy crop feedback', async ({ page }) => {
  await blockExternal(page);
  await openDemo(page);

  const chartCard = page.locator('#view-analysis .chart-card');
  await expect(chartCard.locator('.chart-wrap canvas').first()).toBeVisible();

  const legend = chartCard.locator('.chart-legend');
  await expect(legend).toContainText('海拔');
  await expect(legend).toContainText('速度');
  const chartLayout = await chartCard.locator('.chart-wrap').evaluate((wrap) => {
    const plot = wrap.querySelector('.uplot') as HTMLElement;
    const rect = wrap.getBoundingClientRect();
    const plotRect = plot.getBoundingClientRect();
    return {
      wrapWidth: rect.width,
      plotWidth: plotRect.width,
      leftGap: plotRect.left - rect.left,
      rightGap: rect.right - plotRect.right,
      overflow: wrap.scrollWidth - wrap.clientWidth
    };
  });
  expect(chartLayout.wrapWidth).toBeGreaterThan(280);
  expect(chartLayout.plotWidth / chartLayout.wrapWidth).toBeGreaterThan(0.9);
  expect(chartLayout.leftGap).toBeLessThanOrEqual(1);
  expect(chartLayout.rightGap).toBeLessThanOrEqual(1);
  expect(chartLayout.overflow).toBeLessThanOrEqual(1);

  await gotoTripSection(page, 'share');
  await page.locator('#view-export .privacy-adjust').click();
  const radius = page.locator('#view-export input[type="number"]');
  await radius.fill('5000');
  await radius.press('Tab');
  await expect(page.locator('#view-export')).toContainText(/隐私圈隐藏 [1-9]\d* 个轨迹点/);
});

test('trip rows keep nested controls independent and deleting detail returns to the list', async ({ page }) => {
  await blockExternal(page);
  await openDemo(page);
  await page.locator('.trip-detail-back').click();
  await expect(page.locator('#trip-detail')).not.toHaveClass(/active/);

  const row = page.locator('.trip-item').first();
  const favorite = row.locator('.fav-toggle');
  await favorite.focus();
  await favorite.press('Space');
  await expect(favorite).toHaveClass(/active/);
  await expect(page.locator('#trip-detail')).not.toHaveClass(/active/);

  await row.click();
  await expect(page.locator('#trip-detail')).toHaveClass(/active/);
  await page.locator('.trip-detail-actions .danger').click();
  const confirmation = page.locator('.modal-backdrop .modal');
  await confirmation.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.locator('#trip-detail')).not.toHaveClass(/active/);
  await expect(page.locator('.trip-item')).toHaveCount(0);
  await expect(page.locator('#view-trips')).toContainText('还没有行程');
});

test('vector-only poster renders a preview at export resolution', async ({ page }) => {
  await blockExternal(page);
  await openDemo(page);
  await gotoTripSection(page, 'share');

  await page.locator('#view-export .privacy-adjust').click();
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
  await gotoTripSection(page, 'share');

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

test('shared-link imports stay deduplicated without localStorage cache', async ({ page }) => {
  await blockExternal(page);
  await openDemo(page);
  await page.locator('#trip-detail button[data-section="share"]').click();
  const link = await page.locator('.link-input').inputValue();
  expect(link).toContain('#t=');
  expect(await page.evaluate(() => window.__lt.store.listTrips())).toHaveLength(1);

  await page.evaluate(() => localStorage.clear());
  await page.goto(link);
  await expect(page.locator('#trip-detail.active')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => history.state?.lt?.type)).toBe('view');
  expect(await page.evaluate(() => window.__lt.store.listTrips())).toHaveLength(2);
  expect(await page.evaluate(() => window.__lt.store.db.shareImports.count())).toBe(1);

  await page.goto(link);
  await expect(page.locator('#trip-detail.active')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => history.state?.lt?.type)).toBe('view');
  expect(await page.evaluate(() => window.__lt.store.listTrips())).toHaveLength(2);
  expect(await page.evaluate(() => window.__lt.store.db.shareImports.count())).toBe(1);
});

test('requested pre-restore snapshot failure blocks restore', async ({ page }) => {
  await blockExternal(page);
  await openDemo(page);
  await gotoTab(page, 'settings');
  await page.getByRole('button', { name: '整库备份' }).click();
  const exportModal = page.locator('.modal-backdrop .modal');
  await exportModal.locator('input[type="checkbox"]').uncheck();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportModal.getByRole('button', { name: '开始导出' }).click()
  ]);
  const backupPath = await download.path();
  expect(backupPath).toBeTruthy();
  await page.evaluate(() => window.__lt.store.eraseAll());

  const restore = async () => {
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '恢复备份' }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles(backupPath!);
    const preview = page.locator('.modal-backdrop .modal').filter({ hasText: '恢复备份' });
    await expect(preview).toBeVisible();
    return preview;
  };

  await page.evaluate(() => {
    (window as any).__originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => 'MicroMessenger E2E' });
  });
  const blockedPreview = await restore();
  await blockedPreview.locator('.backup-snapshot-toggle').click();
  await blockedPreview.locator('.m-foot').getByRole('button', { name: '恢复', exact: true }).click();
  await expect(page.locator('#toast-root .toast.err').last()).toContainText('快照导出失败');
  expect(await page.evaluate(() => window.__lt.store.listTrips())).toHaveLength(0);

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => (window as any).__originalUserAgent });
  });
  const preview = await restore();
  await preview.locator('.m-foot').getByRole('button', { name: '恢复', exact: true }).click();
  await expect(page.locator('#toast-root .toast.ok').last()).toContainText(/已恢复 1 条行程/);
  expect(await page.evaluate(() => window.__lt.store.listTrips())).toHaveLength(1);
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
  await passwords.nth(0).fill('roametch-e2e-1234');
  await passwords.nth(1).fill('roametch-e2e-1234');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    modal.getByRole('button', { name: '开始导出' }).click()
  ]);
  expect(download.suggestedFilename()).toMatch(/\.roametch\.enc$/);
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
  await unlock.locator('input[type="password"]').fill('roametch-e2e-1234');
  await unlock.getByRole('button', { name: '解锁' }).click();

  const preview = page.locator('.modal-backdrop .modal').filter({ hasText: '恢复备份' });
  await expect(preview).toContainText('加密');
  await expect(preview).toContainText('SHA-256 校验通过');
  await expect(preview.locator('.backup-snapshot-toggle')).toHaveAttribute('aria-pressed', 'false');
  await preview.locator('.m-foot').getByRole('button', { name: '恢复', exact: true }).click();

  await expect(page.locator('#toast-root .toast.ok').last()).toContainText(/已恢复 1 条行程/);
  expect(await page.evaluate(() => window.__lt.store.listTrips())).toHaveLength(1);
});
