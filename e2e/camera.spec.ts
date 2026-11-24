import { test, expect, type Page } from '@playwright/test';
import { stat } from 'node:fs/promises';
import { createRelayServer } from '../relay/server.mjs';
import { blockExternal, configureWsRelay, gotoTab } from './utils';

const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

async function openSimRecord(page: Page) {
  await blockExternal(page);
  await page.goto('/?sim=1');
  await expect(page.locator('#view-record.active')).toBeVisible({ timeout: 30_000 });
}

async function openSimCamera(page: Page) {
  await openSimRecord(page);
  await page.locator('.rec-btn.camera').click();
  await expect(page.locator('.cam-overlay')).toBeVisible();
  await expect(page.locator('.cam-shutter')).toBeEnabled({ timeout: 20_000 });
}

async function installCameraFocusMock(page: Page, opts: { supported?: boolean; capabilities?: boolean } = {}) {
  await page.evaluate((options) => {
    const w = window as any;
    const state = w.__cameraFocusMock = {
      supported: options.supported ?? true,
      capabilities: options.capabilities ?? true,
      reject: false,
      confirm: true,
      calls: [] as any[],
      settings: { focusMode: 'continuous', pointsOfInterest: [] as Array<{ x: number; y: number }> }
    };
    Object.defineProperty(window.MediaStreamTrack, 'getSupportedConstraints', {
      configurable: true,
      value: () => state.supported ? { focusMode: true, pointsOfInterest: true } : { focusMode: false, pointsOfInterest: false }
    });
    const media = navigator.mediaDevices;
    const getUserMedia = media.getUserMedia.bind(media);
    media.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      for (const track of stream.getVideoTracks()) {
        const getSettings = track.getSettings.bind(track);
        track.getCapabilities = () => state.capabilities
          ? { focusMode: ['continuous', 'single-shot'], pointsOfInterest: true } as any
          : { focusMode: [], pointsOfInterest: false } as any;
        track.getSettings = () => ({
          ...getSettings(),
          focusMode: state.settings.focusMode,
          pointsOfInterest: state.settings.pointsOfInterest.map((point: { x: number; y: number }) => ({ ...point }))
        } as any);
        track.applyConstraints = async (constraints) => {
          const focus = constraints as any;
          state.calls.push({
            focusMode: focus.focusMode,
            pointsOfInterest: focus.pointsOfInterest?.map((point: { x: number; y: number }) => ({ ...point }))
          });
          if (state.reject) throw new DOMException('Focus unsupported', 'OverconstrainedError');
          if (state.confirm) {
            state.settings = {
              focusMode: focus.focusMode,
              pointsOfInterest: focus.pointsOfInterest.map((point: { x: number; y: number }) => ({ ...point }))
            };
          }
        };
      }
      return stream;
    };
  }, opts);
}

function jpegHeaderBuffer(width: number, height: number) {
  const bytes = Buffer.alloc(21);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  bytes[11] = 3;
  return bytes;
}

async function dragCameraRail(page: Page, distance: number) {
  const track = page.locator('.ps-cam-track');
  const box = await track.boundingBox();
  expect(box).toBeTruthy();
  const startX = box!.x + box!.width - 26;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX + distance, y, { steps: 8 });
  await page.mouse.up();
}

async function enterOledLock(page: Page) {
  await page.locator('.iconbtn[title="地图工具"]').click();
  await page.locator('.sheet-row').filter({ hasText: 'OLED 口袋锁' }).click();
  await expect(page.locator('#oled-dash.active')).toBeVisible();
  await expect(page.locator('.ps-cam-act')).toBeVisible();
}

test('camera tap maps cover-cropped coordinates and shows focus only after constraints apply', async ({ page }) => {
  await openSimRecord(page);
  await installCameraFocusMock(page);
  await page.locator('.rec-btn.camera').click();
  await expect(page.locator('.cam-shutter')).toBeEnabled({ timeout: 20_000 });

  const video = page.locator('.cam-video');
  const metrics = await video.evaluate((node) => {
    const rect = (node as HTMLVideoElement).getBoundingClientRect();
    return {
      left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      videoWidth: (node as HTMLVideoElement).videoWidth,
      videoHeight: (node as HTMLVideoElement).videoHeight
    };
  });
  const position = { x: Math.round(metrics.width * 0.75), y: Math.round(metrics.height * 0.58) };
  await video.click({ position });

  await expect(page.locator('.cam-focus-ring')).toBeVisible();
  await expect(page.locator('.cam-toast')).toBeVisible();
  await expect(page.locator('.cam-toast')).toContainText('已对焦');
  const result = await page.evaluate(() => {
    const state = (window as any).__cameraFocusMock;
    return { calls: state.calls, settings: state.settings };
  });
  expect(result.calls).toHaveLength(1);
  expect(result.calls[0].focusMode).toBe('continuous');
  const scale = Math.max(metrics.width / metrics.videoWidth, metrics.height / metrics.videoHeight);
  const renderedWidth = metrics.videoWidth * scale;
  const renderedHeight = metrics.videoHeight * scale;
  const expected = {
    x: (position.x - (metrics.width - renderedWidth) / 2) / renderedWidth,
    y: (position.y - (metrics.height - renderedHeight) / 2) / renderedHeight
  };
  expect(result.calls[0].pointsOfInterest).toHaveLength(1);
  expect(result.calls[0].pointsOfInterest[0].x).toBeCloseTo(expected.x, 5);
  expect(result.calls[0].pointsOfInterest[0].y).toBeCloseTo(expected.y, 5);
  expect(result.settings.pointsOfInterest[0].x).toBeCloseTo(expected.x, 5);
  expect(result.settings.pointsOfInterest[0].y).toBeCloseTo(expected.y, 5);

  await page.locator('.cam-shutter').click();
  await expect(page.locator('.cam-chip')).toContainText('已保存拍照节点 #1');
});

test('camera focus silently degrades when capabilities, constraints, or settings confirmation fail', async ({ page }) => {
  await openSimRecord(page);
  await installCameraFocusMock(page, { supported: false });
  await page.locator('.rec-btn.camera').click();
  await expect(page.locator('.cam-shutter')).toBeEnabled({ timeout: 20_000 });
  const video = page.locator('.cam-video');

  await video.click();
  await expect(page.locator('.cam-focus-ring')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__cameraFocusMock.calls.length)).toBe(0);

  await page.evaluate(() => {
    const state = (window as any).__cameraFocusMock;
    state.supported = true;
    state.capabilities = false;
  });
  await video.click();
  await expect(page.locator('.cam-focus-ring')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__cameraFocusMock.calls.length)).toBe(0);

  await page.evaluate(() => {
    const state = (window as any).__cameraFocusMock;
    state.capabilities = true;
    state.reject = true;
  });
  await video.click();
  await expect.poll(() => page.evaluate(() => (window as any).__cameraFocusMock.calls.length)).toBe(1);
  await expect(page.locator('.cam-focus-ring')).toBeHidden();
  await expect(page.locator('.cam-toast')).not.toHaveClass(/show/);

  await page.evaluate(() => {
    const state = (window as any).__cameraFocusMock;
    state.reject = false;
    state.confirm = false;
  });
  await video.click();
  await expect.poll(() => page.evaluate(() => (window as any).__cameraFocusMock.calls.length)).toBe(2);
  await expect(page.locator('.cam-focus-ring')).toBeHidden();
  await expect(page.locator('.cam-toast')).not.toHaveClass(/show/);
  await expect(page.locator('.cam-toast')).not.toContainText('已对焦');

  await page.locator('.cam-shutter').click();
  await expect(page.locator('.cam-chip')).toContainText('已保存拍照节点 #1');
});

test('quick camera saves a photo waypoint, supports undo and burst count', async ({ page }) => {
  await openSimCamera(page);
  await page.evaluate(() => window.__lt.keepalive.armKeepAlive(true));
  await expect.poll(() => page.evaluate(() => window.__lt.keepalive.isKeepAliveActive())).toBe(true);

  await page.locator('.cam-shutter').click();
  await expect(page.locator('.cam-chip')).toContainText('已保存拍照节点 #1');
  const saved = await page.evaluate(async () => {
    const tripId = window.__lt.recorder.rec.tripId;
    const waypoints = await window.__lt.store.db.waypoints.where('tripId').equals(tripId).toArray();
    const photos = waypoints.filter((w: any) => w.type === 'photo');
    const media = photos.length ? await window.__lt.store.db.media.bulkGet(photos[0].mediaIds) : [];
    return { photos, media, live: window.__lt.recorder.rec.live };
  });
  expect(saved.photos).toHaveLength(1);
  expect(saved.media).toHaveLength(1);
  expect(saved.media[0].width).toBeGreaterThan(0);
  const distanceM = Math.hypot(
    (saved.photos[0].lat - saved.live.lat) * 111_320,
    (saved.photos[0].lon - saved.live.lon) * 111_320 * Math.cos(saved.photos[0].lat * Math.PI / 180)
  );
  expect(distanceM).toBeLessThan(100);

  await page.locator('.cam-chip-undo').click();
  await expect(page.locator('.cam-chip')).toBeHidden();
  expect(await page.evaluate(async () => {
    const tripId = window.__lt.recorder.rec.tripId;
    return {
      photos: (await window.__lt.store.db.waypoints.where('tripId').equals(tripId).toArray()).filter((w: any) => w.type === 'photo').length,
      media: await window.__lt.store.db.media.count()
    };
  })).toEqual({ photos: 0, media: 0 });

  await page.locator('.cam-shutter').click();
  await expect(page.locator('.cam-chip')).toContainText('已保存拍照节点 #1');
  await expect(page.locator('.cam-close')).toContainText('完成 (1)');

  await page.evaluate(() => {
    const table = window.__lt.store.db.waypoints;
    (window as any).__ltOriginalWaypointDelete = table.delete;
    table.delete = async () => { throw new Error('forced undo failure'); };
  });
  await page.locator('.cam-chip-undo').click();
  await expect(page.locator('.cam-toast')).toContainText('撤销失败');
  expect(await page.evaluate(async () => {
    const tripId = window.__lt.recorder.rec.tripId;
    return {
      photos: (await window.__lt.store.db.waypoints.where('tripId').equals(tripId).toArray()).filter((w: any) => w.type === 'photo').length,
      media: await window.__lt.store.db.media.count()
    };
  })).toEqual({ photos: 1, media: 1 });
  await page.evaluate(() => {
    const table = window.__lt.store.db.waypoints;
    table.delete = (window as any).__ltOriginalWaypointDelete;
  });

  await page.evaluate(() => {
    const table = window.__lt.store.db.media;
    (window as any).__ltOriginalMediaAdd = table.add;
    table.add = async () => { throw new Error('forced save failure'); };
  });
  await page.locator('.cam-shutter').click();
  await expect(page.locator('.cam-toast')).toContainText('照片保存失败');
  expect(await page.evaluate(async () => {
    const tripId = window.__lt.recorder.rec.tripId;
    return {
      photos: (await window.__lt.store.db.waypoints.where('tripId').equals(tripId).toArray()).filter((w: any) => w.type === 'photo').length,
      media: await window.__lt.store.db.media.count()
    };
  })).toEqual({ photos: 1, media: 1 });
  await page.evaluate(() => {
    const table = window.__lt.store.db.media;
    table.add = (window as any).__ltOriginalMediaAdd;
  });

  await page.locator('.cam-close').click();
  await expect(page.locator('.cam-overlay')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__lt.keepalive.isKeepAliveActive())).toBe(true);
});

test('quick camera keeps every burst shot and exports the original capture', async ({ page }) => {
  await openSimCamera(page);
  await page.evaluate(() => {
    try { Object.defineProperty(navigator, 'canShare', { value: () => false, configurable: true }); } catch { /* ignore */ }
    try { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); } catch { /* ignore */ }
  });

  const originalDownload = page.waitForEvent('download');
  await page.locator('.cam-shutter').click();
  await expect(page.locator('.cam-chip')).toContainText('已保存拍照节点 #1');
  await expect(page.getByRole('button', { name: '存原图', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '存原图', exact: true }).click();
  const download = await originalDownload;
  expect(download.suggestedFilename()).toMatch(/^roametch-\d{8}-\d{6}\.jpg$/);
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  expect((await stat(downloadPath!)).size).toBeGreaterThan(0);

  await page.locator('.cam-shutter').click();
  await expect(page.locator('.cam-chip')).toContainText('已保存拍照节点 #2');
  await page.locator('.cam-shutter').click();
  await expect(page.locator('.cam-chip')).toContainText('已保存拍照节点 #3');
  await expect(page.locator('.cam-close')).toContainText('完成 (3)');

  const saved = await page.evaluate(async () => {
    const tripId = window.__lt.recorder.rec.tripId;
    const waypoints = await window.__lt.store.db.waypoints.where('tripId').equals(tripId).toArray();
    const photos = waypoints.filter((w: any) => w.type === 'photo');
    const media = await window.__lt.store.db.media.bulkGet(photos.flatMap((w: any) => w.mediaIds));
    return { photos: photos.length, media: media.filter(Boolean).length };
  });
  expect(saved).toEqual({ photos: 3, media: 3 });
  await page.locator('.cam-close').click();
  await expect(page.locator('.cam-overlay')).toBeHidden();
});

test('waypoint editor accepts multi-select photos and a burst from the camera', async ({ page }) => {
  await openSimCamera(page);
  await page.locator('.cam-close').click();
  await expect(page.locator('.cam-overlay')).toBeHidden();

  await page.locator('.rec-btn.node').click();
  await expect(page.locator('.modal-backdrop .modal')).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '选择图片（可多选）', exact: true }).click();
  await (await chooser).setFiles([
    { name: 'node-a.png', mimeType: 'image/png', buffer: ONE_PX_PNG },
    { name: 'node-b.png', mimeType: 'image/png', buffer: ONE_PX_PNG }
  ]);
  await expect(page.locator('.photo-strip .ph')).toHaveCount(2);

  await page.getByRole('button', { name: '拍照（可连拍）', exact: true }).click();
  await expect(page.locator('.cam-overlay')).toBeVisible();
  await expect(page.locator('.cam-shutter')).toBeEnabled({ timeout: 20_000 });
  await page.locator('.cam-shutter').click();
  await expect(page.locator('.cam-close')).toContainText('完成 (1)');
  await page.locator('.cam-shutter').click();
  await expect(page.locator('.cam-close')).toContainText('完成 (2)');
  await page.locator('.cam-close').click();
  await expect(page.locator('.photo-strip .ph')).toHaveCount(4);

  const nameInput = page.locator('.modal-backdrop .m-body input[type="text"]').first();
  await nameInput.fill('多图节点验收');
  await page.locator('.modal-backdrop .m-foot .btn.primary').click();
  await expect(page.locator('.modal-backdrop')).toBeHidden();

  const saved = await page.evaluate(async () => {
    const tripId = window.__lt.recorder.rec.tripId;
    const waypoints = await window.__lt.store.db.waypoints.where('tripId').equals(tripId).toArray();
    const wp = waypoints.find((w: any) => w.name === '多图节点验收');
    const media = wp ? await window.__lt.store.db.media.bulkGet(wp.mediaIds) : [];
    return { mediaIds: wp?.mediaIds?.length || 0, media: media.filter(Boolean).length };
  });
  expect(saved).toEqual({ mediaIds: 4, media: 4 });
});

test('closing during a pending photo save revokes the late thumbnail', async ({ page }) => {
  await openSimCamera(page);
  await page.evaluate(() => {
    const w = window as any;
    w.__urlsCreated = [];
    w.__urlsRevoked = [];
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob: Blob) => {
      const url = create(blob);
      w.__urlsCreated.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      w.__urlsRevoked.push(url);
      revoke(url);
    };
    w.__encodeStarted = false;
    w.__releaseEncode = null;
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      if (!w.__encodeStarted) {
        w.__encodeStarted = true;
        w.__releaseEncode = () => original.call(this, callback, type, quality);
      } else {
        original.call(this, callback, type, quality);
      }
    };
  });
  await page.locator('.cam-shutter').click();
  await expect.poll(() => page.evaluate(() => (window as any).__encodeStarted)).toBe(true);
  await page.locator('.cam-close').click();
  await expect(page.locator('.cam-overlay')).toBeHidden();
  await page.evaluate(() => (window as any).__releaseEncode());
  await expect.poll(() => page.evaluate(async () => {
    const tripId = window.__lt.recorder.rec.tripId;
    return (await window.__lt.store.db.waypoints.where('tripId').equals(tripId).toArray()).filter((w: any) => w.type === 'photo').length;
  })).toBe(1);
  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    return w.__urlsCreated.length > 0 && w.__urlsCreated.every((url: string) => w.__urlsRevoked.includes(url));
  })).toBe(true);
});

test('chat camera rejects oversized albums and sends only the latest encrypted preview', async ({ page, browser }) => {
  const relay = createRelayServer({ port: 0, host: '127.0.0.1' });
  const address = await relay.listen();
  const url = `ws://127.0.0.1:${address.port}/room/{room}`;
  let peerContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    await blockExternal(page);
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation({ latitude: 31.23, longitude: 121.47, accuracy: 8 });
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => !!window.__lt)).toBe(true);
    await configureWsRelay(page, url);
    const invite = await page.evaluate(async () => {
      await window.__lt.meetCore.createMeetSession({ name: '拍照验收' });
      return window.__lt.meet.snapshot().invite as string;
    });
    await expect.poll(() => page.evaluate(() => window.__lt.meet.snapshot().relayState)).toBe('connected');
    await expect.poll(() => page.evaluate(() => window.__lt.meet.snapshot().self?.hasFix)).toBe(true);

    peerContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 430, height: 932 } });
    const peer = await peerContext.newPage();
    await blockExternal(peer);
    await peer.goto('/');
    await expect.poll(() => peer.evaluate(() => !!window.__lt)).toBe(true);
    await configureWsRelay(peer, url);
    await peer.evaluate(async (inviteCode) => {
      await window.__lt.meetCore.joinMeetSession(inviteCode, { name: '队友验收' });
    }, invite);
    await expect.poll(() => peer.evaluate(() => window.__lt.meet.snapshot().relayState)).toBe('connected');
    await expect.poll(() => page.evaluate(() => window.__lt.meet.snapshot().peers.length)).toBe(1);

    await gotoTab(page, 'meet');
    await page.getByRole('button', { name: '组队聊天' }).click();
    await expect(page.locator('.meet-chat-modal')).toBeVisible();
    await page.locator('.meet-chat-input').fill('组队文字验收');
    await page.locator('.meet-chat-send').click();
    await expect(page.locator('.mc-bubble').filter({ hasText: '组队文字验收' })).toBeVisible();
    await page.locator('.meet-chat-cam').click();
    await expect(page.locator('.cam-shutter')).toBeEnabled({ timeout: 20_000 });
    await page.evaluate(() => {
      const w = window as any;
      w.__imageConstructed = 0;
      const OriginalImage = window.Image;
      window.Image = class extends OriginalImage {
        constructor() {
          super();
          w.__imageConstructed++;
        }
      };
    });
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '相册', exact: true }).click();
    await (await chooser).setFiles({
      name: 'oversized.jpg', mimeType: 'image/jpeg', buffer: jpegHeaderBuffer(20_000, 20_000)
    });
    await expect(page.locator('.cam-toast')).toContainText('图片过大或格式不支持');
    expect(await page.evaluate(() => (window as any).__imageConstructed)).toBe(0);

    await page.evaluate(() => {
      const w = window as any;
      const original = HTMLCanvasElement.prototype.toBlob;
      w.__toBlobCalls = 0;
      HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
        const call = ++w.__toBlobCalls;
        if (call <= 2) {
          const ctx = this.getContext('2d');
          ctx.fillStyle = call === 1 ? '#ff0000' : '#0000ff';
          ctx.fillRect(0, 0, this.width, this.height);
        }
        if (call === 1) setTimeout(() => original.call(this, callback, type, quality), 1200);
        else original.call(this, callback, type, quality);
      };
    });
    await page.evaluate(() => window.__lt.meet.injectFix({ lat: 32.34, lon: 113.45, acc: 7 }));
    await page.locator('.cam-shutter').click();
    await expect(page.locator('.cam-meta')).toContainText('正在为弱网压缩');
    await page.getByRole('button', { name: '重拍', exact: true }).click();
    await expect(page.locator('.cam-preview')).toBeHidden();
    await expect(page.locator('.cam-shutter')).toBeEnabled();
    await page.locator('.cam-shutter').click();
    await expect(page.locator('.cam-preview-actions').getByRole('button', { name: '发送', exact: true })).toBeEnabled({ timeout: 20_000 });
    await page.waitForTimeout(1400);
    await page.locator('.cam-caption').fill('山路实况');
    await page.locator('.cam-preview-actions').getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.cam-overlay')).toBeHidden();
    await expect(page.locator('.mc-image img')).toBeVisible();
    await expect(page.locator('.mc-image-lock')).toBeVisible();
    await expect(page.locator('.mc-caption')).toHaveText('山路实况');
    const sentPixel = await page.evaluate(async () => {
      const image = window.__lt.meet.snapshot().messages.find((m: any) => m.img);
      const img = new Image();
      img.src = `data:${image.img.mime};base64,${image.img.data}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return [...ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data];
    });
    expect(sentPixel[2]).toBeGreaterThan(sentPixel[0] + 50);

    await gotoTab(peer, 'meet');
    await peer.getByRole('button', { name: '组队聊天' }).click();
    await expect(peer.locator('.mc-bubble').filter({ hasText: '组队文字验收' })).toBeVisible();
    await expect(peer.locator('.mc-image img')).toBeVisible();
    await expect(peer.locator('.mc-image-lock')).toBeVisible();
    await expect(peer.locator('.mc-caption')).toHaveText('山路实况');
    const imageBytes = await peer.evaluate(() => {
      const image = window.__lt.meet.snapshot().messages.find((m: any) => m.img);
      return image ? atob(image.img.data).length : 0;
    });
    expect(imageBytes).toBeGreaterThan(0);
    expect(imageBytes).toBeLessThanOrEqual(56 * 1024);

    await peer.locator('.mc-image').click();
    await expect(peer.locator('.chat-image-viewer')).toContainText('山路实况');
    await expect(peer.locator('.chat-image-viewer')).toContainText('32.34000, 113.45000 (WGS-84)');
    await peer.getByRole('button', { name: '在地图定位拍摄点' }).click();
    await expect(peer.locator('.photo-ref-marker')).toBeVisible();
    await expect(peer.locator('.photo-ref-label')).toHaveText('拍摄点');

    await expect.poll(() => page.evaluate(() => window.__lt.meet.imageCooldownLeft()), { timeout: 7_000 }).toBe(0);
    const sends = await page.evaluate(async () => {
      const image = window.__lt.meet.snapshot().messages.find((m: any) => m.img);
      const payload = {
        base64: image.img.data, mime: image.img.mime,
        width: image.img.width, height: image.img.height,
        lat: image.lat, lon: image.lon, acc: image.acc
      };
      return Promise.all([
        window.__lt.meetCore.sendMeetImage(payload),
        window.__lt.meetCore.sendMeetImage(payload)
      ]);
    });
    expect(sends.filter(Boolean)).toHaveLength(1);
  } finally {
    await peerContext?.close();
    await page.evaluate(() => window.__lt.meet.leave()).catch(() => {});
    await relay.close();
  }
});

test('paused camera refreshes the fix at open and again at capture', async ({ page }) => {
  await blockExternal(page);
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 31.23, longitude: 121.47, accuracy: 8 });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => !!window.__lt)).toBe(true);
  await gotoTab(page, 'record');
  await page.locator('.rec-pill.start').click();
  await expect(page.locator('.rec-btn.pause')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__lt.recorder.rec.live?.lat != null)).toBe(true);
  await page.locator('.rec-btn.pause').click();
  await expect(page.locator('.rec-btn.resume')).toBeVisible();

  await page.evaluate(() => {
    window.__lt.recorder.rec.live.lat = 1;
    window.__lt.recorder.rec.live.lon = 2;
  });
  await page.context().setGeolocation({ latitude: 39.9, longitude: 116.4, accuracy: 6 });
  await page.locator('.rec-btn.camera').click();
  await expect(page.locator('.cam-shutter')).toBeEnabled({ timeout: 20_000 });
  await page.context().setGeolocation({ latitude: 40.01, longitude: 116.51, accuracy: 5 });
  await page.locator('.cam-shutter').click();
  await expect(page.locator('.cam-chip')).toContainText('已保存拍照节点 #1');
  const photo = await page.evaluate(async () => {
    const tripId = window.__lt.recorder.rec.tripId;
    return (await window.__lt.store.db.waypoints.where('tripId').equals(tripId).toArray()).find((w: any) => w.type === 'photo');
  });
  expect(photo.lat).toBeCloseTo(40.01, 5);
  expect(photo.lon).toBeCloseTo(116.51, 5);
  expect(await page.evaluate(() => window.__lt.recorder.rec.status)).toBe('paused');
  await page.locator('.cam-close').click();
});

test('OLED camera rail rejects taps and short drags, then saves and auto-relocks', async ({ page }) => {
  await openSimCamera(page);
  await page.locator('.cam-close').click();
  await enterOledLock(page);

  const unlockBox = await page.locator('.ps-unlock').boundingBox();
  const trackBox = await page.locator('.ps-cam-track').boundingBox();
  expect(unlockBox).toBeTruthy();
  expect(trackBox).toBeTruthy();
  expect(trackBox!.y).toBeGreaterThan(unlockBox!.y + unlockBox!.height - 1);

  await page.locator('.ps-cam-track').click();
  await expect(page.locator('.cam-overlay')).toBeHidden();
  await dragCameraRail(page, -60);
  await expect(page.locator('.cam-overlay')).toBeHidden();

  await dragCameraRail(page, -150);
  await expect(page.locator('.cam-overlay')).toBeVisible();
  await expect(page.locator('.cam-shutter')).toBeEnabled({ timeout: 20_000 });
  await page.locator('.cam-shutter').click();
  await expect(page.locator('.cam-lockcard')).toContainText('已保存 · 3 秒后自动黑屏锁定');
  await expect(page.locator('.cam-lockcard').getByRole('button', { name: '再拍一张' })).toBeVisible();
  await expect(page.locator('.cam-lockcard').getByRole('button', { name: '立即锁定' })).toBeVisible();
  await expect(page.locator('.cam-overlay')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('#oled-dash.active')).toBeVisible();

  await dragCameraRail(page, -150);
  await expect(page.locator('.cam-shutter')).toBeEnabled({ timeout: 20_000 });
  await expect(page.locator('.cam-overlay')).toBeHidden({ timeout: 25_000 });
  await expect(page.locator('#oled-dash.active')).toBeVisible();

  const photos = await page.evaluate(async () => {
    const tripId = window.__lt.recorder.rec.tripId;
    return (await window.__lt.store.db.waypoints.where('tripId').equals(tripId).toArray()).filter((w: any) => w.type === 'photo');
  });
  expect(photos).toHaveLength(1);
});
