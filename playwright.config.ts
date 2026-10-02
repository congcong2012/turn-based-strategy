import { defineConfig, devices } from '@playwright/test'

const DEV_URL = 'http://127.0.0.1:5173'
const PREVIEW_URL = 'http://127.0.0.1:4173'

/** CI 上：允许重试、不复用残留服务器、留下一份报告，方便回溯失败原因 */
const isCI = !!process.env.CI

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  // CI 的 runner 比开发机慢，且 headless WebGL（Pixi）偶发抖动 —— 给两次重试兜底
  retries: isCI ? 2 : 0,
  // 本地忘了删 .only 会静默少跑用例；CI 直接判失败
  forbidOnly: isCI,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'npx vite --port 5173 --strictPort',
      url: DEV_URL,
      // 本机习惯自己先起服务（Playwright 起 preview 会被本机代理挡住），所以复用；
      // CI 上一律由 Playwright 自己起，避免复用上一次中断留下的"半死"服务器
      reuseExistingServer: !isCI,
      timeout: 90_000,
    },
    {
      command: 'npx vite preview --port 4173 --strictPort',
      url: PREVIEW_URL,
      reuseExistingServer: !isCI,
      timeout: 90_000,
    },
  ],
  projects: [
    {
      name: 'local',
      testMatch: /(local|game|reconnect|multiplayer|connection-status|release|pve)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: DEV_URL },
    },
    {
      // 手动直连用真实 WebRTC（不走 local 传输），因此单独一个 project
      name: 'manual',
      testMatch: /manual-pair\.spec\.ts/,
      timeout: 180_000,
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
