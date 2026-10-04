/**
 * 单人练习（PVE）端到端：设置页 → 开局 → 部署 → AI 自动部署 → 行动 → 结算 → 再来一局。
 *
 * 单人模式完全离线，所以这个用例**不依赖任何网络**（也不走 ?transport=local 的跨标签页通道）。
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { localHomeUrl } from './helpers'

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

async function gameState(page: Page) {
  return page.evaluate(() =>
    (globalThis as unknown as { __atGame: { getState: () => unknown } }).__atGame.getState(),
  ) as Promise<{
    phase: string
    players: string[]
    mapId: string
    round: number
    units: Array<{ id: string; owner: string; x: number; y: number; type: string }>
  }>
}

/** 进入单人练习设置页 */
async function openPveSetup(page: Page): Promise<void> {
  await page.goto(localHomeUrl('pve-a', '甲将军'))
  await page.getByTestId('entry-pve').click()
  await expect(page.getByTestId('pve-setup')).toBeVisible()
}

test.describe('单人练习（PVE）', () => {
  test('主页入口不再是"开发中"，设置页可选对手数量/阵营/难度', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    await page.goto(localHomeUrl('pve-a', '甲将军'))
    await expect(page.getByTestId('entry-pve')).toBeVisible()
    await expect(page.getByTestId('entry-pve')).not.toContainText('开发中')

    await page.getByTestId('entry-pve').click()
    await expect(page.getByTestId('pve-setup')).toBeVisible()
    await expect(page.getByTestId('pve-start')).toBeVisible()

    // 1 个 AI：2 人局，2 个阵营，无中立角提示
    await page.getByTestId('pve-opponents-1').click()
    await expect(page.getByTestId('pve-seat-0')).toBeVisible()
    await expect(page.getByTestId('pve-seat-1')).toBeVisible()
    await expect(page.getByTestId('pve-seat-2')).toHaveCount(0)
    await expect(page.getByTestId('pve-map-hint')).toContainText('2 方')

    // 2 个 AI：3 人局（四人图），应给出中立角提示
    await page.getByTestId('pve-opponents-2').click()
    await expect(page.getByTestId('pve-seat-2')).toBeVisible()
    await expect(page.getByTestId('pve-neutral-hint')).toContainText('无主王城')

    // 3 个 AI：4 人局，四个阵营，无中立角
    await page.getByTestId('pve-opponents-3').click()
    await expect(page.getByTestId('pve-seat-3')).toBeVisible()
    await expect(page.getByTestId('pve-map-hint')).toContainText('4 方')
    await expect(page.getByTestId('pve-neutral-hint')).toHaveCount(0)

    // 难度可选（三档：简单 / 普通 / 困难）
    await expect(page.getByTestId('pve-difficulty-easy')).toBeVisible()
    await expect(page.getByTestId('pve-difficulty-normal')).toBeVisible()
    await expect(page.getByTestId('pve-difficulty-hard')).toContainText('困难')
    await page.getByTestId('pve-difficulty-easy').click()
    await page.getByTestId('pve-difficulty-hard').click()
    await expect(page.getByTestId('pve-difficulty-hard')).toHaveClass(/picked/)
    await page.getByTestId('pve-difficulty-normal').click()

    // 三档必须写明**行为差异**（不能只是"更聪明"这类空话），并明示公平性
    await expect(page.getByTestId('pve-difficulty-easy')).toContainText('偶尔干脆不动')
    await expect(page.getByTestId('pve-difficulty-normal')).toContainText('集火残血')
    await expect(page.getByTestId('pve-difficulty-hard')).toContainText('回防被抢的据点')
    await expect(page.getByTestId('pve-difficulty-fairness')).toContainText('完全相同的规则')

    // 返回主页
    await page.getByTestId('back-home').click()
    await expect(page.getByTestId('entry-online')).toBeVisible()

    expect(errors).toEqual([])
  })

  test('开局 → 部署 → AI 自动部署 → 进入行动阶段', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    await openPveSetup(page)
    await page.getByTestId('pve-opponents-1').click()
    await page.getByTestId('pve-difficulty-normal').click()
    await page.getByTestId('pve-start').click()

    // 对局界面：单人徽章、部署阶段
    await expect(page.getByTestId('pve-badge')).toBeVisible()
    await expect(page.getByTestId('phase-label')).toHaveText('部署')
    // 单人模式不该出现联机专属 UI
    await expect(page.getByTestId('pause-banner')).toHaveCount(0)

    const before = await gameState(page)
    expect(before.phase).toBe('DEPLOY')
    expect(before.mapId).toBe('ancient_01')
    expect(before.players).toHaveLength(2)

    // 人类部署 1 个刀盾兵到己方（北侧）部署区
    await page.getByTestId('deploy-sword').click()
    await clickTile(page, 2, 0)

    await expect
      .poll(async () => (await gameState(page)).units?.length ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(0)

    // AI 已自动部署完毕（无需等待对手）
    await expect(page.getByTestId('deploy-done')).toBeEnabled()
    await page.getByTestId('deploy-done').click()

    // 双方都确认 → 进入行动阶段
    await expect(page.getByTestId('phase-label')).toHaveText('行动', { timeout: 15_000 })
    const after = await gameState(page)
    expect(after.phase).toBe('PLAYING')

    // 双方都在记分板上
    await expect(page.locator('[data-testid^="score-"]')).toHaveCount(2)

    expect(errors).toEqual([])
  })

  test('AI 会真的行动：结束回合后轮到 AI，随后控制权回到人类', async ({ page }) => {
    await openPveSetup(page)
    await page.getByTestId('pve-start').click()
    await expect(page.getByTestId('phase-label')).toHaveText('部署')

    await page.getByTestId('deploy-sword').click()
    await clickTile(page, 2, 0)
    await page.getByTestId('deploy-done').click()
    await expect(page.getByTestId('phase-label')).toHaveText('行动', { timeout: 15_000 })

    await expect(page.getByTestId('end-turn')).toBeEnabled()
    await page.getByTestId('end-turn').click()

    // AI 会以约 450ms/步 走完自己的回合，然后把控制权交还人类
    await expect
      .poll(async () => page.getByTestId('current-player').innerText(), { timeout: 45_000 })
      .toContain('（你）')

    // 回合数应已推进
    const state = await gameState(page)
    expect(state.round).toBeGreaterThanOrEqual(2)

    // ★ AI 的决策确实跑在 Web Worker 里。
    // Worker 是"失败即静默回退到主线程"的（结果一样、游戏照常能玩），
    // 所以这条断言是唯一能抓住"打包配置坏了导致 Worker 从未生效"的地方。
    const ai = await page.evaluate(() => {
      const hook = (
        globalThis as unknown as {
          __atPve?: { aiTransport: () => 'worker' | 'main'; aiFallback: () => string | null }
        }
      ).__atPve
      return hook ? { transport: hook.aiTransport(), fallback: hook.aiFallback() } : null
    })
    expect(ai).not.toBeNull()
    expect(ai?.fallback).toBeNull()
    expect(ai?.transport).toBe('worker')
  })

  test('认输即结算，可"再来一局"回到部署阶段，也可退出对局回主页', async ({ page }) => {
    await openPveSetup(page)
    await page.getByTestId('pve-start').click()
    await expect(page.getByTestId('phase-label')).toHaveText('部署')

    await page.getByTestId('deploy-sword').click()
    await clickTile(page, 2, 0)
    await page.getByTestId('deploy-done').click()
    await expect(page.getByTestId('phase-label')).toHaveText('行动', { timeout: 15_000 })

    await page.getByTestId('resign-button').click()

    // 结算遮罩：单人模式给的是「再来一局 / 返回主页」，而不是「返回大厅」
    await expect(page.getByTestId('game-over')).toBeVisible()
    await expect(page.getByTestId('pve-again')).toBeVisible()
    await expect(page.getByTestId('pve-home')).toBeVisible()
    await expect(page.getByTestId('back-to-lobby')).toHaveCount(0)
    await expect(page.getByTestId('game-over')).toContainText('败北')

    // 再来一局：回到部署阶段
    await page.getByTestId('pve-again').click()
    await expect(page.getByTestId('game-over')).toHaveCount(0)
    await expect(page.getByTestId('phase-label')).toHaveText('部署')
    expect((await gameState(page)).round).toBe(1)

    // 退出对局 → 回主页
    await page.getByTestId('leave-button').click()
    await expect(page.getByTestId('entry-online')).toBeVisible()
  })

  test('三局二胜不必：3 个 AI 也能正常开局（四人图）', async ({ page }) => {
    await openPveSetup(page)
    await page.getByTestId('pve-opponents-3').click()
    await page.getByTestId('pve-difficulty-easy').click()
    await page.getByTestId('pve-start').click()

    await expect(page.getByTestId('phase-label')).toHaveText('部署')
    const state = await gameState(page)
    expect(state.mapId).toBe('ancient_04')
    expect(state.players).toHaveLength(4)
  })

  test('刷新页面后自动回到原对局，并能接着打（对局存档）', async ({ page }) => {
    await openPveSetup(page)
    await page.getByTestId('pve-opponents-1').click()
    await page.getByTestId('pve-difficulty-normal').click()
    await page.getByTestId('pve-start').click()
    await expect(page.getByTestId('phase-label')).toHaveText('部署')

    await page.getByTestId('deploy-sword').click()
    await clickTile(page, 2, 0)
    await page.getByTestId('deploy-done').click()
    await expect(page.getByTestId('phase-label')).toHaveText('行动', { timeout: 15_000 })

    const before = await gameState(page)
    expect(before.phase).toBe('PLAYING')
    expect(before.units.length).toBeGreaterThan(0)

    // 刷新：不该回到设置页，而是直接接着打
    await page.reload()

    await expect(page.getByTestId('pve-badge')).toBeVisible()
    await expect(page.getByTestId('pve-setup')).toHaveCount(0)
    await expect(page.getByTestId('phase-label')).toHaveText('行动')

    const after = await gameState(page)
    expect(after.phase).toBe('PLAYING')
    expect(after.round).toBe(before.round)
    expect(after.players).toEqual(before.players)
    expect(after.units.length).toBe(before.units.length)

    // 恢复后仍然可玩：结束回合 → AI 走完 → 控制权回到人类
    await expect(page.getByTestId('end-turn')).toBeEnabled()
    await page.getByTestId('end-turn').click()
    await expect
      .poll(async () => page.getByTestId('current-player').innerText(), { timeout: 45_000 })
      .toContain('（你）')
  })

  test('"退出对局"会清掉存档：再进单人练习是设置页', async ({ page }) => {
    await openPveSetup(page)
    await page.getByTestId('pve-start').click()
    await expect(page.getByTestId('phase-label')).toHaveText('部署')

    await page.getByTestId('deploy-sword').click()
    await clickTile(page, 2, 0)
    await page.getByTestId('deploy-done').click()
    await expect(page.getByTestId('phase-label')).toHaveText('行动', { timeout: 15_000 })

    await page.getByTestId('leave-button').click()
    await expect(page.getByTestId('entry-online')).toBeVisible()

    await page.getByTestId('entry-pve').click()
    await expect(page.getByTestId('pve-setup')).toBeVisible()
    await expect(page.getByTestId('pve-badge')).toHaveCount(0)
  })
})
