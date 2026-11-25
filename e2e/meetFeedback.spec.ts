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

    await map.evaluate(() => {
      const track = window.__lt.shell.getViews().meet.getMap();
      track.setMeetData({
        self: { id: 'host', name: '发起人', isHost: true, color: '#f5b942', hasFix: true, lat: 31, lon: 121 },
        peers: [{ id: 'member', name: '队员', isHost: false, color: '#2bcda7', hasFix: true, lat: 31, lon: 121.05, stale: false }]
      });
    });
    await expect.poll(() => map.evaluate(() => Number.isFinite(window.__lt.shell.getViews().meet.getMap()._meetLastDistance))).toBe(true);
    await expect.poll(() => map.evaluate(() => window.__lt.shell.getViews().meet.getMap().map.isMoving())).toBe(false);
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
