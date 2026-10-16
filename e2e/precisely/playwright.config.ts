import { PlaywrightTestConfig } from '@playwright/test';
import path from 'path';

// The directory-sync list API (DEV-1206) reads Jackson's store through SQL views and needs
// an unencrypted Postgres store, while upstream's e2e environment encrypts it
// (DB_ENCRYPTION_KEY). This config runs e2e/precisely against its own server on another
// port, started without the key and on the database in PRECISELY_E2E_DB_URL, so it can
// run next to the main suite. It needs no browser and no mock-saml.
//
//   npm run build
//   PRECISELY_E2E_DB_URL=postgres://... npx playwright test -c e2e/precisely/playwright.config.ts
const port = 5226;
const dbURL = process.env.PRECISELY_E2E_DB_URL;

const config: PlaywrightTestConfig = {
  workers: 1,
  timeout: 120 * 1000,
  testDir: __dirname,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(__dirname, '../../playwright-report/precisely'), open: 'never' }],
  ],
  webServer: {
    command: 'node .next/standalone/server.js',
    cwd: path.join(__dirname, '../..'),
    port,
    timeout: 60 * 1000,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: String(port),
      NEXTAUTH_URL: `http://localhost:${port}`,
      DB_ENCRYPTION_KEY: '',
      ...(dbURL ? { DB_URL: dbURL } : {}),
    },
  },
  use: {
    baseURL: `http://localhost:${port}`,
  },
};

export default config;
