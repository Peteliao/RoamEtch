import { test, expect, type Page } from '@playwright/test';
import { stat } from 'node:fs/promises';
import { createRelayServer } from '../relay/server.mjs';
import { blockExternal, configureWsRelay, gotoTab } from './utils';

function p2pSwitch(page: Page) {
  return page.locator('.setting-row').filter({ hasText: '原图点对点传输' }).locator('input[type="checkbox"]');
}

async function enableP2P(page: Page) {
  const toggle = p2pSwitch(page);
  await expect(toggle).not.toBeChecked();
  await toggle.locator('..').click();
  const notice = page.locator('.modal-backdrop');
  await expect(notice).toContainText('网络 IP');
  await notice.getByRole('button', { name: '同意并开启', exact: true }).click();
  await expect(toggle).toBeChecked();
}

async function disableP2P(page: Page) {
  const toggle = p2pSwitch(page);
  await expect(toggle).toBeChecked();
  await toggle.locator('..').click();
  await expect(toggle).not.toBeChecked();
}

async function openChat(page: Page) {
  await gotoTab(page, 'meet');
  await page.locator('.meet-chat-btn').click();
  await expect(page.locator('.meet-chat-modal')).toBeVisible();
}

async function closeChat(page: Page) {
  await page.locator('.meet-chat-modal').getByRole('button', { name: 'close', exact: true }).click();
  await expect(page.locator('.meet-chat-modal')).toBeHidden();
}

test('WebRTC transfers an HD original on demand and privacy refusal leaves chat usable', async ({ page, browser }) => {
  const relay = createRelayServer({ port: 0, host: '127.0.0.1' });
  const address = await relay.listen();
  const url = `ws://127.0.0.1:${address.port}/room/{room}`;
  let peerContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    await blockExternal(page);
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => !!window.__lt)).toBe(true);
    await configureWsRelay(page, url);
    await enableP2P(page);
    const invite = await page.evaluate(async () => {
      await window.__lt.meetCore.createMeetSession({ name: '原图发送方' });
      return window.__lt.meet.snapshot().invite as string;
    });
    await expect.poll(() => page.evaluate(() => window.__lt.meet.snapshot().relayState)).toBe('connected');

    peerContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 430, height: 932 } });
    const peer = await peerContext.newPage();
    await peer.addInitScript(() => {
      const w = window as any;
      w.__ltRtcCount = 0;
      const NativeRTC = window.RTCPeerConnection;
      if (NativeRTC) {
        window.RTCPeerConnection = class extends NativeRTC {
          constructor(configuration?: RTCConfiguration) {
            super(configuration);
            w.__ltRtcCount++;
          }
        } as typeof RTCPeerConnection;
      }
    });
    await blockExternal(peer);
    await peer.goto('/');
    await expect.poll(() => peer.evaluate(() => !!window.__lt)).toBe(true);
    await configureWsRelay(peer, url);
    await enableP2P(peer);
    await peer.evaluate(async (inviteCode) => {
      await window.__lt.meetCore.joinMeetSession(inviteCode, { name: '原图接收方' });
    }, invite);
    await expect.poll(() => peer.evaluate(() => window.__lt.meet.snapshot().relayState)).toBe('connected');
    await expect.poll(() => page.evaluate(() => window.__lt.meet.snapshot().peers.length)).toBe(1);

    await openChat(page);
    await openChat(peer);
    const sent = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext('2d')!;
      const pixels = ctx.createImageData(canvas.width, canvas.height);
      let seed = 0x12345678;
      for (let i = 0; i < pixels.data.length; i += 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pixels.data[i] = seed >>> 24;
        pixels.data[i + 1] = seed >>> 16;
        pixels.data[i + 2] = seed >>> 8;
        pixels.data[i + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0);
      const original = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/jpeg', 0.92));
      const thumb = document.createElement('canvas');
      thumb.width = 320;
      thumb.height = 180;
      thumb.getContext('2d')!.drawImage(canvas, 0, 0, thumb.width, thumb.height);
      const thumbnail = await new Promise<Blob>((resolve) => thumb.toBlob((blob) => resolve(blob!), 'image/jpeg', 0.72));
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.readAsDataURL(thumbnail);
      });
      const ok = await window.__lt.meetCore.sendMeetImage({
        base64, mime: 'image/jpeg', width: 320, height: 180,
        caption: 'WebRTC 原图验收', lat: 31.23, lon: 121.47, acc: 8,
        original, originalMime: 'image/jpeg', originalWidth: 1280, originalHeight: 720
      });
      const image = window.__lt.meet.snapshot().messages.find((message: any) => message.img?.fileId)?.img;
      return {
        ok,
        fileId: image?.fileId,
        sha256: image?.hdSha256,
        size: image?.hdSize,
        width: image?.hdWidth,
        height: image?.hdHeight
      };
    });
    expect(sent.ok).toBe(true);
    expect(sent.size).toBeGreaterThan(256 * 1024);
    expect(sent.width).toBe(1280);
    expect(sent.height).toBe(720);

    await expect(peer.locator('.mc-hd-badge')).toContainText('HD');
    await expect(peer.locator('.mc-caption')).toHaveText('WebRTC 原图验收');
    expect(await peer.evaluate(() => (window as any).__ltRtcCount)).toBe(0);
    const wrongHashCode = await peer.evaluate(({ peerId, fileId }) => window.__lt.meet.requestOriginal({
      peerId, fileId, sha256: '0'.repeat(64)
    }).then(() => '', (error: any) => error.code), {
      peerId: await peer.evaluate(() => window.__lt.meet.snapshot().peers[0].id),
      fileId: sent.fileId
    });
    expect(wrongHashCode).toBe('expired');
    expect(await peer.evaluate(() => (window as any).__ltRtcCount)).toBe(0);
    await peer.locator('.mc-original-action').click();
    await expect(peer.locator('.chat-image-viewer.is-original')).toBeVisible({ timeout: 30_000 });
    expect(await peer.evaluate(() => (window as any).__ltRtcCount)).toBe(1);

    const received = await peer.evaluate(async () => {
      const image = document.querySelector<HTMLImageElement>('.chat-image-viewer.is-original img')!;
      await image.decode();
      const blob = await fetch(image.src).then((response) => response.blob());
      const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      return {
        size: blob.size,
        width: image.naturalWidth,
        height: image.naturalHeight,
        sha256: [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      };
    });
    expect(received).toEqual({ size: sent.size, width: sent.width, height: sent.height, sha256: sent.sha256 });

    const downloadEvent = peer.waitForEvent('download');
    await peer.getByRole('button', { name: '保存原图', exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(`roametch-${sent.fileId}.jpg`);
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    expect((await stat(downloadPath!)).size).toBe(sent.size);

    await peer.locator('.modal-backdrop').filter({ has: peer.locator('.chat-image-viewer') })
      .getByRole('button', { name: 'close', exact: true }).click();
    await closeChat(peer);
    await closeChat(page);
    await expect.poll(() => page.evaluate(() => window.__lt.meet.imageCooldownLeft()), { timeout: 7_000 }).toBe(0);
    expect(await page.evaluate((previousFileId) => {
      const message = window.__lt.meet.snapshot().messages.find((entry: any) => entry.img?.fileId === previousFileId);
      const image = message.img;
      return window.__lt.meetCore.sendMeetImage({
        base64: image.data, mime: image.mime, width: image.width, height: image.height,
        caption: image.fileId ? '隐私拒绝验收' : message.text,
        lat: message.lat, lon: message.lon, acc: message.acc,
        original: window.__lt.meet.originalBlob(previousFileId),
        originalMime: image.hdMime, originalWidth: image.hdWidth, originalHeight: image.hdHeight
      });
    }, sent.fileId)).toBe(true);
    await gotoTab(page, 'settings');
    await disableP2P(page);
    await openChat(peer);
    await expect(peer.locator('.mc-hd-badge')).toHaveCount(2);
    const retry = peer.locator('.mc-original-action').last();
    await expect(retry).toContainText('加载原图');
    await retry.click();
    expect(await peer.evaluate(() => (window as any).__ltRtcCount)).toBe(1);
    await expect(peer.locator('.mc-original-status.error')).toHaveText('发送方未开启原图点对点传输');
    await expect(peer.locator('.chat-image-viewer')).toHaveCount(0);

    expect(await page.evaluate(() => window.__lt.meet.sendMessage('原图失败后聊天仍可用'))).toBe(true);
    await expect(peer.locator('.mc-bubble').filter({ hasText: '原图失败后聊天仍可用' })).toBeVisible();
  } finally {
    await peerContext?.close();
    await page.evaluate(() => window.__lt.meet.leave()).catch(() => {});
    await relay.close();
  }
});

test('invalid optional HD preparation still sends the encrypted thumbnail', async ({ page }) => {
  const relay = createRelayServer({ port: 0, host: '127.0.0.1' });
  const address = await relay.listen();
  try {
    await blockExternal(page);
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => !!window.__lt)).toBe(true);
    await configureWsRelay(page, `ws://127.0.0.1:${address.port}/room/{room}`);
    await enableP2P(page);
    await page.evaluate(async () => {
      await window.__lt.meetCore.createMeetSession({ name: '缩略图降级验收' });
    });
    await expect.poll(() => page.evaluate(() => window.__lt.meet.snapshot().relayState)).toBe('connected');
    const result = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      canvas.getContext('2d')!.fillRect(0, 0, 32, 32);
      const thumbnail = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/jpeg', 0.72));
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.readAsDataURL(thumbnail);
      });
      const ok = await window.__lt.meetCore.sendMeetImage({
        base64, mime: 'image/jpeg', width: 32, height: 32, caption: '原图失败仍发缩略图',
        original: new Blob(['not-an-image'], { type: 'image/jpeg' }),
        originalMime: 'image/jpeg', originalWidth: 32, originalHeight: 32
      });
      const image = window.__lt.meet.snapshot().messages.at(-1)?.img;
      return { ok, hasOriginal: !!image?.fileId, caption: window.__lt.meet.snapshot().messages.at(-1)?.text };
    });
    expect(result).toEqual({ ok: true, hasOriginal: false, caption: '原图失败仍发缩略图' });
  } finally {
    await page.evaluate(() => window.__lt.meet.leave()).catch(() => {});
    await relay.close();
  }
});

test('an original prepared across a room reset is never published into the new room', async ({ page }) => {
  const relay = createRelayServer({ port: 0, host: '127.0.0.1' });
  const address = await relay.listen();
  try {
    await blockExternal(page);
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => !!window.__lt)).toBe(true);
    await configureWsRelay(page, `ws://127.0.0.1:${address.port}/room/{room}`);
    await enableP2P(page);
    const invite = await page.evaluate(async () => {
      await window.__lt.meetCore.createMeetSession({ name: '换房竞态验收' });
      return window.__lt.meet.snapshot().invite as string;
    });
    await expect.poll(() => page.evaluate(() => window.__lt.meet.snapshot().relayState)).toBe('connected');
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      canvas.getContext('2d')!.fillRect(0, 0, 64, 64);
      const original = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/jpeg', 0.92));
      const thumbnail = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/jpeg', 0.72));
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.readAsDataURL(thumbnail);
      });
      const w = window as any;
      const nativeArrayBuffer = Blob.prototype.arrayBuffer;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      w.__delayedOriginal = original;
      w.__originalBlocked = false;
      w.__sendResult = null;
      Blob.prototype.arrayBuffer = function () {
        if (this === w.__delayedOriginal) {
          w.__originalBlocked = true;
          return gate.then(() => nativeArrayBuffer.call(this));
        }
        return nativeArrayBuffer.call(this);
      };
      w.__releaseOriginal = () => {
        Blob.prototype.arrayBuffer = nativeArrayBuffer;
        release();
      };
      void window.__lt.meetCore.sendMeetImage({
        base64, mime: 'image/jpeg', width: 64, height: 64, caption: '不得跨房发送',
        original, originalMime: 'image/jpeg', originalWidth: 64, originalHeight: 64
      }).then((result: boolean) => { w.__sendResult = result; });
    });
    await expect.poll(() => page.evaluate(() => (window as any).__originalBlocked)).toBe(true);
    const reset = await page.evaluate(() => window.__lt.meetCore.resetMeetCode());
    expect(reset.invite).not.toBe(invite);
    await page.evaluate(() => (window as any).__releaseOriginal());
    await expect.poll(() => page.evaluate(() => (window as any).__sendResult)).toBe(false);
    const after = await page.evaluate(() => ({
      invite: window.__lt.meet.snapshot().invite,
      messages: window.__lt.meet.snapshot().messages.length
    }));
    expect(after.invite).toBe(reset.invite);
    expect(after.messages).toBe(0);
  } finally {
    await page.evaluate(() => (window as any).__releaseOriginal?.()).catch(() => {});
    await page.evaluate(() => window.__lt.meet.leave()).catch(() => {});
    await relay.close();
  }
});

test('P2P settings keep the default off and persist custom STUN and TURN values', async ({ page }) => {
  await blockExternal(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => !!window.__lt)).toBe(true);
  await gotoTab(page, 'settings');
  await expect(p2pSwitch(page)).not.toBeChecked();

  const stun = page.locator('.field').filter({ hasText: 'STUN 地址' }).locator('textarea');
  await expect(stun).toHaveValue(/stun:stun\.miwifi\.com:3478/);
  await expect(stun).toHaveValue(/stun:stun\.chat\.bilibili\.com:3478/);
  await expect(stun).toHaveValue(/stun:stun\.cloudflare\.com:3478/);
  await stun.fill('stun:stun.example.com:3478\nstuns:stun.example.com:5349');
  await stun.press('Tab');

  const turn = page.locator('.field').filter({ hasText: 'TURN 地址' }).locator('textarea');
  await turn.fill('turn:turn.example.com:3478\nturns:turn.example.com:5349');
  await turn.press('Tab');
  const user = page.locator('.field').filter({ hasText: 'TURN 用户名' }).locator('input');
  await user.fill('localtrace-user');
  await user.press('Tab');
  const pass = page.locator('.field').filter({ hasText: 'TURN 密码' }).locator('input');
  await pass.fill('localtrace-pass');
  await pass.press('Tab');

  await page.reload();
  await expect.poll(() => page.evaluate(() => !!window.__lt)).toBe(true);
  await gotoTab(page, 'settings');
  await expect(p2pSwitch(page)).not.toBeChecked();
  await expect(stun).toHaveValue('stun:stun.example.com:3478\nstuns:stun.example.com:5349');
  await expect(turn).toHaveValue('turn:turn.example.com:3478\nturns:turn.example.com:5349');
  await expect(user).toHaveValue('localtrace-user');
  await expect(pass).toHaveValue('localtrace-pass');
});
