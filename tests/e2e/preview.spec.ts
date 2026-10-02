/**
 * 生产构建验收：在 vite preview（dist 产物）上验证页面可用、子路径资源正常、无控制台错误。
 * 这条对应"构建产物可部署到 GitHub Pages"的验收项。
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { joinRoom, randomRoom, waitForHost } from './helpers'

async function boardBox(page: Page) {
  const canvas = page.locator('.board-host canvas')
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  if (!box) throw new Error('canvas 不可见')
  return box
}

/** 点击棋盘上的某个格子（真实鼠标事件） */
async function clickTile(page: Page, x: number, y: number): Promise<void> {
  const box = await boardBox(page)
  const point = await page.evaluate(
    ([tx, ty]) =>
      (globalThis as unknown as { __atBoard: { project: (x: number, y: number) => { x: number; y: number } } }).__atBoard.project(
        tx,
        ty,
      ),
    [x, y] as const,
  )
  await page.mouse.click(box.x + point.x, box.y + point.y)
}

function pveState(page: Page) {
  return page.evaluate(() =>
    (globalThis as unknown as { __atGame: { getState: () => unknown } }).__atGame.getState(),
  ) as Promise<{ phase: string; players: string[]; units: Array<{ owner: string }> }>
}

test.describe('生产构建（GitHub Pages 子路径）', () => {
  test('页面加载无错误，资源走相对 base', async ({ page }) => {
    const failures: string[] = []
    const consoleErrors: string[] = []
    page.on('requestfailed', (req) => failures.push(req.url()))
    page.on('response', (res) => {
      if (res.status() >= 400) failures.push(res.status() + ' ' + res.url())
    })
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    await page.goto('/')
    await expect(page.getByRole('heading', { name: /古代战棋/ })).toBeVisible()
    // 生产构建默认落在主页：三个入口 + 页脚版本号
    await expect(page.getByTestId('entry-online')).toBeVisible()
    await expect(page.getByTestId('entry-pve')).toBeVisible()
    await expect(page.getByTestId('entry-rules')).toBeVisible()
    await expect(page.getByTestId('version-line')).toContainText('v')
    await page.getByTestId('entry-online').click()
    await expect(page.getByTestId('join-panel')).toBeVisible()

    // 相对 base：静态资源路径以 ./ 开头，任意 GitHub Pages 子路径都能加载
    const scriptSrc = await page.locator('script[type=module]').first().getAttribute('src')
    expect(scriptSrc ?? '').toMatch(/^\.\//)

    expect(failures).toEqual([])
    expect(consoleErrors.filter((line) => !line.includes('favicon'))).toEqual([])
  })

  // 下面两条在生产构建上走 Trystero 的公共 MQTT 信令 —— 需要公网。
  // 打 @network 标记：从 CI 的阻塞门里排除（见 .github/workflows/deploy.yml 的 e2e job），
  // 单独以非阻塞步骤运行，这样公共信令抖动不会卡住上线。
  test('生产构建可以真的加入房间并成为房主', { tag: '@network' }, async ({ page }) => {
    const room = randomRoom()
    await page.goto('/?page=lobby')
    await joinRoom(page, room, '生产将军')
    await waitForHost(page)
    await expect(page.getByTestId('player-item')).toHaveCount(1)
  })

  test('生产构建不暴露 DEV 调试入口（?as= / ?transport=local 无效）', { tag: '@network' }, async ({ page }) => {
    await page.goto('/?transport=local&as=hacker&page=lobby')
    await expect(page.getByTestId('transport-label')).toHaveCount(0)
    const room = randomRoom()
    await joinRoom(page, room, '生产将军')
    // 即便 URL 指定了 as，也依然走 Trystero 并成为房主
    await waitForHost(page)
    await expect(page.getByTestId('transport-label')).toHaveCount(0)
  })

  test('生产构建可以离线开一局单人练习（不依赖任何网络）', async ({ page }) => {
    const requests: string[] = []
    page.on('request', (req) => requests.push(req.url()))

    // ?debug=1 是生产构建里也可用的调试开关（GameScreen 显式支持）
    await page.goto('/?debug=1')
    await page.getByTestId('entry-pve').click()
    await expect(page.getByTestId('pve-setup')).toBeVisible()
    await page.getByTestId('pve-start').click()

    await expect(page.getByTestId('phase-label')).toHaveText('部署')
    await expect(page.getByTestId('pve-badge')).toBeVisible()
    await expect(page.getByTestId('entry-online')).toHaveCount(0)

    // AI 已自动完成部署：开局后场上应立刻出现 AI 的部队（此时人类还没放兵）
    await expect
      .poll(async () => (await pveState(page)).units.length, { timeout: 10_000 })
      .toBeGreaterThan(0)
    const ownersAfterStart = (await pveState(page)).units.map((u) => u.owner)
    expect(new Set(ownersAfterStart).size).toBe(1)
    expect(ownersAfterStart).not.toContain('you')

    // 人类部署 1 个刀盾兵到己方（北侧）部署区 → 阵中同时有敌我两方部队
    await page.getByTestId('deploy-sword').click()
    await clickTile(page, 2, 0)
    await expect
      .poll(
        async () => new Set((await pveState(page)).units.map((u) => u.owner)).size,
        { timeout: 10_000 },
      )
      .toBe(2)

    const state = await pveState(page)
    expect(state.players).toHaveLength(2)

    // 纯离线：全程只应加载同源资源，不该有任何外部请求（信令/字体/CDN）
    const external = requests.filter((url) => {
      if (url.startsWith('data:')) return false
      if (url.includes('/favicon')) return false
      return !url.startsWith('http://127.0.0.1:4173')
    })
    expect(external).toEqual([])
  })
})
