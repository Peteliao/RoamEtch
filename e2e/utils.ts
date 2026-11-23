import { expect, type Page } from '@playwright/test';

export async function openDemo(page: Page) {
  await page.goto('/?demo=1');
  await expect(page.locator('#view-analysis.active')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#view-analysis .stat-hero-item').first()).toBeVisible({ timeout: 30_000 });
}

export async function gotoTab(page: Page, tab: string) {
  await page.locator(`.tabbar button[data-tab="${tab}"]`).click();
  await expect(page.locator(`#view-${tab}.active`)).toBeVisible();
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
