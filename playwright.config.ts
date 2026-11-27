import { defineConfig, devices } from '@playwright/test';

const PORT = 5199;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  testIgnore: ['offline*Exports.spec.ts', 'memoryMatrix.spec.ts', 'stress.spec.ts'],
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    locale: 'zh-CN',
    viewport: { width: 430, height: 932 },
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 430, height: 932 },
      permissions: ['camera'],
      launchOptions: {
        args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
      }
    }
  }],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
