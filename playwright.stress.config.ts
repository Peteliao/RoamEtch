import { defineConfig, devices } from '@playwright/test';

const PORT = 5202;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Opt-in production-preview stress suite. The default e2e config ignores stress.spec.ts
// so a million-point import and accelerated eight-hour lifecycle do not enter routine runs.
// All time/geolocation/data are synthetic; Chromium CDP is not iOS device evidence.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'stress.spec.ts',
  outputDir: 'test-results/stress/run',
  preserveOutput: 'always',
  fullyParallel: false,
  workers: 1,
  timeout: 600_000,
  expect: { timeout: 30_000 },
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/stress/results.json' }]
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE_URL,
    viewport: { width: 430, height: 932 },
    locale: 'zh-CN',
    permissions: ['geolocation'],
    acceptDownloads: true,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [{ name: 'chromium-stress', use: { browserName: 'chromium' } }],
  webServer: {
    command: `npm run preview -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
