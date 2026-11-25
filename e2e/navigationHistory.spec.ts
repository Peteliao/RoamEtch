import { test, expect } from '@playwright/test';
import { blockExternal, openDemo } from './utils';

test('browser back dismisses a modal without changing the underlying view', async ({ page }) => {
  await blockExternal(page);
  await page.goto('/?sim=1');
  await expect(page.locator('#view-record.active')).toBeVisible({ timeout: 30_000 });
  await page.locator('.map-layer-pill').click();
  await expect(page.locator('.modal-backdrop')).toBeVisible();
  await page.locator('.modal-backdrop .m-head .iconbtn').click();
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => history.state?.lt?.type)).toBe('view');
  await page.locator('.map-layer-pill').click();
  await expect(page.locator('.modal-backdrop')).toBeVisible();
  await page.goBack();
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  await expect(page.locator('#view-record.active')).toBeVisible();
});

test('browser back closes trip detail and restores it after viewing a trip on the map', async ({ page }) => {
  await blockExternal(page);
  await openDemo(page);
  await page.locator('.tabbar button[data-tab="trips"]').click();
  await expect(page.locator('#trip-detail')).not.toHaveClass(/active/);
  await page.locator('.trip-item').first().click();
  await expect(page.locator('#trip-detail')).toHaveClass(/active/);
  await page.locator('#trip-detail button[data-section="share"]').click();
  await expect(page.locator('#trip-detail')).toHaveAttribute('data-section', 'share');
  await page.goBack();
  await expect(page.locator('#trip-detail')).not.toHaveClass(/active/);
  await expect(page.locator('.trip-item').first()).toBeVisible();

  await page.locator('.trip-item').first().click();
  await expect(page.locator('#trip-detail')).toHaveClass(/active/);
  await page.locator('.trip-detail-actions').getByRole('button', { name: '在地图查看', exact: true }).click();
  await expect(page.locator('#view-record.active')).toBeVisible();
  await expect(page.locator('.vt-name')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#view-trips.active')).toBeVisible();
  await expect(page.locator('#trip-detail')).toHaveClass(/active/);
});

test('invalid trip intent never substitutes another active trip', async ({ page }) => {
  await blockExternal(page);
  await openDemo(page);
  const activeBefore = await page.locator('.trip-detail-select').inputValue();
  await page.evaluate(() => window.__lt.shell.navigate('trips', { detail: true, tripId: 'missing-trip', section: 'share' }));
  await expect(page.locator('#toast-root')).toContainText('未找到该行程');
  await expect(page.locator('.trip-detail-select')).toHaveValue(activeBefore!);
  await expect(page.locator('#trip-detail')).toHaveAttribute('data-section', 'overview');
});

test('developer tools require seven taps and team settings stay under Advanced', async ({ page }) => {
  await blockExternal(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => !!window.__lt)).toBe(true);
  await page.evaluate(() => window.__lt.shell.navigate('settings'));
  const version = page.locator('.about-version');
  for (let i = 0; i < 6; i++) await version.click();
  await expect(page.locator('.settings-debug')).toBeHidden();
  await version.click();
  await expect(page.locator('.settings-debug')).toBeVisible();
  const advanced = page.locator('details.settings-collapse').filter({ has: page.locator('.relay-settings-block') }).first();
  await expect(advanced).toContainText('组队');
});

test('normalized settings intent opens and highlights the relay block', async ({ page }) => {
  await blockExternal(page);
  await page.goto('/');
  await expect(page.locator('#view-record.active')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => window.__lt.shell.navigate('meet'));
  await page.locator('.meet-settings-link').click();
  await expect(page.locator('#view-settings.active')).toBeVisible();
  const relay = page.locator('.relay-settings-block').first();
  await expect(relay).toBeVisible();
  await expect(relay.locator('xpath=ancestor::details').first()).toHaveAttribute('open', '');
  await expect(relay.locator('xpath=ancestor::div[contains(@class,"card")]')).toHaveClass(/settings-focus/);
  await page.goBack();
  await expect(page.locator('#view-meet.active')).toBeVisible();
});
