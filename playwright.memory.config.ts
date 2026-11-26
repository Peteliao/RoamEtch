import { defineConfig, devices } from '@playwright/test';

const PORT = 5201;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Synthetic Chromium regression baseline only. This deliberately excludes WebKit:
// CDP Performance metrics are not iOS hardware memory measurements.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'memoryMatrix.spec.ts',
  outputDir: 'test-results/memory/run',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/memory/memory-baseline.json' }]
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE_URL,
    viewport: { width: 430, height: 932 },
    locale: 'zh-CN',
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [{ name: 'chromium-memory', use: { browserName: 'chromium' } }],
  webServer: {
    command: `npm run preview -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
