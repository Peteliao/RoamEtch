import { test, expect } from '@playwright/test';
import { blockExternal, gotoTab, openDemo } from './utils';

test('finished trip map auto-fits the full track and manual overview restores it', async ({ page }) => {
  await blockExternal(page);
  await openDemo(page);
  await page.locator('#trip-detail').getByRole('button', { name: '在地图查看' }).click();
  await expect(page.locator('.view-trip-bar')).toBeVisible();
  const framing = () => page.evaluate(async () => {
    const { toDisplay } = await import('/src/core/coords.ts');
    const track = window.__lt.shell.getViews().record.getMap();
    const points = track.segments.flatMap((segment: any) => segment.points || [])
      .map((point: any) => track.map.project(toDisplay(point.lon, point.lat, track.coordSystem)));
    const padding = track.map.getPadding();
    const xs = points.map((point: any) => point.x);
    const ys = points.map((point: any) => point.y);
    const visibleW = track.container.clientWidth - padding.left - padding.right;
    const visibleH = track.container.clientHeight - padding.top - padding.bottom;
    return {
      count: points.length,
      inside: points.every((point: any) => point.x >= padding.left - 1
        && point.x <= track.container.clientWidth - padding.right + 1
        && point.y >= padding.top - 1
        && point.y <= track.container.clientHeight - padding.bottom + 1),
      fill: Math.max((Math.max(...xs) - Math.min(...xs)) / visibleW, (Math.max(...ys) - Math.min(...ys)) / visibleH)
    };
  });
  await expect.poll(() => page.evaluate(() => window.__lt.shell.getViews().record.getMap().map.isMoving())).toBe(false);
  const auto = await framing();
  expect(auto.count).toBeGreaterThan(1);
  expect(auto.inside).toBe(true);
  expect(auto.fill).toBeGreaterThan(0.6);

  await page.evaluate(() => window.__lt.shell.getViews().record.getMap().map.zoomIn({ duration: 0 }));
  await page.locator('#view-record .iconbtn[title="全览轨迹"]').click();
  await expect.poll(() => page.evaluate(() => window.__lt.shell.getViews().record.getMap().map.isMoving())).toBe(false);
  const manual = await framing();
  expect(manual.inside).toBe(true);
  expect(manual.fill).toBeGreaterThan(0.6);
});

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
