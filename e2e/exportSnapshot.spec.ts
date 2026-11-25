import { test, expect } from '@playwright/test';
import { blockExternal, gotoTripSection } from './utils';

const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

test('new node text and photo export without reselecting the trip and reach video cards', async ({ page }) => {
  await blockExternal(page);
  await page.goto('/?sim=1');
  await expect(page.locator('#view-record.active')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => window.__lt.recorder.rec.live?.pointCount || 0)).toBeGreaterThanOrEqual(2);

  const tripId = await page.evaluate(() => window.__lt.recorder.rec.tripId);
  await page.locator('.rec-btn.node').click();
  await page.locator('.sheet-row').filter({ hasText: '添加节点' }).click();
  const editor = page.locator('.modal-backdrop .modal');
  await expect(editor).toBeVisible();
  await editor.locator('.m-body input[type="text"]').fill('节点文字验收');
  await editor.locator('.m-body textarea').fill('节点描述验收');
  const chooser = page.waitForEvent('filechooser');
  await editor.getByRole('button', { name: '选择图片（可多选）', exact: true }).click();
  await (await chooser).setFiles({ name: 'export-node.png', mimeType: 'image/png', buffer: ONE_PX_PNG });
  await expect(editor.locator('.photo-strip .ph')).toHaveCount(1);
  await editor.locator('.m-foot .btn.primary').click();
  await expect(editor).toBeHidden();

  await expect.poll(() => page.evaluate(async (id) => {
    const waypoints = await window.__lt.store.db.waypoints.where('tripId').equals(id).toArray();
    const node = waypoints.find((wp: any) => wp.name === '节点文字验收');
    const media = node ? await window.__lt.store.db.media.bulkGet(node.mediaIds) : [];
    return { name: node?.name, desc: node?.desc, photos: media.filter(Boolean).length };
  }, tripId)).toEqual({ name: '节点文字验收', desc: '节点描述验收', photos: 1 });

  await page.locator('.rec-btn.stop').press('Enter');
  const result = page.locator('.record-result-sheet');
  await expect(result).toBeVisible();
  await result.locator('input[type="text"]').fill('节点文字验收行程');
  await result.locator('[data-result-action="analysis"]').click();
  await expect(page.locator('#view-trips.active')).toBeVisible();
  await expect(page.locator('#trip-detail.active')).toBeVisible();
  await expect(page.locator('.trip-detail-title')).toHaveText('节点文字验收行程');
  await expect(page.locator('.trip-detail-select')).toHaveValue(tripId!);

  await gotoTripSection(page, 'share');
  const exportView = page.locator('#view-export');
  await expect(exportView.locator('select').first()).toHaveValue(tripId!);
  await exportView.locator('.privacy-adjust').click();
  const radius = exportView.locator('input[type="number"]');
  await radius.fill('0');
  await radius.press('Tab');
  const privacyCard = exportView.locator('.card').filter({ hasText: '隐私脱敏' });
  await privacyCard.locator('.switch').last().click();

  const posterCard = exportView.locator('.card').filter({ hasText: '图片海报' });
  await posterCard.getByRole('button', { name: '生成', exact: true }).click();
  const poster = posterCard.locator('.poster-preview img');
  await expect(poster).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => poster.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1080);

  await page.evaluate(() => {
    const probe = { title: 0, desc: 0, photoDraws: 0 };
    (window as any).__exportDrawProbe = probe;
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (this.canvas.width === 1080 && this.canvas.height === 1920) {
        if (String(text).includes('节点文字验收')) probe.title++;
        if (String(text).includes('节点描述验收')) probe.desc++;
      }
      return maxWidth === undefined ? fillText.call(this, text, x, y) : fillText.call(this, text, x, y, maxWidth);
    };
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
      if (this.canvas.width === 1080 && this.canvas.height === 1920 && args.length === 9) probe.photoDraws++;
      return (drawImage as any).apply(this, args);
    };
  });

  const videoCard = exportView.locator('.card').filter({ hasText: '视频回顾' });
  await videoCard.locator('.seg-toggle button').first().click();
  await videoCard.getByRole('button', { name: '生成', exact: true }).click();
  await expect(videoCard.locator('video')).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__exportDrawProbe.title)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as any).__exportDrawProbe.desc)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as any).__exportDrawProbe.photoDraws)).toBeGreaterThan(0);
});
