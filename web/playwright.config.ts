import { defineConfig } from '@playwright/test';

// HOHE_E2E_CHANNEL=chromium uses Playwright's own Chromium (CI); the default is installed Chrome.
const channel = process.env.HOHE_E2E_CHANNEL ?? 'chrome';

// Browser tests against the real Go server (e2e/harness.ts). They run serially: several
// tests stop, swap and restart the server on a fixed port.
//
// Browser: the installed Google Chrome (channel "chrome"), headless. These are automated
// Chromium results only; iPhone (Safari/WebKit) verification is a separate, physical check.
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    channel: channel === 'chromium' ? undefined : channel,
    headless: true,
    serviceWorkers: 'allow',
  },
});
