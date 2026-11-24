import { test, expect, type Page } from '@playwright/test';
import { gotoTab } from './utils';

const enabled = process.env.MEET_PUBLIC_E2E === '1';

async function chatCounts(page: Page, text: string) {
  return page.evaluate((label) => {
    const messages = window.__lt.meet.snapshot().messages as any[];
    return {
      text: messages.filter((m) => m.text === label && !m.img).length,
      image: messages.filter((m) => m.img && m.text === '公共中继图片').length
    };
  }, text);
}

test.describe('public MQTT meetup', () => {
  test.skip(!enabled, 'set MEET_PUBLIC_E2E=1 to exercise public MQTT brokers');
  test.setTimeout(180_000);

  test('two clients exchange text and an encrypted image through public brokers', async ({ page, browser }) => {
    let peerContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
    try {
      await page.goto('/');
      await expect.poll(() => page.evaluate(() => !!window.__lt)).toBe(true);
      const invite = await page.evaluate(async () => {
        await window.__lt.meetCore.createMeetSession({ name: '公共中继甲' });
        return window.__lt.meet.snapshot().invite as string;
      });
      await expect.poll(() => page.evaluate(() => window.__lt.meet.snapshot().relayState), { timeout: 60_000 }).toBe('connected');

      peerContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 430, height: 932 } });
      const peer = await peerContext.newPage();
      await peer.goto('/');
      await expect.poll(() => peer.evaluate(() => !!window.__lt)).toBe(true);
      await peer.evaluate(async (code) => {
        await window.__lt.meetCore.joinMeetSession(code, { name: '公共中继乙' });
      }, invite);
      await expect.poll(() => peer.evaluate(() => window.__lt.meet.snapshot().relayState), { timeout: 60_000 }).toBe('connected');
      await expect.poll(() => page.evaluate(() => window.__lt.meet.snapshot().peers.length), { timeout: 60_000 }).toBe(1);

      // Let every reachable provider finish its handshake so both sides share a channel.
      await page.waitForTimeout(6000);

      await gotoTab(page, 'meet');
      await page.getByRole('button', { name: '组队聊天' }).click();
      const text = `公共中继文字验收-${Date.now()}`;
      await page.locator('.meet-chat-input').fill(text);
      await page.locator('.meet-chat-send').click();
      await expect(page.locator('.mc-bubble').filter({ hasText: text })).toBeVisible();

      await gotoTab(peer, 'meet');
      await peer.getByRole('button', { name: '组队聊天' }).click();
      await expect(peer.locator('.mc-bubble').filter({ hasText: text })).toBeVisible({ timeout: 30_000 });

      const base64 = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        const ctx = canvas.getContext('2d')!;
        const gradient = ctx.createLinearGradient(0, 0, 320, 240);
        gradient.addColorStop(0, '#18a999');
        gradient.addColorStop(1, '#0b3954');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 30px sans-serif';
        ctx.fillText('组队图片验收', 36, 130);
        return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
      });
      const sent = await page.evaluate((data) => window.__lt.meet.sendImage({
        base64: data, mime: 'image/jpeg', width: 320, height: 240,
        caption: '公共中继图片', lat: 31.23, lon: 121.47, acc: 10
      }), base64);
      expect(sent).toBe(true);
      await expect(page.locator('.mc-image img')).toBeVisible();
      await expect(peer.locator('.mc-image img')).toBeVisible({ timeout: 30_000 });

      await expect.poll(() => chatCounts(page, text)).toEqual({ text: 1, image: 1 });
      await expect.poll(() => chatCounts(peer, text)).toEqual({ text: 1, image: 1 });
    } finally {
      await peerContext?.close();
      await page.evaluate(() => window.__lt.meet.leave()).catch(() => {});
    }
  });
});
