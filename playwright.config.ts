import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'test/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: 'http://127.0.0.1:4410',
    viewport: { width: 1440, height: 1100 },
    trace: 'retain-on-failure',
    launchOptions: {
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    },
  },
  webServer: {
    command: 'node --import tsx scripts/browser-server.ts',
    url: 'http://127.0.0.1:4410/health',
    reuseExistingServer: false,
  },
  reporter: 'list',
});
