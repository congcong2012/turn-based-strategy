/**
 * M6 多人局 E2E（本地传输，3 名玩家）：
 *  - 3 人同房 → 自动选 4 人地图「四战之地」
 *  - 依次部署 → 回合按 A→B→C 轮转
 *  - 淘汰制：C 投降后对局继续，B 投降后 A 获胜
 */
import { expect, test } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { ROOM, joinRoom, localUrl, waitForHost } from './helpers'

async function clickTile(page: Page, x: number, y: number): Promise<void> {
  const canvas = page.locator('.board-host canvas')
  await expect(canvas).toBeVisible()
  const point = await page.evaluate(
    ([tx, ty]) => (globalThis as unknown as { __atBoard: { project: (x: number, y: number) => { x: number; y: number } } }).__atBoard.project(tx, ty),
    [x, y] as const,
  )
  await canvas.click({ position: { x: point.x, y: point.y } })
}

async function stateOf(page: Page) {
  return page.evaluate(() => (globalThis as unknown as { __atGame: { getState: () => unknown } }).__atGame.getState()) as Promise<{
    phase: string
    mapId: string
    round: number
    turnIndex: number
    players: string[]
    eliminated: string[]
    units: Array<{ owner: string; x: number; y: number }>
  }>
}

async function setupThreePlayers(context: BrowserContext) {
  const alice = await context.newPage()
  const bob = await context.newPage()
  const carol = await context.newPage()
  const seats: Array<[Page, string, string]> = [
    [alice, 'mp-a', '甲将军'],
    [bob, 'mp-b', '乙将军'],
    [carol, 'mp-c', '丙将军'],
  ]
  for (const [page, id, nick] of seats) {
    await page.goto(localUrl(id, nick))
    await joinRoom(page, ROOM, nick)
  }
  await waitForHost(alice)
  await expect(alice.getByTestId('player-item')).toHaveCount(3)
  for (const [page] of seats) await page.getByTestId('ready-button').click()
  await expect(alice.getByTestId('start-button')).toBeEnabled()
  return { alice, bob, carol }
}

test.describe('多人局（本地传输，3 人）', () => {
  test('3 人开局自动使用四人地图，回合按顺序轮转', async ({ context }) => {
    const { alice, bob, carol } = await setupThreePlayers(context)
    await alice.getByTestId('start-button').click()
    for (const page of [alice, bob, carol]) {
      await expect(page.getByTestId('phase-label')).toHaveText('部署')
    }

    // 三人各自在角落部署一个刀盾兵
    await alice.getByTestId('deploy-sword').click()
    await clickTile(alice, 3, 5)
    await bob.getByTestId('deploy-sword').click()
    await clickTile(bob, 20, 5)
    await carol.getByTestId('deploy-sword').click()
    await clickTile(carol, 5, 20)
    for (const page of [alice, bob, carol]) {
      await expect(page.getByTestId('deploy-info')).toContainText('已放置 1/4')
    }

    for (const page of [alice, bob, carol]) await page.getByTestId('deploy-done').click()
    await expect(alice.getByTestId('phase-label')).toHaveText('行动')
    await expect(alice.getByTestId('end-turn')).toBeEnabled()
    await expect(bob.getByTestId('end-turn')).toBeDisabled()

    const state = await stateOf(alice)
    expect(state.mapId).toBe('ancient_04')
    expect(state.players).toHaveLength(3)

    // A → B → C → A（回合数 +1）
    await alice.getByTestId('end-turn').click()
    await expect(bob.getByTestId('end-turn')).toBeEnabled({ timeout: 15_000 })
    await bob.getByTestId('end-turn').click()
    await expect(carol.getByTestId('end-turn')).toBeEnabled({ timeout: 15_000 })
    await carol.getByTestId('end-turn').click()
    await expect(alice.getByTestId('end-turn')).toBeEnabled({ timeout: 15_000 })
    await expect(alice.getByTestId('round-label')).toHaveText('2')
  })

  test('淘汰制：第三人投降后对局继续，最后一人获胜', async ({ context }) => {
    const { alice, bob, carol } = await setupThreePlayers(context)
    await alice.getByTestId('start-button').click()
    for (const page of [alice, bob, carol]) {
      await expect(page.getByTestId('phase-label')).toHaveText('部署')
    }
    await alice.getByTestId('deploy-sword').click()
    await clickTile(alice, 3, 5)
    await bob.getByTestId('deploy-sword').click()
    await clickTile(bob, 20, 5)
    await carol.getByTestId('deploy-sword').click()
    await clickTile(carol, 5, 20)
    for (const page of [alice, bob, carol]) await page.getByTestId('deploy-done').click()
    await expect(alice.getByTestId('phase-label')).toHaveText('行动')

    // 丙投降 → 被淘汰，但甲、乙继续打
    await carol.getByTestId('resign-button').click()
    await expect(alice.getByTestId('game-over')).toHaveCount(0)
    await expect.poll(async () => (await stateOf(alice)).eliminated).toEqual(['mp-c'])
    await expect(alice.getByTestId('event-log')).toContainText('被淘汰')
    await expect(alice.getByTestId('eliminated-mp-c')).toBeVisible()

    // 乙投降 → 只剩甲 → 甲获胜
    await bob.getByTestId('resign-button').click()
    await expect(alice.getByTestId('game-over')).toContainText('胜利')
    await expect(alice.getByTestId('game-over')).toContainText('甲将军')
    await expect(carol.getByTestId('game-over')).toContainText('败北')
  })
})
