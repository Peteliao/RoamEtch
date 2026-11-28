import { test, expect } from '@playwright/test';
import { createRelayServer } from '../relay/server.mjs';
import { blockExternal, configureWsRelay, gotoTab } from './utils';

test('remote chat feedback and proximity map visuals work in the browser', async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as any;
    state.__chatOscillators = 0;
    class FakeAudioContext {
      state = 'running';
      currentTime = 0;
      destination = {};
      resume() { this.state = 'running'; return Promise.resolve(); }
      createOscillator() {
        state.__chatOscillators++;
        return {
          frequency: { setValueAtTime() {} }, connect() {}, disconnect() {},
          start() {}, stop() {}, onended: null
        };
      }
      createGain() {
        return {
          gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect() {}, disconnect() {}
        };
      }
    }
    state.AudioContext = FakeAudioContext;
    state.webkitAudioContext = FakeAudioContext;
  });
  await blockExternal(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => !!window.__lt)).toBe(true);
  try {
    await gotoTab(page, 'meet');
    await page.evaluate(async () => {
      const events = await import('/src/core/events.ts');
      events.emit('meet:state', { ...window.__lt.meet.snapshot(), active: true, self: null, peers: [], chatUnread: 1 });
    });
    await page.locator('.meet-panel').click({ position: { x: 30, y: 30 } });
    await page.evaluate(async () => {
      const events = await import('/src/core/events.ts');
      events.emit('meet:chat:received', { unread: 1, fromId: 'peer' });
    });
    await expect.poll(() => page.evaluate(() => (window as any).__chatOscillators)).toBe(2);
    await expect(page.locator('.meet-chat-btn')).toHaveClass(/chat-ping/);
    await expect(page.locator('.meet-chat-btn')).toHaveClass(/chat-notice/);
    await expect(page.locator('.region-chip .dot')).toHaveClass(/chat-alert/);

    const map = page.locator('#view-meet');
    await expect.poll(() => map.evaluate((node) => {
      const view = window.__lt.shell.getViews().meet;
      return !!view.getMap()?.map;
    })).toBe(true);

    await map.evaluate(async (node) => {
      const view = window.__lt.shell.getViews().meet;
      const track = view.getMap();
      track.setMeetData({
        self: { id: 'host', name: '发起人', isHost: true, color: '#f5b942', hasFix: true, lat: 31, lon: 121, networkStatus: 'online', positionStatus: 'fresh', lastFixAt: Date.now(), stale: false },
        peers: []
      });
      const fitted = new Promise<void>((resolve) => track.map.once('moveend', resolve));
      track.fitMeet();
      await fitted;
    });
    expect(await map.evaluate(() => window.__lt.shell.getViews().meet.getMap()._meetAutoZoomReady)).toBe(true);
    await page.locator('.meet-panel .mp-head').click();
    await expect.poll(() => map.evaluate(() => window.__lt.shell.getViews().meet.getMap().map.getPadding().bottom > 150)).toBe(true);
    const viewport = await map.evaluate(() => {
      const track = window.__lt.shell.getViews().meet.getMap();
      const point = track.map.project(track.posMarker.getLngLat());
      const mapRect = track.container.getBoundingClientRect();
      const panelRect = document.querySelector('.meet-panel').getBoundingClientRect();
      return {
        markerY: point.y,
        visibleCenterY: (mapRect.height - track.map.getPadding().bottom) / 2,
        measuredInset: mapRect.bottom - panelRect.top,
        padding: track.map.getPadding().bottom
      };
    });
    expect(Math.abs(viewport.markerY - viewport.visibleCenterY)).toBeLessThan(3);
    expect(Math.abs(viewport.measuredInset - viewport.padding)).toBeLessThan(2);

    await map.evaluate(() => {
      const track = window.__lt.shell.getViews().meet.getMap();
      track.setMeetData({
        self: { id: 'host', name: '发起人', isHost: true, color: '#f5b942', hasFix: true, lat: 31, lon: 121, networkStatus: 'online', positionStatus: 'fresh', lastFixAt: Date.now(), stale: false },
        peers: [{ id: 'member', name: '队员', isHost: false, color: '#2bcda7', hasFix: true, lat: 31, lon: 121.05, networkStatus: 'online', positionStatus: 'fresh', lastFixAt: Date.now(), stale: false }]
      });
    });
    await expect.poll(() => map.evaluate(() => Number.isFinite(window.__lt.shell.getViews().meet.getMap()._meetLastDistance))).toBe(true);
    await expect.poll(() => map.evaluate(() => window.__lt.shell.getViews().meet.getMap().map.isMoving())).toBe(false);
    const groupCenter = await map.evaluate(() => {
      const track = window.__lt.shell.getViews().meet.getMap();
      const markers = [track.posMarker, ...[...track.meetMarkers.values()].map((entry) => entry.marker)];
      const points = markers.map((marker) => track.map.project(marker.getLngLat()));
      const padding = track.map.getPadding();
      return {
        x: (Math.min(...points.map((point) => point.x)) + Math.max(...points.map((point) => point.x))) / 2,
        y: (Math.min(...points.map((point) => point.y)) + Math.max(...points.map((point) => point.y))) / 2,
        visibleX: (track.container.clientWidth - padding.left - padding.right) / 2 + padding.left,
        visibleY: (track.container.clientHeight - padding.bottom) / 2
      };
    });
    expect(Math.abs(groupCenter.x - groupCenter.visibleX)).toBeLessThan(3);
    expect(Math.abs(groupCenter.y - groupCenter.visibleY)).toBeLessThan(3);
    const farZoom = await map.evaluate(() => window.__lt.shell.getViews().meet.getMap().map.getZoom());
    const farScale = await map.evaluate(() => Number(getComputedStyle(window.__lt.shell.getViews().meet.getMap().container).getPropertyValue('--map-marker-scale')));
    const colors = await map.evaluate(() => {
      const track = window.__lt.shell.getViews().meet.getMap();
      return {
        self: track.posMarker.getElement().style.getPropertyValue('--self-color'),
        peer: track.meetMarkers.get('member').node.style.getPropertyValue('--peer')
      };
    });
    expect(colors).toEqual({ self: '#f5b942', peer: '#2bcda7' });

    await map.evaluate(() => {
      const track = window.__lt.shell.getViews().meet.getMap();
      track.setMeetData({
        self: { id: 'host', name: '发起人', isHost: true, color: '#f5b942', hasFix: true, lat: 31, lon: 121, networkStatus: 'online', positionStatus: 'fresh', lastFixAt: Date.now(), stale: false },
        peers: [{ id: 'member', name: '队员', isHost: false, color: '#2bcda7', hasFix: true, lat: 31.005, lon: 121, networkStatus: 'online', positionStatus: 'fresh', lastFixAt: Date.now(), stale: false }]
      });
    });
    await expect.poll(() => map.evaluate(() => window.__lt.shell.getViews().meet.getMap().map.getZoom())).toBeGreaterThan(farZoom);
    await expect.poll(() => map.evaluate(() => window.__lt.shell.getViews().meet.getMap().map.isMoving())).toBe(false);
    const nearZoom = await map.evaluate(() => window.__lt.shell.getViews().meet.getMap().map.getZoom());
    const nearScale = await map.evaluate(() => Number(getComputedStyle(window.__lt.shell.getViews().meet.getMap().container).getPropertyValue('--map-marker-scale')));
    expect(nearZoom).toBeGreaterThan(farZoom);
    expect(nearScale).toBeGreaterThan(farScale);

    await map.evaluate(() => {
      const track = window.__lt.shell.getViews().meet.getMap();
      track.setMeetData({
        self: { id: 'host', name: '发起人', isHost: true, color: '#f5b942', hasFix: true, lat: 31, lon: 121, networkStatus: 'online', positionStatus: 'fresh', lastFixAt: Date.now(), stale: false },
        peers: [{ id: 'member', name: '队员', isHost: false, color: '#2bcda7', hasFix: true, lat: 31.03, lon: 121.03, networkStatus: 'online', positionStatus: 'fresh', lastFixAt: Date.now(), stale: false }]
      });
      track.fitMeet(70, true);
    });
    await page.waitForTimeout(1000);
    const fitted = await map.evaluate(() => {
      const track = window.__lt.shell.getViews().meet.getMap();
      const padding = track.map.getPadding();
      const markers = [track.posMarker, ...[...track.meetMarkers.values()].map((entry) => entry.marker)];
      const points = markers.map((marker) => track.map.project(marker.getLngLat()));
      return {
        inside: points.every((point) => point.x >= padding.left - 1 && point.x <= track.container.clientWidth - padding.right + 1
          && point.y >= padding.top - 1 && point.y <= track.container.clientHeight - padding.bottom + 1),
        points: points.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) }))
      };
    });
    expect(fitted.inside).toBe(true);
  } finally {
    await page.evaluate(() => window.__lt.meet.leave()).catch(() => {});
  }
});

test('host can cancel a rally-point picker and send a map-picked goal to a peer', async ({ page, browser }) => {
  const relay = createRelayServer({ port: 0, host: '127.0.0.1' });
  const address = await relay.listen();
  const url = `ws://127.0.0.1:${address.port}/room/{room}`;
  let peerContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    await blockExternal(page);
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation({ latitude: 31, longitude: 121, accuracy: 8 });
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => !!window.__lt)).toBe(true);
    await configureWsRelay(page, url);
    const invite = await page.evaluate(async () => {
      await window.__lt.meetCore.createMeetSession({ name: '发起人' });
      return window.__lt.meet.snapshot().invite as string;
    });
    await expect.poll(() => page.evaluate(() => window.__lt.meet.snapshot().relayState)).toBe('connected');
    peerContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 430, height: 932 } });
    const peer = await peerContext.newPage();
    await blockExternal(peer);
    await peer.goto('/');
    await expect.poll(() => peer.evaluate(() => !!window.__lt)).toBe(true);
    await configureWsRelay(peer, url);
    await peer.evaluate(async (code) => {
      await window.__lt.meetCore.joinMeetSession(code, { name: '队员' });
    }, invite);
    await expect.poll(() => page.evaluate(() => window.__lt.meet.snapshot().peers.length)).toBe(1);
    await gotoTab(page, 'meet');

    const goalButton = page.locator('.iconbtn[aria-label="集合点"]');
    await goalButton.click();
    const sheet = page.locator('.modal-backdrop').filter({ hasText: '集合点' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: '在地图上选择', exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(goalButton).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(() => window.__lt.shell.getViews().meet.getMap().mapPickMode)).toBe(true);
    await expect.poll(() => page.locator('#view-meet canvas').evaluate((canvas) => canvas.style.cursor)).toBe('crosshair');
    await goalButton.click();
    await expect(goalButton).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => page.evaluate(() => window.__lt.shell.getViews().meet.getMap().mapPickMode)).toBe(false);

    await goalButton.click();
    await sheet.locator('input[type="text"]').fill('地图集合点');
    await sheet.getByRole('button', { name: '在地图上选择', exact: true }).click();
    const mapBox = await page.locator('#view-meet').boundingBox();
    expect(mapBox).not.toBeNull();
    await page.mouse.click(mapBox!.x + mapBox!.width / 2, mapBox!.y + 180);
    await expect(goalButton).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => peer.evaluate(() => window.__lt.meet.snapshot().goal?.label), { timeout: 30_000 }).toBe('地图集合点');
    const goal = await peer.evaluate(() => window.__lt.meet.snapshot().goal);
    expect(Number.isFinite(goal.lat) && Number.isFinite(goal.lon)).toBe(true);
  } finally {
    await peerContext?.close();
    await page.evaluate(() => window.__lt.meet.leave()).catch(() => {});
    await relay.close();
  }
});
