import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  use: {
    baseURL: process.env.TEST_BASE_URL || 'http://localhost:3000',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // Video is the most expensive artifact to capture. The self-heal loop
    // (testRunner.ts sets HEAL_RUN=1) re-runs the spec many times and never
    // watches the video, so skip it there; a manual run still records one.
    video: process.env.HEAL_RUN === '1' ? 'off' : 'retain-on-failure',
    // HEAL_HEADED=1 makes the authoritative verification run visible too.
    headless: process.env.HEAL_HEADED !== '1',
  },
  reporter: [['html', { open: 'never' }]],
});
