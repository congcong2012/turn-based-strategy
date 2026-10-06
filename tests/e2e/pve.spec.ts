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

    // 难度三档（简单 / 普通 / 困难）——「极难」不再是并列档位，而是「困难」下的一个算法模式
    await expect(page.getByTestId('pve-difficulty-easy')).toBeVisible()
    await expect(page.getByTestId('pve-difficulty-normal')).toBeVisible()
    await expect(page.getByTestId('pve-difficulty-hard')).toContainText('困难')
    await expect(page.getByTestId('pve-difficulty-oracle')).toHaveCount(0)
    // 没选「困难」时不该展开算法模式
    await expect(page.getByTestId('pve-hard-modes')).toHaveCount(0)

    // 三档必须写明**行为差异**（不能只是"更聪明"这类空话），并明示公平性
    await expect(page.getByTestId('pve-difficulty-easy')).toContainText('偶尔干脆不动')
    await expect(page.getByTestId('pve-difficulty-normal')).toContainText('集火残血')
    await expect(page.getByTestId('pve-difficulty-hard')).toContainText('回防被抢的据点')
    await expect(page.getByTestId('pve-difficulty-fairness')).toContainText('完全相同的规则')

    // 选「困难」→ 展开两种算法模式，并且**明确标注算法本身**与深推演的实测强度
    await page.getByTestId('pve-difficulty-easy').click()
    await page.getByTestId('pve-difficulty-hard').click()
    await expect(page.getByTestId('pve-difficulty-hard')).toHaveClass(/picked/)
    await expect(page.getByTestId('pve-hard-modes')).toBeVisible()
    await expect(page.getByTestId('pve-hard-mode-lookahead')).toContainText('快棋')
    await expect(page.getByTestId('pve-hard-mode-lookahead')).toContainText('一步前瞻')
    await expect(page.getByTestId('pve-hard-mode-rollout')).toContainText('深推演')
    await expect(page.getByTestId('pve-hard-mode-rollout')).toContainText('回合推演')
    await expect(page.getByTestId('pve-hard-mode-strength')).toContainText('65%')

    // 「深推演」的前提是"只有一个对手"，所以两人局可选、多人局禁用并说明原因
    // （此刻是 4 人局）
    await expect(page.getByTestId('pve-hard-mode-rollout')).toBeDisabled()
    await expect(page.getByTestId('pve-hard-mode-scope-hint')).toBeVisible()

    await page.getByTestId('pve-opponents-1').click()
    await expect(page.getByTestId('pve-hard-mode-rollout')).toBeEnabled()
    await expect(page.getByTestId('pve-hard-mode-scope-hint')).toHaveCount(0)
    await page.getByTestId('pve-hard-mode-rollout').click()
    await expect(page.getByTestId('pve-hard-mode-rollout')).toHaveClass(/picked/)

    // 再把对手数调回多人：已选的深推演要自动落回「快棋」，不能留一个"选着但已被禁用"的模式
    await page.getByTestId('pve-opponents-3').click()
    await expect(page.getByTestId('pve-hard-mode-lookahead')).toHaveClass(/picked/)
    await expect(page.getByTestId('pve-hard-mode-rollout')).toBeDisabled()

    // 换回「普通」：模式组收起
    await page.getByTestId('pve-difficulty-normal').click()
    await expect(page.getByTestId('pve-hard-modes')).toHaveCount(0)

    // 返回主页
    await page.getByTestId('back-home').click()
    await expect(page.getByTestId('entry-online')).toBeVisible()

    expect(errors).toEqual([])
  })

  test('选「困难 · 深推演」能正常开局，且难度真的落进了会话（读存档里的配置）', async ({ page }) => {
    await openPveSetup(page)
    // 默认两人局：深推演可用
    await page.getByTestId('pve-difficulty-hard').click()
    await expect(page.getByTestId('pve-hard-mode-rollout')).toBeEnabled()
    await page.getByTestId('pve-hard-mode-rollout').click()
    await page.getByTestId('pve-start').click()

    await expect(page.getByTestId('phase-label')).toHaveText('部署')
    // AI 自动完成部署：说明深推演这一档的策略确实被会话用上了
    await expect
      .poll(async () => (await gameState(page)).units?.length ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(0)

    // 存档里存的就是这一档 —— 顺便证明"用深推演开的局刷新后不会被判非法而清档"
    const persisted = await page.evaluate(() => {
      const raw = window.localStorage.getItem('ancient-tactics.pve')
      return raw ? (JSON.parse(raw) as { config?: { difficulty?: string } }).config?.difficulty : null
    })
    expect(persisted).toBe('oracle')

    // 刷新后接着打（存档校验放行了这一档）
    await page.reload()
    await expect(page.getByTestId('pve-setup')).toHaveCount(0)
    await expect(page.getByTestId('phase-label')).toHaveText('部署')
  })

  test('「困难」默认落在「快棋」，存档里写的仍是原来的 hard（两档 id 都没变）', async ({ page }) => {
    await openPveSetup(page)
    await page.getByTestId('pve-difficulty-hard').click()
    await expect(page.getByTestId('pve-hard-mode-lookahead')).toHaveClass(/picked/)
    await page.getByTestId('pve-start').click()

    await expect(page.getByTestId('phase-label')).toHaveText('部署')
    const persisted = await page.evaluate(() => {
      const raw = window.localStorage.getItem('ancient-tactics.pve')
      return raw ? (JSON.parse(raw) as { config?: { difficulty?: string } }).config?.difficulty : null
    })
    // 界面合并了，存档格式没变 —— 老存档（含用极难开的局）零迁移
    expect(persisted).toBe('hard')
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

    // 电脑回合进行中要有明确反馈（高难度档单回合可能想很久，没有反馈会以为卡死）
    await expect(page.getByTestId('ai-thinking')).toBeVisible()
    await expect(page.getByTestId('ai-thinking')).toContainText('正在思考')

    // AI 会以约 450ms/步 走完自己的回合，然后把控制权交还人类
    await expect
      .poll(async () => page.getByTestId('current-player').innerText(), { timeout: 45_000 })
      .toContain('（你）')
    // 交还之后提示条必须消失
    await expect(page.getByTestId('ai-thinking')).toHaveCount(0)

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

  test('结算显示战绩（得分/据点/部队/损失），并能复制战报文本', async ({ page }) => {
    // 拦下剪贴板写入，检查复制的战报内容（与房间密码用例同一手法）
    await page.addInitScript(() => {
      const w = window as unknown as { __copied: string }
      w.__copied = ''
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text: string) => {
            w.__copied = text
            return Promise.resolve()
          },
        },
      })
    })

    await openPveSetup(page)
    await page.getByTestId('pve-difficulty-easy').click()
    await page.getByTestId('pve-start').click()
    await expect(page.getByTestId('phase-label')).toHaveText('部署')

    await page.getByTestId('deploy-sword').click()
    await clickTile(page, 2, 0)
    await page.getByTestId('deploy-done').click()
    await expect(page.getByTestId('phase-label')).toHaveText('行动', { timeout: 15_000 })

    await page.getByTestId('resign-button').click()
    await expect(page.getByTestId('game-over')).toBeVisible()

    // 战绩面板：两方各一行，且只有"我方"那一行被高亮
    await expect(page.getByTestId('battle-tally')).toBeVisible()
    await expect(page.locator('.tally-table tbody tr')).toHaveCount(2)
    await expect(page.locator('.tally-table tr.tally-self')).toHaveCount(1)
    await expect(page.getByTestId('battle-totals')).toContainText('回合')
    await expect(page.getByTestId('battle-totals')).toContainText('损失')

    // 复制战报：按钮给"已复制"反馈，剪贴板里是完整文本
    await page.getByTestId('copy-report').click()
    await expect(page.getByTestId('copy-report')).toHaveText('已复制')
    const copied = await page.evaluate(() => (window as unknown as { __copied: string }).__copied)
    expect(copied).toContain('【古代战棋】对局战报')
    // 单人模式下己方的显示名就是「你」（与界面战报口径一致），并带上"我方"标记
    expect(copied).toContain('你（我方）')
    expect(copied).toContain('本局投入 ')
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
