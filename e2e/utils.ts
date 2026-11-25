import { expect, type Page } from '@playwright/test';

export async function openDemo(page: Page) {
  await page.goto('/?demo=1');
  await expect(page.locator('#view-trips.active')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#trip-detail.active')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#view-analysis .stat-hero-item').first()).toBeVisible({ timeout: 30_000 });
}

export async function gotoTab(page: Page, tab: string) {
  const view = page.locator(`#view-${tab}.active`);
  if (!(await view.isVisible())) await page.locator(`.tabbar button[data-tab="${tab}"]`).click();
  await expect(view).toBeVisible();
}

export async function revealSettingsBlock(page: Page, block: ReturnType<Page['locator']>) {
  await block.locator('xpath=ancestor::details[contains(@class,"settings-collapse")]').evaluateAll((nodes) => {
    nodes.forEach((node) => { (node as HTMLDetailsElement).open = true; });
  });
  await expect(block).toBeVisible();
}

export async function openRecordingCamera(page: Page) {
  await page.locator('.rec-btn.node').click();
  await page.locator('.sheet-row').filter({ hasText: '拍照节点' }).click();
  await expect(page.locator('.cam-overlay')).toBeVisible();
}

export async function gotoTripSection(page: Page, section: 'overview' | 'data' | 'share') {
  await gotoTab(page, 'trips');
  const detail = page.locator('#trip-detail');
  if (!(await detail.getAttribute('class'))?.includes('active')) {
    await page.locator('.trip-item').first().click();
    await expect(detail).toHaveClass(/active/);
  }
  await detail.locator(`button[data-section="${section}"]`).click();
  await expect(page.locator(section === 'share' ? '#view-export' : '#view-analysis')).toHaveClass(/active/);
}

export async function configureWsRelay(page: Page, relayUrl: string) {
  await gotoTab(page, 'settings');
  const block = page.locator('.relay-settings-block').first();
  await revealSettingsBlock(page, block);
  await block.getByRole('button', { name: '自建 WS 中继', exact: true }).click();
  const input = block.locator('input[type="text"]');
  await input.fill(relayUrl);
  await input.press('Tab');
}

/** Abort remote tile/geocode traffic so tests do not depend on third-party latency. */
export async function blockExternal(page: Page) {
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1:5199') || url.startsWith('http://localhost:5199')) {
      return route.continue();
    }
    return route.abort();
  });
}
