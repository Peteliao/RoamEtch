import { test, expect, type Page } from '@playwright/test';
import qrcode from 'qrcode-generator';
import { blockExternal, gotoTab } from './utils';

function qrDataUrl(text: string) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(8, 4);
}

async function qrPngBuffer(page: Page, text: string) {
  const b64 = await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  }, qrDataUrl(text));
  return Buffer.from(b64, 'base64');
}

test('meetup join accepts a camera QR scan and an image QR scan', async ({ page }) => {
  await blockExternal(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => !!window.__lt)).toBe(true);
  await gotoTab(page, 'meet');
  await page.getByRole('button', { name: '加入组队', exact: true }).click();
  await expect(page.locator('.modal-backdrop .modal')).toBeVisible();
  const codeInp = page.locator('.modal-backdrop .m-body input[type="text"]').first();

  const cameraLink = await page.evaluate(() => {
    const invite = window.__lt.meetLink.generateMeetInvite();
    return window.__lt.meetLink.meetLinkFor(invite);
  });
  await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 720;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 720, 720);
    const draw = () => {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 720, 720);
      ctx.drawImage(img, 60, 60, 600, 600);
    };
    const media = navigator.mediaDevices;
    const original = media.getUserMedia.bind(media);
    const streams: MediaStream[] = [];
    media.getUserMedia = async () => {
      const stream = canvas.captureStream(8);
      streams.push(stream);
      let ticker = 0;
      const delay = setTimeout(() => {
        draw();
        ticker = window.setInterval(draw, 300);
      }, 1000);
      for (const track of stream.getTracks()) track.addEventListener('ended', () => {
        clearTimeout(delay);
        clearInterval(ticker);
      });
      return stream;
    };
    (window as any).__restoreMeetGum = () => {
      media.getUserMedia = original;
      for (const stream of streams) for (const track of stream.getTracks()) track.stop();
    };
  }, qrDataUrl(cameraLink));

  await page.getByRole('button', { name: '相机扫码', exact: true }).click();
  await expect(page.locator('.qr-scan-overlay')).toBeVisible();
  await expect(page.locator('.qr-scan-close')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => document.querySelector('.qr-scan-overlay')?.contains(document.activeElement))).toBe(true);
  await page.goBack();
  await expect(page.locator('.qr-scan-overlay')).toHaveCount(0);
  await expect(page.locator('.modal-backdrop .modal')).toBeVisible();
  await page.getByRole('button', { name: '相机扫码', exact: true }).click();
  await expect(page.locator('.qr-scan-overlay')).toBeVisible();
  await expect(codeInp).toHaveValue(cameraLink, { timeout: 20_000 });
  await expect(page.locator('.qr-scan-overlay')).toHaveCount(0);
  await page.evaluate(() => (window as any).__restoreMeetGum?.());

  const imageLink = await page.evaluate(() => {
    const invite = window.__lt.meetLink.generateMeetInvite();
    return window.__lt.meetLink.meetLinkFor(invite);
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '图片扫码', exact: true }).click();
  await (await chooser).setFiles({
    name: 'meet-invite.png',
    mimeType: 'image/png',
    buffer: await qrPngBuffer(page, imageLink)
  });
  await expect(codeInp).toHaveValue(imageLink);
  await expect(page.locator('.toast').filter({ hasText: '已识别组队邀请' }).first()).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.modal-backdrop')).toBeHidden();
});
