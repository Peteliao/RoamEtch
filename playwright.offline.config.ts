import { defineConfig, devices } from '@playwright/test';

const PORT = 5200;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: 'offline*.spec.ts',
  outputDir: 'test-results-offline',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    locale: 'zh-CN',
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  // Playwright WebKit cannot persist Blob/File values in IndexedDB; mobile Chromium covers binary backups.
  projects: [{
    name: 'webkit-iphone',
    testMatch: 'offlineExports.spec.ts',
    use: { ...devices['iPhone 13'], browserName: 'webkit' }
  }, {
    name: 'chromium-mobile-media',
    testMatch: 'offlineMediaExports.spec.ts',
    use: { ...devices['Pixel 7'], browserName: 'chromium' }
  }],
  webServer: {
    command: `npm run preview -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
