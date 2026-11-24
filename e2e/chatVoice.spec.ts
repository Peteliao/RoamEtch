import { test, expect, type Page } from '@playwright/test';
import { createRelayServer } from '../relay/server.mjs';
import { blockExternal, configureWsRelay, gotoTab } from './utils';

async function openChat(page: Page) {
  await gotoTab(page, 'meet');
  await page.locator('.meet-chat-btn').click();
  await expect(page.locator('.meet-chat-modal')).toBeVisible();
}

async function ensureVoiceMode(page: Page) {
  if (await page.locator('.meet-chat-input').isVisible()) await page.locator('.meet-chat-mode').click();
  await expect(page.locator('.meet-chat-voice-btn')).toBeVisible();
  await expect(page.locator('.meet-chat-input')).toBeHidden();
}

async function holdVoice(page: Page, ms: number, cancel = false) {
  await ensureVoiceMode(page);
  const button = page.locator('.meet-chat-voice-btn');
  const box = await button.boundingBox();
  if (!box) throw new Error('voice button is not visible');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(button).toHaveClass(/is-recording/, { timeout: 10_000 });
  await page.waitForTimeout(ms);
  if (cancel) {
    await page.mouse.move(x, y - 120, { steps: 6 });
    await expect(page.locator('.meet-chat-recording')).toHaveClass(/is-cancel/);
  }
  await page.mouse.up();
}

test('team chat switches input modes and exchanges emoji and voice with a camera entry', async ({ page, browser, context }) => {
  const relay = createRelayServer({ port: 0, host: '127.0.0.1' });
  const address = await relay.listen();
  const url = `ws://127.0.0.1:${address.port}/room/{room}`;
  let peerContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    await context.grantPermissions(['microphone'], { origin: 'http://127.0.0.1:5199' });
    await blockExternal(page);
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => !!window.__lt)).toBe(true);
    await configureWsRelay(page, url);
    const invite = await page.evaluate(async () => {
      await window.__lt.meetCore.createMeetSession({ name: '语音发送方' });
      return window.__lt.meet.snapshot().invite as string;
    });
    await expect.poll(() => page.evaluate(() => window.__lt.meet.snapshot().relayState)).toBe('connected');

    peerContext = await browser.newContext({
      locale: 'zh-CN', viewport: { width: 430, height: 932 }, permissions: ['camera', 'microphone']
    });
    const peer = await peerContext.newPage();
    await blockExternal(peer);
    await peer.goto('/');
    await expect.poll(() => peer.evaluate(() => !!window.__lt)).toBe(true);
    await configureWsRelay(peer, url);
    await peer.evaluate(async (inviteCode) => {
      await window.__lt.meetCore.joinMeetSession(inviteCode, { name: '语音接收方' });
    }, invite);
    await expect.poll(() => peer.evaluate(() => window.__lt.meet.snapshot().relayState)).toBe('connected');
    await expect.poll(() => page.evaluate(() => window.__lt.meet.snapshot().peers.length)).toBe(1);

    await openChat(page);
    await openChat(peer);
    const input = page.locator('.meet-chat-input');
    const voiceButton = page.locator('.meet-chat-voice-btn');
    const modeButton = page.locator('.meet-chat-mode');
    await expect(input).toBeVisible();
    await expect(voiceButton).toBeHidden();
    await expect(modeButton).toHaveAttribute('aria-label', '按住说话');
    await modeButton.click();
    await expect(input).toBeHidden();
    await expect(voiceButton).toBeVisible();
    await expect(voiceButton).toContainText('按住说话');
    await expect(modeButton).toHaveAttribute('aria-label', '键盘输入');
    await modeButton.click();
    await expect(input).toBeVisible();
    await expect(voiceButton).toBeHidden();

    await modeButton.click();
    await page.getByRole('button', { name: '表情', exact: true }).click();
    await expect(page.locator('.meet-chat-emoji-panel')).toBeVisible();
    await expect(input).toBeVisible();
    await expect(voiceButton).toBeHidden();
    await page.getByRole('button', { name: '😂', exact: true }).click();
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(peer.locator('.mc-bubble.mc-emoji')).toHaveText('😂');

    const emojiBox = await page.locator('.meet-chat-emoji').boundingBox();
    const cameraBox = await page.locator('.meet-chat-cam').boundingBox();
    expect(emojiBox).toBeTruthy();
    expect(cameraBox).toBeTruthy();
    expect(cameraBox!.x).toBeGreaterThan(emojiBox!.x);
    await page.locator('.meet-chat-cam').click();
    await expect(page.locator('.cam-overlay')).toBeVisible();
    await expect(page.locator('.cam-title')).toContainText('拍摄并发送');
    await page.locator('.cam-close').click();
    await expect(page.locator('.cam-overlay')).toBeHidden();

    await holdVoice(page, 1300);
    await expect(page.locator('#toast-root')).toContainText('语音已发送', { timeout: 10_000 });
    await expect(page.locator('.mc-voice')).toHaveCount(1, { timeout: 10_000 });
    await expect(peer.locator('.mc-voice')).toHaveCount(1, { timeout: 10_000 });
    const duration = await peer.evaluate(() => window.__lt.meet.snapshot().messages.find((message: any) => message.voice)?.voice.duration);
    expect(duration).toBeGreaterThanOrEqual(500);

    const receivedVoice = peer.locator('.mc-voice').last();
    await receivedVoice.click();
    await expect(receivedVoice).toHaveClass(/is-playing/);
    await expect.poll(() => receivedVoice.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0);
    await receivedVoice.click();
    await expect(receivedVoice).not.toHaveClass(/is-playing/);

    const beforeCancel = await page.evaluate(() => window.__lt.meet.snapshot().messages.length);
    await holdVoice(page, 800, true);
    await expect(page.locator('#toast-root')).toContainText('已取消语音');
    expect(await page.evaluate(() => window.__lt.meet.snapshot().messages.length)).toBe(beforeCancel);
  } finally {
    await peerContext?.close();
    await page.evaluate(() => window.__lt.meet.leave()).catch(() => {});
    await relay.close();
  }
});
