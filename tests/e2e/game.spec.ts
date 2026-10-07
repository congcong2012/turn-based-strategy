/**
 * M2 端到端：两名玩家从大厅 → 部署 → 行动 → 结束回合 的完整流程。
 * 棋盘点击是真实的 canvas 点击（用 DEV 提供的格子坐标投影），不是直接调 API。
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { ROOM, joinRoom, localUrl, waitForHost } from './helpers'

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
    ([tx, ty]) => (globalThis as unknown as { __atBoard: { project: (x: number, y: number) => { x: number; y: number } } }).__atBoard.project(tx, ty),
    [x, y] as const,
  )
  await page.mouse.click(box.x + point.x, box.y + point.y)
}

async function gameState(page: Page) {
  return page.evaluate(() => (globalThis as unknown as { __atGame: { getState: () => unknown } }).__atGame.getState()) as Promise<{
    phase: string
    turnIndex: number
    units: Array<{ id: string; owner: string; x: number; y: number; type: string }>
    players: string[]
  }>
}

/** 读取某个格子上据点的归属 */
async function villageOwner(page: Page, x: number, y: number) {
  return page.evaluate(
    ([tx, ty]) => {
      const state = (globalThis as unknown as {
        __atGame: { getState: () => { buildings: Array<{ x: number; y: number; owner: string | null }> } }
      }).__atGame.getState()
      return state.buildings.find((b) => b.x === tx && b.y === ty)?.owner ?? null
    },
    [x, y] as const,
  )
}

async function setReady(page: Page) {
  await page.getByTestId('ready-button').click()
  await expect(page.getByTestId('ready-badge').first()).toHaveText('✓ 已准备')
}

async function setupTwoPlayers(context: import('@playwright/test').BrowserContext) {
  const alice = await context.newPage()
  const bob = await context.newPage()
  for (const [tag, page] of [['alice', alice], ['bob', bob]] as const) {
    page.on('pageerror', (e) => console.log('[' + tag + ' pageerror]', String(e.stack ?? e.message).split('\n').slice(0, 6).join(' | ').slice(0, 500)))
    page.on('console', (m) => { if (m.type() === 'error') console.log('[' + tag + ' console]', m.text().slice(0, 300)) })
  }
  await alice.goto(localUrl('p-a', '甲将军'))
  await joinRoom(alice, ROOM, '甲将军')
  await waitForHost(alice)
  await bob.goto(localUrl('p-b', '乙将军'))
  await joinRoom(bob, ROOM, '乙将军')
  await expect(alice.getByTestId('player-item')).toHaveCount(2)
  await setReady(alice)
  await setReady(bob)
  await expect(alice.getByTestId('start-button')).toBeEnabled()
  await alice.getByTestId('start-button').click()
  await expect(alice.getByTestId('phase-label')).toHaveText('部署')
  await expect(bob.getByTestId('phase-label')).toHaveText('部署')
  return { alice, bob }
}

test.describe('对局（本地传输）', () => {
  test('部署 → 行动 → 结束回合 的双端流程', async ({ context }) => {
    const { alice, bob } = await setupTwoPlayers(context)

    // 甲（北半场 y0..4）在道路上放一个刀盾兵
    await alice.getByTestId('deploy-sword').click()
    await clickTile(alice, 11, 4)
    await expect(alice.getByTestId('deploy-info')).toContainText('已放置 1/4')

    // 越区部署应被拒绝：点到南半场
    await clickTile(alice, 11, 22)
    await expect(alice.getByTestId('deploy-info')).toContainText('已放置 1/4')

    // 乙（南半场 y19..23）
    await bob.getByTestId('deploy-sword').click()
    await clickTile(bob, 11, 19)
    await expect(bob.getByTestId('deploy-info')).toContainText('已放置 1/4')

    // 双方确认 → 进入行动阶段，先手为甲
    await alice.getByTestId('deploy-done').click()
    await bob.getByTestId('deploy-done').click()
    await expect(alice.getByTestId('phase-label')).toHaveText('行动')
    await expect(alice.getByTestId('end-turn')).toBeEnabled()
    await expect(bob.getByTestId('end-turn')).toBeDisabled()

    const before = await gameState(alice)
    expect(before.units).toHaveLength(2)
    const mine = before.units.find((u) => u.owner === 'p-a')!
    expect({ x: mine.x, y: mine.y }).toEqual({ x: 11, y: 4 })

    // 甲：点选单位 → 点蓝格移动
    await clickTile(alice, 11, 4)
    await expect(alice.getByTestId('unit-panel')).toBeVisible()
    await clickTile(alice, 11, 7)
    await expect
      .poll(async () => {
        const s = await gameState(alice)
        return s.units.find((u) => u.id === mine.id)?.y
      })
      .toBe(7)

    // 乙侧同步看到
    await expect
      .poll(async () => {
        const s = await gameState(bob)
        return s.units.find((u) => u.id === mine.id)?.y
      })
      .toBe(7)

    // 甲的回合结束后轮到乙
    await alice.getByTestId('end-turn').click()
    await expect(alice.getByTestId('current-player')).toContainText('乙将军')
    await expect(bob.getByTestId('end-turn')).toBeEnabled()
    // 「电脑正在思考」只属于单人模式：联机里"不是我的回合"是另一个人类，不该这么提示
    await expect(alice.getByTestId('ai-thinking')).toHaveCount(0)
    await expect(bob.getByTestId('ai-thinking')).toHaveCount(0)

    // 乙移动自己的单位
    const enemy = (await gameState(bob)).units.find((u) => u.owner === 'p-b')!
    await clickTile(bob, 11, 19)
    await clickTile(bob, 11, 16)
    await expect
      .poll(async () => {
        const s = await gameState(alice)
        return s.units.find((u) => u.id === enemy.id)?.y
      })
      .toBe(16)

    // 非当前玩家无法操作：甲此时点自己的单位不应产生可行动状态
    await expect(alice.getByTestId('end-turn')).toBeDisabled()
  })

  test('占领：两次占领后村落易主，战报同步', async ({ context }) => {
    const { alice, bob } = await setupTwoPlayers(context)

    // 甲在王城左侧部署，紧邻中立村落 (9,6)
    await alice.getByTestId('deploy-sword').click()
    await clickTile(alice, 9, 4)
    await bob.getByTestId('deploy-sword').click()
    await clickTile(bob, 11, 19)
    await alice.getByTestId('deploy-done').click()
    await bob.getByTestId('deploy-done').click()
    await expect(alice.getByTestId('phase-label')).toHaveText('行动')

    // 第 1 回合：走到村落上并占领（满血步兵 +10）
    await clickTile(alice, 9, 4)
    await clickTile(alice, 9, 6)
    await expect(alice.getByTestId('capture-button')).toBeEnabled()
    await alice.getByTestId('capture-button').click()
    await expect(alice.getByTestId('event-log')).toContainText('占领 村落 进度 10/20')

    // 换手一轮
    await alice.getByTestId('end-turn').click()
    await expect(bob.getByTestId('end-turn')).toBeEnabled()
    await bob.getByTestId('end-turn').click()
    await expect(alice.getByTestId('end-turn')).toBeEnabled()

    // 第 2 回合：再次占领（+10 = 20）→ 结束回合时易主
    await clickTile(alice, 9, 6)
    await alice.getByTestId('capture-button').click()
    await alice.getByTestId('end-turn').click()

    await expect
      .poll(async () => villageOwner(alice, 9, 6), { timeout: 15_000 })
      .toBe('p-a')
    await expect(alice.getByTestId('event-log')).toContainText('占领了 村落')
    // 战报经 P2P 同步给对手
    await expect(bob.getByTestId('event-log')).toContainText('占领了 村落')
  })

  test('投降：双方都进入结算界面，可返回大厅', async ({ context }) => {
    const { alice, bob } = await setupTwoPlayers(context)
    await alice.getByTestId('deploy-sword').click()
    await clickTile(alice, 11, 4)
    await bob.getByTestId('deploy-sword').click()
    await clickTile(bob, 11, 19)
    await alice.getByTestId('deploy-done').click()
    await bob.getByTestId('deploy-done').click()
    await expect(alice.getByTestId('phase-label')).toHaveText('行动')

    // 乙认输（不受回合归属限制）
    await bob.getByTestId('resign-button').click()
    await expect(alice.getByTestId('game-over')).toContainText('胜利')
    await expect(bob.getByTestId('game-over')).toContainText('败北')
    await expect(alice.getByTestId('game-over')).toContainText('对手投降')

    await alice.getByTestId('back-to-lobby').click()
    await expect(alice.getByTestId('join-panel')).toBeVisible()
  })

  test('地图可拖动、可滚轮缩放（画面必须真的刷新）', async ({ context }) => {
    const { alice } = await setupTwoPlayers(context)
    const canvas = alice.locator('.board-host canvas')
    await expect(canvas).toBeVisible()
    await expect
      .poll(() => alice.evaluate(() => typeof (globalThis as unknown as { __atBoard?: unknown }).__atBoard !== 'undefined'), { timeout: 20_000 })
      .toBe(true)

    const camera = () =>
      alice.evaluate(() => (globalThis as unknown as { __atBoard: { camera: () => { scale: number; offsetX: number; offsetY: number } } }).__atBoard.camera())
    const shot = async () => (await alice.locator('.board-host').screenshot()).toString('base64')

    const before = await camera()
    const beforeShot = await shot()
    const box = (await canvas.boundingBox())!

    // 拖动平移
    await alice.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await alice.mouse.down()
    for (let i = 1; i <= 6; i += 1) {
      await alice.mouse.move(box.x + box.width / 2 - i * 20, box.y + box.height / 2 - i * 8)
      await alice.waitForTimeout(16)
    }
    await alice.mouse.up()
    await expect.poll(async () => Math.abs((await camera()).offsetX - before.offsetX), { timeout: 10_000 }).toBeGreaterThan(20)
    const afterDrag = await shot()
    expect(afterDrag).not.toBe(beforeShot) // 画面必须重绘，否则就是"拖不动"

    // 滚轮缩放
    await alice.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await alice.mouse.wheel(0, -400)
    await expect.poll(async () => (await camera()).scale, { timeout: 10_000 }).toBeGreaterThan(before.scale)
    expect(await shot()).not.toBe(afterDrag)
  })

  test('部署区外点击会说明方位并可一键定位（避免"地图点了没反应"）', async ({ context }) => {
    const { alice } = await setupTwoPlayers(context)
    await alice.getByTestId('deploy-sword').click()

    // 点部署区之外（地图中部）→ 明确提示方位，且不产生单位
    await clickTile(alice, 11, 6)
    await expect(alice.getByTestId('game-hint')).toContainText('部署区')
    await expect(alice.getByTestId('deploy-info')).toContainText('已放置 0/4')

    // 一键定位后仍能看到提示，重新点区内即可部署
    await alice.getByTestId('locate-button').click()
    await expect(alice.getByTestId('game-hint')).toContainText('部署区')
    await clickTile(alice, 11, 3)
    await expect(alice.getByTestId('deploy-info')).toContainText('已放置 1/4')
  })

  test('重复部署/连续操作不会让棋盘崩溃（渲染对象池回归）', async ({ context }) => {
    const { alice, bob } = await setupTwoPlayers(context)
    await alice.getByTestId('deploy-sword').click()
    for (const [x, y] of [[11, 2], [5, 3], [18, 3]] as const) {
      await clickTile(alice, x, y)
    }
    await expect(alice.getByTestId('deploy-info')).toContainText('已放置 3/4')
    await bob.getByTestId('deploy-sword').click()
    await clickTile(bob, 11, 19)
    await alice.getByTestId('deploy-done').click()
    await bob.getByTestId('deploy-done').click()
    await expect(alice.getByTestId('phase-label')).toHaveText('行动')
    // 行动阶段继续点选/移动，棋盘仍然可用
    await clickTile(alice, 11, 2)
    await expect(alice.getByTestId('unit-panel')).toBeVisible()
    await clickTile(alice, 11, 5)
    await expect
      .poll(async () => (await gameState(alice)).units.find((u) => u.owner === 'p-a')?.y)
      .toBe(5)
  })

  test('生产：兵营出兵在下一回合出场', async ({ context }) => {
    const { alice, bob } = await setupTwoPlayers(context)
    await alice.getByTestId('deploy-sword').click()
    await clickTile(alice, 11, 4)
    await bob.getByTestId('deploy-sword').click()
    await clickTile(bob, 11, 19)
    await alice.getByTestId('deploy-done').click()
    await bob.getByTestId('deploy-done').click()
    await expect(alice.getByTestId('phase-label')).toHaveText('行动')

    // 点己方兵营 → 生产面板
    await clickTile(alice, 6, 2)
    await expect(alice.getByTestId('building-panel')).toBeVisible()
    await alice.getByTestId('produce-spear').click()
    await expect(alice.getByTestId('pending-list')).toContainText('长枪兵')

    // 结束回合 → 对手 → 回到自己时出场
    await alice.getByTestId('end-turn').click()
    await bob.getByTestId('end-turn').click()
    await expect
      .poll(async () => {
        const s = await gameState(alice)
        return s.units.filter((u) => u.owner === 'p-a').length
      })
      .toBe(2)
    const spawned = (await gameState(alice)).units.find((u) => u.owner === 'p-a' && u.type === 'spear')
    expect(spawned && { x: spawned.x, y: spawned.y }).toEqual({ x: 6, y: 2 })
  })
})

/**
 * ★ 回归专项：Pixi 的**全局 batch 池**污染。
 *
 * 背景（2026-10-07 排查）：棋盘偶发报
 *   `[board] 渲染这一帧失败，已跳过：TypeError: Cannot read properties of null (reading 'clear')`
 * 且**出现在活跃对局里**（不只是页面卸载时）。根因在 Pixi 内部：
 *   - batch 池是模块级的 `batchPool`，**跨所有 renderer 共享**；
 *   - `renderer.destroy(true)` 会触发 `GlobalResourceRegistry.release()`，
 *     把池里**已借出、仍被别的 renderer 持有**的 Batch 也一并 `destroy()`（`batch.textures = null`）；
 *   - 它们随后被归还回池，下一次 `getBatchFromPool()` 取到就崩在 `Batcher.break()` 的
 *     `batch.textures.clear()` —— 报错文本完全吻合。
 *
 * 所以 `boardApp` 销毁时必须传 `{ removeView: true }` 而**不是** `true`
 * （见 `src/render/boardApp.ts` 的 `destroy()` 注释）。
 *
 * 本用例直接驱动批池、不经过 Application/render 的时序，因此是**确定性**的
 * —— 既是根因的证据，也是"谁把销毁参数改回 true 就红"的哨兵。
 */
test.describe('棋盘渲染（Pixi 全局 batch 池）', () => {
  test('★ 回归：release() 会毒化全局 batch 池，不调它则另一个 renderer 照常渲染', async ({ page }) => {
    await page.goto('/')

    const result = await page.evaluate(async () => {
      const url = '/@id/pixi.js'
      const { Batcher, GlobalResourceRegistry } = await import(/* @vite-ignore */ url)

      /** 造一个最小可用的批处理器：packXxx 全是纯写入，本用例只关心池的归属关系 */
      const makeBatcher = () => {
        const b = new Batcher({ maxTextures: 2, attributesInitialSize: 4, indicesInitialSize: 6 })
        b.vertexSize = 6
        b.packAttributes = () => {}
        b.packQuadAttributes = () => {}
        b.packIndex = () => {}
        return b
      }
      const element = () => ({
        indexSize: 6,
        attributeSize: 1,
        blendMode: 'normal',
        topology: 'triangle-strip',
        texture: { _source: { uid: 1 } },
      })
      const instructionSet = () => ({ add() {} })

      /** 走三帧：第 2 帧 begin() 会把上一帧的 batch 归还进池、break() 再借出来
       *  ⇒ 池数组里留下"已借出但仍有引用"的条目，正是被 release() 误伤的靶子 */
      const run = (release: boolean): string[] => {
        const live = makeBatcher()
        live.begin()
        live.add(element())
        live.break(instructionSet())
        live.begin()
        live.add(element())
        live.break(instructionSet())
        if (release) GlobalResourceRegistry.release()
        try {
          live.begin()
          live.add(element())
          live.break(instructionSet())
          return []
        } catch (err) {
          return [String((err as Error)?.message ?? err)]
        }
      }

      return { withRelease: run(true), withoutRelease: run(false) }
    })

    // 我们采用的销毁方式（不触发全局释放）⇒ 必须毫无问题
    expect(result.withoutRelease).toEqual([])
    // 反证：`destroy(true)` 的行为（触发 release()）确实会把活着的 renderer 搞崩
    expect(result.withRelease).toHaveLength(1)
    expect(result.withRelease[0]).toContain("reading 'clear'")
  })
})
