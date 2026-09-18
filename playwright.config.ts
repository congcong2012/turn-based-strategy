import { defineConfig, devices } from '@playwright/test'

const DEV_URL = 'http://127.0.0.1:5173'
const PREVIEW_URL = 'http://127.0.0.1:4173'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  webServer: [
    {
      command: 'pnpm vite --port 5173 --strictPort',
      url: DEV_URL,
      reuseExistingServer: true,
      timeout: 90_000,
    },
    {
      command: 'pnpm vite preview --port 4173 --strictPort',
      url: PREVIEW_URL,
      reuseExistingServer: true,
      timeout: 90_000,
    },
  ],
  projects: [
    {
      name: 'local',
      testMatch: /(local|game|reconnect)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: DEV_URL },
    },
    {
      // 移动端：具体设备描述符在 tests/e2e/mobile.spec.ts 里用 test.use 覆盖
      name: 'mobile',
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: DEV_URL },
    },
    {
      name: 'p2p',
      testMatch: /p2p\.spec\.ts/,
      timeout: 120_000,
      use: { ...devices['Desktop Chrome'], baseURL: DEV_URL },
    },
    {
      name: 'preview',
      testMatch: /preview\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: PREVIEW_URL },
    },
  ],
})
