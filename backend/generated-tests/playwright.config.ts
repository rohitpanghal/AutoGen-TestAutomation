import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  use: {
    baseURL: process.env.TEST_BASE_URL || 'http://localhost:3000',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    // HEAL_HEADED=1 makes the authoritative verification run visible too.
    headless: process.env.HEAL_HEADED !== '1',
  },
  reporter: [['html', { open: 'never' }]],
});
