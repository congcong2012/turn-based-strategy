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

async function setReady(page: Page) {
  await page.getByTestId('ready-button').click()
  await expect(page.getByTestId('ready-badge').first()).toHaveText('✓ 已准备')
}

async function setupTwoPlayers(context: import('@playwright/test').BrowserContext) {
  const alice = await context.newPage()
  const bob = await context.newPage()
  for (const [tag, page] of [['alice', alice], ['bob', bob]] as const) {
    page.on('pageerror', (e) => console.log('[' + tag + ' pageerror]', String(e.message).slice(0, 300)))
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
