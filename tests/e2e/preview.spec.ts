/**
 * 生产构建验收：在 vite preview（dist 产物）上验证页面可用、子路径资源正常、无控制台错误。
 * 这条对应"构建产物可部署到 GitHub Pages"的验收项。
 */
import { expect, test } from '@playwright/test'
import { joinRoom, randomRoom, waitForHost } from './helpers'

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
    await expect(page.getByTestId('join-panel')).toBeVisible()

    // 相对 base：静态资源路径以 ./ 开头，任意 GitHub Pages 子路径都能加载
    const scriptSrc = await page.locator('script[type=module]').first().getAttribute('src')
    expect(scriptSrc ?? '').toMatch(/^\.\//)

    expect(failures).toEqual([])
    expect(consoleErrors.filter((line) => !line.includes('favicon'))).toEqual([])
  })

  test('生产构建可以真的加入房间并成为房主', async ({ page }) => {
    const room = randomRoom()
    await page.goto('/')
    await joinRoom(page, room, '生产将军')
    await waitForHost(page)
    await expect(page.getByTestId('player-item')).toHaveCount(1)
  })

  test('生产构建不暴露 DEV 调试入口（?as= / ?transport=local 无效）', async ({ page }) => {
    await page.goto('/?transport=local&as=hacker')
    await expect(page.getByTestId('transport-label')).toHaveCount(0)
    const room = randomRoom()
    await joinRoom(page, room, '生产将军')
    // 即便 URL 指定了 as，也依然走 Trystero 并成为房主
    await waitForHost(page)
    await expect(page.getByTestId('transport-label')).toHaveCount(0)
  })
})
