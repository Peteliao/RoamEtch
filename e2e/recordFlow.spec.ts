import { test, expect, type Page } from '@playwright/test';
import { blockExternal, gotoTab } from './utils';

async function openRecording(page: Page, minPoints = 2) {
  await blockExternal(page);
  await page.goto('/?sim=1');
  await expect(page.locator('#view-record.active')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => window.__lt.recorder.rec.live?.pointCount || 0)).toBeGreaterThanOrEqual(minPoints);
}

async function finishRecording(page: Page) {
  await page.locator('.rec-btn.stop').click();
  const result = page.locator('.record-result-sheet');
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  return result;
}

async function hold(page: Page, selector: string, duration = 1600) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`Missing gesture target: ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(duration);
  await page.mouse.up();
}

async function instrumentMap(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    const map = w.__lt.shell.getViews().record.getMap();
    const setTrackData = map.setTrackData.bind(map);
    const fitTrack = map.fitTrack.bind(map);
    w.__recordFinishedMap = map;
    w.__recordMapProbe = { setCalls: 0, fitCalls: 0, pointCount: 0 };
    map.setTrackData = (segments: any[], waypoints: any[]) => {
      w.__recordMapProbe.setCalls++;
      w.__recordMapProbe.pointCount = segments.reduce((sum: number, segment: any) => sum + segment.points.length, 0);
      return setTrackData(segments, waypoints);
    };
    map.fitTrack = (...args: any[]) => {
      w.__recordMapProbe.fitCalls++;
      return fitTrack(...args);
    };
  });
}

test('finished recording keeps its fitted track after Save and clears it only on explicit exit', async ({ page }) => {
  await openRecording(page);
  await instrumentMap(page);
  const result = await finishRecording(page);

  await expect(result).toHaveCount(1);
  await expect(result).toHaveAttribute('aria-modal', 'false');
  const input = result.locator('input[type="text"]');
  await expect(input).toHaveAttribute('maxlength', '60');
  expect(await input.getAttribute('autofocus')).toBeNull();
  expect(await input.evaluate((node) => document.activeElement === node)).toBe(false);
  await expect(result.locator('[data-result-action="analysis"]')).toBeVisible();
  await expect(result.locator('[data-result-action="export"]')).toBeVisible();
  await expect(result.locator('[data-result-action="done"]')).toBeVisible();

  await expect.poll(() => page.evaluate(() => (window as any).__recordMapProbe.pointCount)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as any).__recordMapProbe.fitCalls)).toBeGreaterThan(0);
  await expect(page.locator('.vt-name')).toContainText('正在查看');
  await expect(page.locator('#view-record.active')).toBeVisible();

  await result.locator('[data-result-action="done"]').click();
  await expect(result).toHaveCount(0);
  await expect(page.locator('.vt-name')).toBeVisible();
  const retained = await page.evaluate(() => {
    const w = window as any;
    const map = w.__lt.shell.getViews().record.getMap();
    return {
      sameMap: map === w.__recordFinishedMap,
      points: map.segments.reduce((sum: number, segment: any) => sum + segment.points.length, 0),
      liveMode: map.liveMode
    };
  });
  expect(retained.sameMap).toBe(true);
  expect(retained.points).toBeGreaterThan(0);
  expect(retained.liveMode).toBe(false);

  await page.locator('.vt-name').locator('..').getByRole('button', { name: '退出查看', exact: true }).click();
  await expect(page.locator('.vt-name')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__lt.shell.getViews().record.getMap().segments.length)).toBe(0);
});

test('browser back dismisses the result sheet and keeps the finished trip', async ({ page }) => {
  await openRecording(page);
  const tripId = await page.evaluate(() => window.__lt.recorder.rec.tripId);
  const result = await finishRecording(page);
  await page.goBack();
  await expect(result).toHaveCount(0);
  await expect(page.locator('#view-record.active')).toBeVisible();
  await expect(page.locator('.vt-name')).toBeVisible();
  expect(await page.evaluate(async (id) => (await window.__lt.store.db.trips.get(id))?.status, tripId)).toBe('finished');
});

test('inline rename failures keep the sheet and edited name, while duplicate closes share one save', async ({ page }) => {
  await openRecording(page);
  const tripId = await page.evaluate(() => window.__lt.recorder.rec.tripId);
  const result = await finishRecording(page);
  const input = result.locator('input[type="text"]');
  const originalName = await input.inputValue();

  await page.evaluate(() => {
    const w = window as any;
    const table = w.__lt.store.db.trips;
    const original = table.update;
    w.__renameProbe = { nameWrites: 0, failNext: true };
    w.__restoreTripUpdate = () => { table.update = original; };
    table.update = async (...args: any[]) => {
      if (args[1] && Object.prototype.hasOwnProperty.call(args[1], 'name')) {
        w.__renameProbe.nameWrites++;
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (w.__renameProbe.failNext) {
          w.__renameProbe.failNext = false;
          throw new Error('forced rename failure');
        }
      }
      return original.apply(table, args);
    };
  });

  await input.fill('  重命名验收  ');
  await page.evaluate(() => {
    const button = document.querySelector('[data-result-action="done"]') as HTMLButtonElement;
    button.click();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await expect(result.locator('[role="alert"]')).toContainText('名称保存失败');
  await expect(result).toBeVisible();
  await expect(input).toHaveValue('重命名验收');
  await expect(result.locator('[data-result-action="done"]')).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__renameProbe.nameWrites)).toBe(1);
  expect(await page.evaluate(async (id) => (await window.__lt.store.db.trips.get(id)).name, tripId)).toBe(originalName);

  await page.evaluate(() => {
    const button = document.querySelector('[data-result-action="done"]') as HTMLButtonElement;
    button.click();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await expect(result).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__renameProbe.nameWrites)).toBe(2);
  expect(await page.evaluate(async (id) => (await window.__lt.store.db.trips.get(id)).name, tripId)).toBe('重命名验收');
  await page.evaluate(() => (window as any).__restoreTripUpdate());
});

for (const [action, section] of [['analysis', 'overview'], ['export', 'share']] as const) {
  test(`${action} persists the inline name before injected navigation`, async ({ page }) => {
    await openRecording(page);
    const tripId = await page.evaluate(() => window.__lt.recorder.rec.tripId);
    const result = await finishRecording(page);
    const name = `${action === 'analysis' ? '分析' : '分享'}导航验收`;
    await result.locator('input[type="text"]').fill(name);
    await result.locator(`[data-result-action="${action}"]`).click();

    await expect(page.locator('#view-trips.active')).toBeVisible();
    await expect(page.locator('#trip-detail.active')).toBeVisible();
    await expect(page.locator('.trip-detail-select')).toHaveValue(tripId!);
    await expect(page.locator('.trip-detail-title')).toHaveText(name);
    await expect(page.locator('#trip-detail')).toHaveAttribute('data-section', section);
    await expect(result).toHaveCount(0);
    expect(await page.evaluate(async (id) => (await window.__lt.store.db.trips.get(id)).name, tripId)).toBe(name);
  });
}

test('pocket lock is passive, keeps recording, and restores the same paused map on hold unlock', async ({ page }) => {
  await openRecording(page);
  const entry = page.locator('.power-lock-entry');
  await expect(entry).toBeEnabled();
  await expect(entry).toHaveAttribute('aria-label', 'OLED 口袋锁');
  const box = await entry.boundingBox();
  expect(box?.width).toBe(44);
  expect(box?.height).toBe(44);
  const collapsedBefore = await page.locator('.lp-head').evaluate((node) => node.parentElement?.classList.contains('collapsed'));
  const before = await page.evaluate(() => {
    const map = window.__lt.shell.getViews().record.getMap();
    window.__pocketMap = map;
    return { status: window.__lt.recorder.rec.status, points: window.__lt.recorder.rec.live?.pointCount || 0 };
  });

  await entry.click();
  await expect(page.locator('#oled-dash.active')).toBeVisible();
  expect(await page.evaluate(() => {
    const map = window.__lt.shell.getViews().record.getMap();
    return map === (window as any).__pocketMap;
  })).toBe(true);
  expect(await page.evaluate(() => (window as any).__pocketMap._renderingPaused)).toBe(true);
  expect(await page.locator('.lp-head').evaluate((node) => node.parentElement?.classList.contains('collapsed'))).toBe(collapsedBefore);
  await expect(page.locator('.ps-lock-status')).toContainText('不会改变记录状态');
  await expect(page.locator('#oled-dash button')).toHaveCount(1);
  await expect(page.locator('#oled-dash .ps-unlock')).toHaveAttribute('type', 'button');
  await expect(page.locator('[data-oled-action]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__lt.recorder.rec.live?.pointCount || 0)).toBeGreaterThan(before.points);
  expect(await page.evaluate(() => window.__lt.recorder.rec.status)).toBe(before.status);

  await page.locator('.ps-unlock').click();
  await expect(page.locator('#oled-dash.active')).toBeVisible();
  await hold(page, '.ps-unlock');
  await expect(page.locator('#oled-dash.active')).toHaveCount(0);
  expect(await page.evaluate(() => {
    const map = window.__lt.shell.getViews().record.getMap();
    return map === (window as any).__pocketMap && !map.destroyed && !map._renderingPaused;
  })).toBe(true);
  expect(await page.evaluate(() => window.__lt.recorder.rec.status)).toBe('recording');

  const result = await finishRecording(page);
  expect(await page.evaluate(() => {
    const map = window.__lt.shell.getViews().record.getMap();
    return !!map && map === (window as any).__pocketMap && map.segments.some((segment: any) => segment.points.length > 0);
  })).toBe(true);
  await expect(page.locator('.vt-name')).toBeVisible();
  await result.locator('[data-result-action="done"]').click();
  await expect(result).toHaveCount(0);
  await expect(entry).toBeDisabled();

  await page.locator('.iconbtn[title="地图工具"]').click();
  const lockRow = page.locator('.sheet-row').filter({ hasText: 'OLED 口袋锁' });
  await expect(lockRow).toBeDisabled();
});

test('pocket lock unlock is keyboard accessible without adding recording controls', async ({ page }) => {
  await openRecording(page);
  await page.locator('.power-lock-entry').click();
  const unlock = page.locator('.ps-unlock');
  await expect(unlock).toBeVisible();
  expect(await unlock.evaluate((node) => node.tagName)).toBe('BUTTON');
  await unlock.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#oled-dash.active')).toHaveCount(0);
  expect(await page.evaluate(() => window.__lt.recorder.rec.status)).toBe('recording');
});

test('a regular click finishes, suggests a name, saves a rename, and restores Auto with Start', async ({ page }) => {
  await openRecording(page);
  const tripId = await page.evaluate(() => window.__lt.recorder.rec.tripId);
  const result = page.locator('.record-result-sheet');

  await page.locator('.rec-btn.stop').click();

  await expect(result).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => window.__lt.recorder.rec.status)).toBe('finished');
  const input = result.locator('input[type="text"]');
  const defaultName = await input.inputValue();
  expect(defaultName.trim()).not.toBe('');
  expect(await page.evaluate(async (id) => {
    const trip = await window.__lt.store.db.trips.get(id);
    return { status: trip?.status, name: trip?.name };
  }, tripId)).toEqual({ status: 'finished', name: defaultName });

  await input.fill('  点击结束验收行程  ');
  await result.getByRole('button', { name: '保存', exact: true }).click();
  await expect(result).toHaveCount(0);
  expect(await page.evaluate(async (id) => (await window.__lt.store.db.trips.get(id))?.name, tripId)).toBe('点击结束验收行程');

  await expect(page.locator('.rec-btn.node')).toBeHidden();
  await expect(page.locator('.rec-btn.pause')).toBeHidden();
  await expect(page.locator('.rec-btn.stop')).toBeHidden();
  await expect(page.locator('.rec-pill.start')).toBeVisible();
  const activity = page.locator('.rec-buttons select.rec-pill');
  await expect(activity).toBeVisible();
  await expect(activity).toHaveValue('auto');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('localtrace.settings.v1') || '{}').activity)).toBe('auto');
});

test('record keyboard shortcuts ignore repeats, interactive targets, other views, and overlays', async ({ page }) => {
  await openRecording(page);
  const pressBody = (init: KeyboardEventInit = {}) => page.evaluate((options) => {
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true, ...options });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  }, init);

  expect(await pressBody()).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__lt.recorder.rec.status)).toBe('paused');
  expect(await pressBody({ repeat: true })).toBe(false);
  expect(await page.evaluate(() => window.__lt.recorder.rec.status)).toBe('paused');

  await expect(page.locator('.rec-btn.resume')).toBeVisible();
  const interactivePrevented = await page.locator('.rec-btn.resume').evaluate((button) => {
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(interactivePrevented).toBe(false);
  expect(await page.evaluate(() => window.__lt.recorder.rec.status)).toBe('paused');
  const editablePrevented = await page.evaluate(() => {
    const select = document.querySelector('.live-act-select') as HTMLSelectElement;
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    select.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(editablePrevented).toBe(false);
  expect(await page.evaluate(() => window.__lt.recorder.rec.status)).toBe('paused');

  expect(await pressBody()).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__lt.recorder.rec.status)).toBe('recording');
  await page.locator('.iconbtn[title="地图工具"]').click();
  await expect(page.locator('.modal-backdrop')).toBeVisible();
  expect(await pressBody()).toBe(false);
  expect(await page.evaluate(() => window.__lt.recorder.rec.status)).toBe('recording');
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);

  await gotoTab(page, 'trips');
  expect(await pressBody()).toBe(false);
  expect(await page.evaluate(() => window.__lt.recorder.rec.status)).toBe('recording');
  await gotoTab(page, 'record');

  await page.locator('.rec-btn.node').click();
  await page.locator('.sheet-row').filter({ hasText: '拍照节点' }).click();
  await expect(page.locator('.cam-overlay')).toBeVisible();
  expect(await pressBody()).toBe(false);
  expect(await page.evaluate(() => window.__lt.recorder.rec.status)).toBe('recording');
  await page.locator('.cam-close').click();
  await expect(page.locator('.cam-overlay')).toHaveCount(0);

  await page.locator('.power-lock-entry').click();
  await expect(page.locator('#oled-dash.active')).toBeVisible();
  expect(await pressBody()).toBe(false);
  expect(await page.evaluate(() => window.__lt.recorder.rec.status)).toBe('recording');
});
