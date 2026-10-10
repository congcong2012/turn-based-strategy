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

/**
 * 等 DEV 调试对象就绪。
 *
 * `__atBoard` 是在 Pixi **挂载完成**（动态 import + Application.init）之后才赋值的，
 * 而"部署阶段"文案、甚至 canvas 元素出现得都更早 —— 直接拿去用会读到 `undefined`。
 * CI 比本机慢，这个竞态在那里会真的翻车（v1.5.0 的 CI 就栽在这）。
 */
async function waitForBoardApi(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => typeof (globalThis as unknown as { __atBoard?: unknown }).__atBoard !== 'undefined',
        ),
      { timeout: 15_000 },
    )
    .toBe(true)
}

/** 点击棋盘上的某个格子（真实鼠标事件） */
async function clickTile(page: Page, x: number, y: number): Promise<void> {
  const box = await boardBox(page)
  await waitForBoardApi(page)
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

  /**
   * 悬停查看单位详情（桌面）。触摸屏那条走长按，见 `mobile.spec.ts`。
   * 数值必须来自 `src/data/units.json`，所以断言的是"刀盾兵 / HP 100/100"这类真值。
   */
  test('★ 悬停查看单位详情：显示兵种与当前状态，移开即收起', async ({ page }) => {
    await openPveSetup(page)
    await page.getByTestId('pve-opponents-1').click()
    await page.getByTestId('pve-start').click()
    await expect(page.getByTestId('phase-label')).toHaveText('部署')

    // 放一个刀盾兵到 (2,0)（与其它用例同一个落点，确认是合法部署格）
    await page.getByTestId('deploy-sword').click()
    await clickTile(page, 2, 0)

    const box = await boardBox(page)
    const project = async (x: number, y: number) =>
      page.evaluate(
        ([tx, ty]) =>
          (globalThis as unknown as { __atBoard: { project: (x: number, y: number) => { x: number; y: number } } }).__atBoard.project(
            tx,
            ty,
          ),
        [x, y] as const,
      )
    const unitPoint = await project(2, 0)
    // 找一个**空格子**来验证"悬停空格子不弹卡片"：不硬编码地图知识，直接从局面里挑
    const emptyTile = await page.evaluate(() => {
      const s = (
        globalThis as unknown as { __atGame: { getState: () => { units: Array<{ x: number; y: number }> } } }
      ).__atGame.getState()
      const taken = new Set(s.units.map((u) => u.x + ',' + u.y))
      for (let y = 6; y < 18; y += 1) {
        for (let x = 6; x < 18; x += 1) if (!taken.has(x + ',' + y)) return { x, y }
      }
      return { x: 12, y: 12 }
    })
    const emptyPoint = await project(emptyTile.x, emptyTile.y)

    // 先停在空格子上：不该有卡片
    await page.mouse.move(box.x + emptyPoint.x, box.y + emptyPoint.y)
    await expect(page.getByTestId('unit-detail')).toHaveCount(0)

    // 悬停到单位上 → 弹出详情（数值来自 src/data/units.json）
    await page.mouse.move(box.x + unitPoint.x, box.y + unitPoint.y)
    await expect(page.getByTestId('unit-detail')).toBeVisible()
    await expect(page.getByTestId('unit-detail-name')).toContainText('刀盾兵')
    await expect(page.getByTestId('unit-detail-hp')).toHaveText('HP 100/100')
    await expect(page.getByTestId('unit-detail-state')).toContainText('本回合还没动')

    // 悬停回空格子 → 收起
    await page.mouse.move(box.x + emptyPoint.x, box.y + emptyPoint.y)
    await expect(page.getByTestId('unit-detail')).toHaveCount(0)

    // 指针移出棋盘 → 同样收起
    await page.mouse.move(box.x + unitPoint.x, box.y + unitPoint.y)
    await expect(page.getByTestId('unit-detail')).toBeVisible()
    await page.mouse.move(1, 1)
    await expect(page.getByTestId('unit-detail')).toHaveCount(0)
  })

  /**
   * 触摸长按查看单位详情。触摸屏没有 hover，所以走 `pointerdown` 计时（450ms）。
   *
   * 用**合成 PointerEvent**（`pointerType: 'touch'`）而不是真触摸：这样不必额外开
   * `hasTouch` 上下文，而且能精确控制"按住多久"（真触摸的 down/up 间隔控制不了）。
   * 同时验证：长按之后的那次抬手**不该再被当成点选/移动**（否则会顺手把单位挪走）。
   */
  test('★ 长按查看单位详情：弹卡片且不吃掉操作（长按不等于点选）', async ({ page }) => {
    await openPveSetup(page)
    await page.getByTestId('pve-opponents-1').click()
    await page.getByTestId('pve-start').click()
    await expect(page.getByTestId('phase-label')).toHaveText('部署')

    // 合成触摸事件（pointerType: 'touch'）—— 这样不必开 hasTouch 上下文，
    // 也能精确控制"按住多久"（真触摸的 down/up 间隔控制不了）
    const touch = (type: 'pointerdown' | 'pointerup', x: number, y: number) =>
      page.evaluate(
        ([kind, tx, ty]) => {
          const canvas = document.querySelector('.board-host canvas')
          if (!canvas) throw new Error('no canvas')
          const rect = canvas.getBoundingClientRect()
          const p = (
            globalThis as unknown as { __atBoard: { project: (x: number, y: number) => { x: number; y: number } } }
          ).__atBoard.project(tx, ty)
          canvas.dispatchEvent(
            new PointerEvent(kind, {
              pointerId: 1,
              pointerType: 'touch',
              isPrimary: true,
              clientX: rect.left + p.x,
              clientY: rect.top + p.y,
              bubbles: true,
            }),
          )
        },
        [type, x, y] as const,
      )
    const unitCount = async () => (await gameState(page)).units?.length ?? 0

    // ★ AI 一开局就把自己的兵摆完了（默认 1 个对手 = 4 个兵），所以只能跟**基线**比，
    //   不能断言绝对条数 —— 这一条第一次就写错了，白白查了半天。
    await expect.poll(unitCount, { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    const baseline = await unitCount()

    // 1) 先用普通点击放一个兵到 (2,0)
    await page.getByTestId('deploy-sword').click()
    await clickTile(page, 2, 0)
    await expect.poll(unitCount, { timeout: 10_000 }).toBe(baseline + 1)

    // 2) 长按这个兵 → 弹详情；抬手后卡片留着（手机上不该一松手就没了）
    await touch('pointerdown', 2, 0)
    await expect(page.getByTestId('unit-detail')).toBeVisible({ timeout: 3000 })
    await expect(page.getByTestId('unit-detail-name')).toContainText('刀盾兵')
    await touch('pointerup', 2, 0)
    await expect(page.getByTestId('unit-detail')).toBeVisible()

    // 3) ★ 关键：长按之后紧接着的一次"轻点"要照常生效 —— 长按不能把随后的点击吃掉
    await touch('pointerdown', 3, 0)
    await touch('pointerup', 3, 0)
    await expect.poll(unitCount, { timeout: 10_000 }).toBe(baseline + 2)
  })

  /**
   * ★ 回归（不变量）：棋盘反复挂载/卸载后，**渲染失败计数必须为 0**、控制台也不该出现
   * `[board] 渲染这一帧失败 … reading 'clear'`。
   *
   * 这个报错来自 Pixi 的**全局** batch 池被 `app.destroy(true)` 清空（根因与确定性复现见
   * `tests/e2e/game.spec.ts` 的「棋盘渲染（Pixi 全局 batch 池）」；修法见
   * `src/render/boardApp.ts` 的 `destroy()`）。这里走的是**端到端**路径：
   * 连进三局，每局进入都会挂一个 Pixi Application、退出时会销毁它。
   */
  test('★ 回归：棋盘反复挂载/卸载后渲染失败计数为 0', async ({ page }) => {
    const boardErrors: string[] = []
    page.on('console', (msg) => {
      const text = msg.text()
      if (text.includes('渲染这一帧失败') || text.includes("reading 'clear'")) boardErrors.push(text)
    })
    page.on('pageerror', (err) => boardErrors.push('pageerror: ' + err.message))

    for (let round = 0; round < 3; round += 1) {
      await openPveSetup(page)
      await page.getByTestId('pve-opponents-1').click()
      await page.getByTestId('pve-start').click()
      await expect(page.getByTestId('phase-label')).toHaveText('部署')
      await expect(page.locator('.board-host canvas')).toBeVisible()
      await page.getByTestId('leave-button').click()
      await expect(page.getByTestId('entry-online')).toBeVisible()
    }

    expect(boardErrors).toEqual([])

    // 再进一局，直接读计数器（DEV 下 __atBoard 暴露了 renderErrors）。
    // ⚠️ 必须**轮询等它就绪**：`__atBoard` 是在 Pixi 挂载完成（动态 import + init）之后才赋值的，
    // 而"部署阶段"文案出现得更早 —— CI 比本机慢，直接读会 `undefined.renderErrors`（v1.5.0 就栽在这）。
    await openPveSetup(page)
    await page.getByTestId('pve-start').click()
    await expect(page.getByTestId('phase-label')).toHaveText('部署')
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const board = (globalThis as unknown as { __atBoard?: { renderErrors: () => number } }).__atBoard
            return board ? board.renderErrors() : -1 // -1 = 还没挂上，继续等
          }),
        { timeout: 15_000 },
      )
      .toBe(0)
  })

  test('★ 完整战斗日志：显示整局战报（含部署），可搜索、可关闭', async ({ page }) => {
    await openPveSetup(page)
    await page.getByTestId('pve-start').click()
    await expect(page.getByTestId('phase-label')).toHaveText('部署')

    // 造点战报：部署两个兵 + 结束部署
    await page.getByTestId('deploy-sword').click()
    await clickTile(page, 2, 0)
    await page.getByTestId('deploy-sword').click()
    await clickTile(page, 3, 0)
    await page.getByTestId('deploy-done').click()
    await expect(page.getByTestId('phase-label')).toHaveText('行动', { timeout: 15_000 })

    // 侧面小列表里有「最近战报」
    await expect(page.getByTestId('event-log')).toBeVisible()

    // 打开完整日志
    await page.getByTestId('battle-log-button').click()
    const panel = page.getByTestId('battle-log')
    await expect(panel).toBeVisible()

    // 内容里必须有部署阶段的战报（这正是"完整"的意义：小列表只显示最近 12 条，
    // 而这里能看到从第 0 回合开始的全部）
    const list = page.getByTestId('battle-log-list')
    await expect(list).toContainText('部署')

    // 计数条给出"共 N 个回合 · M 条"
    await expect(page.getByTestId('battle-log-count')).toContainText('条')

    // 搜索能过滤（搜一个必然不存在的词 → 变成"没有匹配"）
    await page.getByTestId('battle-log-search').fill('这个词不可能出现在战报里')
    await expect(list).toContainText('没有匹配的战报')

    // 清空搜索后内容回来
    await page.getByTestId('battle-log-search').fill('')
    await expect(list).toContainText('部署')

    // 关闭：点「关闭」按钮
    await page.getByTestId('battle-log-close').click()
    await expect(panel).toHaveCount(0)

    // 再打开，这次按 Esc 关（两种关法都要能用）
    await page.getByTestId('battle-log-button').click()
    await expect(panel).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
  })
})
