/**
 * M5 移动端 E2E（Pixel 5 视口 + 触摸）：
 *  - 手机布局可玩：大厅 → 对局 → 部署（真实触摸点击）→ 移动
 *  - 双指缩放能改变相机缩放（合成双指指针事件）
 * 注：缩放会改变取景，因此与点击类断言分开成两条用例，避免互相干扰。
 */
import { devices, expect, test } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { ROOM, joinRoom, localUrl, waitForHost } from './helpers'

test.use({ ...devices['Pixel 5'] })

async function tapTile(page: Page, x: number, y: number): Promise<void> {
  const canvas = page.locator('.board-host canvas')
  await expect(canvas).toBeVisible()
  const point = await page.evaluate(
    ([tx, ty]) => (globalThis as unknown as { __atBoard: { project: (x: number, y: number) => { x: number; y: number } } }).__atBoard.project(tx, ty),
    [x, y] as const,
  )
  await canvas.tap({ position: { x: point.x, y: point.y } })
}

async function pinch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.querySelector('.board-host canvas')
    if (!canvas) throw new Error('no canvas')
    const rect = canvas.getBoundingClientRect()
    const cx = rect.width / 2
    const cy = rect.height / 2
    const send = (type: string, id: number, x: number, y: number) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: 'touch',
          isPrimary: id === 1,
          clientX: rect.left + x,
          clientY: rect.top + y,
          bubbles: true,
        }),
      )
    send('pointerdown', 1, cx - 40, cy)
    send('pointerdown', 2, cx + 40, cy)
    send('pointermove', 1, cx - 60, cy)
    send('pointermove', 2, cx + 60, cy)
    send('pointermove', 1, cx - 80, cy)
    send('pointermove', 2, cx + 80, cy)
    send('pointerup', 1, cx - 80, cy)
    send('pointerup', 2, cx + 80, cy)
  })
}

const boardScale = (page: Page): Promise<number> =>
  page.evaluate(() => (globalThis as unknown as { __atBoard: { scale: () => number } }).__atBoard.scale())

const unitY = async (page: Page, owner: string): Promise<number | undefined> => {
  const state = (await page.evaluate(() =>
    (globalThis as unknown as { __atGame: { getState: () => { units: Array<{ owner: string; x: number; y: number }> } } }).__atGame.getState(),
  )) as { units: Array<{ owner: string; x: number; y: number }> }
  return state.units.find((u) => u.owner === owner)?.y
}

async function setupMobileGame(context: BrowserContext) {
  const alice = await context.newPage()
  const bob = await context.newPage()
  await alice.goto(localUrl('m-a', '甲将军'))
  await joinRoom(alice, ROOM, '甲将军')
  await waitForHost(alice)
  await bob.goto(localUrl('m-b', '乙将军'))
  await joinRoom(bob, ROOM, '乙将军')
  await expect(alice.getByTestId('player-item')).toHaveCount(2)
  await alice.getByTestId('ready-button').click()
  await bob.getByTestId('ready-button').click()
  await expect(alice.getByTestId('start-button')).toBeEnabled()
  await alice.getByTestId('start-button').click()
  await expect(alice.getByTestId('phase-label')).toHaveText('部署')
  return { alice, bob }
}

test.describe('移动端（Pixel 5 视口 + 触摸）', () => {
  test('手机布局可玩：触摸部署、触摸移动', async ({ context }) => {
    const { alice, bob } = await setupMobileGame(context)

    await expect(alice.locator('.board-host canvas')).toBeVisible()
    // 没有横向溢出
    const overflow = await alice.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    // 棋盘默认适配屏幕（整块 24×24 都能看到）
    expect(await boardScale(alice)).toBeLessThan(0.4)

    await alice.getByTestId('deploy-sword').click()
    await tapTile(alice, 11, 4)
    await expect(alice.getByTestId('deploy-info')).toContainText('已放置 1/4')
    await bob.getByTestId('deploy-sword').click()
    await tapTile(bob, 11, 19)
    await expect(bob.getByTestId('deploy-info')).toContainText('已放置 1/4')

    await alice.getByTestId('deploy-done').click()
    await bob.getByTestId('deploy-done').click()
    await expect(alice.getByTestId('phase-label')).toHaveText('行动')
    await expect(alice.getByTestId('end-turn')).toBeEnabled()

    await tapTile(alice, 11, 4)
    await expect(alice.getByTestId('unit-panel')).toBeVisible()
    await tapTile(alice, 11, 7)
    await expect.poll(() => unitY(alice, 'm-a')).toBe(7)
  })

  test('双指缩放改变取景，音效开关可用', async ({ context }) => {
    const { alice } = await setupMobileGame(context)

    // 棋盘（PixiJS 分包 + 初始化，DEV 下要几秒）就绪后再读相机
    await expect(alice.locator('.board-host canvas')).toBeVisible()
    await expect
      .poll(() => alice.evaluate(() => typeof (globalThis as unknown as { __atBoard?: unknown }).__atBoard !== 'undefined'), { timeout: 20_000 })
      .toBe(true)

    const before = await boardScale(alice)
    await pinch(alice)
    const after = await boardScale(alice)
    expect(after).toBeGreaterThan(before)

    await expect(alice.getByTestId('sound-toggle')).toBeVisible()
    const labelBefore = await alice.getByTestId('sound-toggle').textContent()
    await alice.getByTestId('sound-toggle').click()
    expect(await alice.getByTestId('sound-toggle').textContent()).not.toBe(labelBefore)
  })
})
