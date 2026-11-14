import { defineConfig } from '@playwright/test';

/** Live demo only: each run changes one real ticket, so retries stay off. */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'staff-repair-demo.playwright.ts',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  outputDir: 'test-results/staff-demo',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report/staff-demo' }],
  ],
  use: {
    viewport: { width: 520, height: 900 },
    video: 'on',
    screenshot: 'only-on-failure',
  },
});
