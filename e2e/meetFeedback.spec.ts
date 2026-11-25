import { test, expect } from '@playwright/test';
import { blockExternal, gotoTab } from './utils';

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
        self: { id: 'host', name: '发起人', isHost: true, color: '#f5b942', hasFix: true, lat: 31, lon: 121 },
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
        self: { id: 'host', name: '发起人', isHost: true, color: '#f5b942', hasFix: true, lat: 31, lon: 121 },
        peers: [{ id: 'member', name: '队员', isHost: false, color: '#2bcda7', hasFix: true, lat: 31, lon: 121.05, stale: false }]
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
        self: { id: 'host', name: '发起人', isHost: true, color: '#f5b942', hasFix: true, lat: 31, lon: 121 },
        peers: [{ id: 'member', name: '队员', isHost: false, color: '#2bcda7', hasFix: true, lat: 31.005, lon: 121, stale: false }]
      });
    });
    await expect.poll(() => map.evaluate(() => window.__lt.shell.getViews().meet.getMap().map.getZoom())).toBeGreaterThan(farZoom);
    await expect.poll(() => map.evaluate(() => window.__lt.shell.getViews().meet.getMap().map.isMoving())).toBe(false);
    const nearZoom = await map.evaluate(() => window.__lt.shell.getViews().meet.getMap().map.getZoom());
    expect(nearZoom).toBeGreaterThan(farZoom);
  } finally {
    await page.evaluate(() => window.__lt.meet.leave()).catch(() => {});
  }
});
