import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 45000,
  expect: {
    timeout: 10000
  },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    viewport: { width: 1366, height: 768 },
    trace: 'retain-on-failure',
    screenshot: 'on'
  },
  webServer: [
    {
      command: 'npm --workspace=apps/api run dev',
      port: 4000,
      reuseExistingServer: false,
      timeout: 45000,
      env: {
        NODE_ENV: 'test',
        PLAYWRIGHT: 'true',
        DATABASE_URL: 'postgres://pharmacy_app:pharmacy_app_pass@localhost:5433/pharmacy_test'
      }
    },
    {
      command: 'npm --workspace=apps/web run dev',
      port: 3000,
      reuseExistingServer: false,
      timeout: 45000
    }
  ],
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1366, height: 768 }
      }
    }
  ]
});
