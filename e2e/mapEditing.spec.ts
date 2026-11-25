import { test, expect } from '@playwright/test';
import { blockExternal, gotoTab, openDemo } from './utils';

test('editing is limited to a finished trip map view and supports undo redo', async ({ page }) => {
  let tripId: string | null = null;
  await blockExternal(page);
  await openDemo(page);
  try {
    tripId = await page.evaluate(async () => {
      const trip = await window.__lt.store.createTrip({
        name: '编辑模式回归行程', activity: 'hike', status: 'finished', createdAt: Date.now()
      });
      return trip.id;
    });

    await gotoTab(page, 'record');
    const editButton = page.locator('.iconbtn[aria-label="编辑模式"]');
    await expect(editButton).toBeDisabled();
    await expect(editButton).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.iconbtn[title="地图工具"]')).toHaveCount(0);
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);
    await expect(page.locator('.iconbtn[aria-label="撤销"]')).toBeHidden();
    await expect(page.locator('.iconbtn[aria-label="重做"]')).toBeHidden();
    expect(await page.locator('.map-tools .iconbtn').evaluateAll((nodes) => nodes.slice(-4).map((node) =>
      node.getAttribute('aria-label') || node.getAttribute('title')))).toEqual(['OLED 口袋锁', '编辑模式', '撤销', '重做']);

    await gotoTab(page, 'trips');
    await page.locator('.trip-detail-back').click();
    await expect(page.locator('#trip-detail')).toBeHidden();
    const tripItem = page.locator('.trip-item').filter({ hasText: '编辑模式回归行程' });
    await tripItem.click();
    await page.locator('#trip-detail').getByRole('button', { name: '在地图查看' }).click();
    await expect(page.locator('.view-trip-bar')).toBeVisible();
    await expect(editButton).toBeEnabled();
    await expect(editButton).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.iconbtn[aria-label="撤销"]')).toBeHidden();
    await editButton.click();
    await expect(editButton).toHaveAttribute('aria-pressed', 'true');
    await expect(editButton).toHaveClass(/active/);
    await expect(page.locator('.iconbtn[aria-label="撤销"]')).toBeVisible();
    await expect(page.locator('.iconbtn[aria-label="重做"]')).toBeVisible();
    await expect(page.locator('.iconbtn[aria-label="撤销"]')).toBeDisabled();
    await expect(page.locator('.iconbtn[aria-label="重做"]')).toBeDisabled();

    const mapBox = await page.locator('#map-container').boundingBox();
    expect(mapBox).not.toBeNull();
    await page.mouse.click(mapBox!.x + 150, mapBox!.y + 320);
    const waypointDialog = page.locator('.modal-backdrop').filter({ hasText: '添加节点' });
    await expect(waypointDialog).toBeVisible();
    await waypointDialog.locator('input').first().fill('撤销测试节点');
    await waypointDialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.iconbtn[aria-label="撤销"]')).toBeEnabled();
    const countWaypoints = () => page.evaluate(async (id) => {
      const points = await window.__lt.store.db.waypoints.toArray();
      return points.filter((point: any) => point.tripId === id).length;
    }, tripId);
    await expect.poll(countWaypoints).toBe(1);
    await expect.poll(() => page.evaluate(() => {
      const view = window.__lt.shell.getViews().record;
      return view.getMap().waypoints.filter((point: any) => point.name === '撤销测试节点').length;
    })).toBe(1);

    await page.locator('.iconbtn[aria-label="撤销"]').click();
    await expect.poll(countWaypoints).toBe(0);
    await expect(page.locator('.iconbtn[aria-label="重做"]')).toBeEnabled();
    await expect.poll(() => page.evaluate(() => window.__lt.shell.getViews().record.getMap().waypoints.length)).toBe(0);
    await page.locator('.iconbtn[aria-label="重做"]').click();
    await expect.poll(countWaypoints).toBe(1);
    await expect(page.locator('.iconbtn[aria-label="撤销"]')).toBeEnabled();

    await page.locator('.view-trip-bar button').click();
    await expect(page.locator('.view-trip-bar')).toBeHidden();
    await expect(page.locator('.iconbtn[aria-label="撤销"]')).toBeHidden();
    await expect(page.locator('.iconbtn[aria-label="重做"]')).toBeHidden();
    await expect(editButton).toBeDisabled();
    await expect(editButton).toHaveAttribute('aria-pressed', 'false');
  } finally {
    if (tripId) await page.evaluate(async (id) => {
      await window.__lt.store.deleteTrip(id);
    }, tripId);
  }
});
