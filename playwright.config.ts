import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  outputDir: '/tmp/seo-opt-playwright-results',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'off',
  },
  webServer: {
    command: 'node tests/fixtures/server.mjs',
    url: 'http://127.0.0.1:4173/healthy.html',
    reuseExistingServer: true,
    timeout: 10_000,
  },
});
