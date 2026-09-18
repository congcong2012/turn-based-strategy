/**
 * M3 断线重连 E2E（本地传输，真实浏览器）：
 *  - 房主刷新 → 客户端暂停 → 房主回来后恢复整局
 *  - 对手刷新 → 席位保留 → 回来后拿到最新状态
 *  - 对手关闭页面 → 轮到其回合时房主可跳过
 */
import { expect, test } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { ROOM, joinRoom, localUrl, waitForHost } from './helpers'

async function clickTile(page: Page, x: number, y: number): Promise<void> {
  const box = await page.locator('.board-host canvas').boundingBox()
  if (!box) throw new Error('canvas 不可见')
  const point = await page.evaluate(
    ([tx, ty]) => (globalThis as unknown as { __atBoard: { project: (x: number, y: number) => { x: number; y: number } } }).__atBoard.project(tx, ty),
    [x, y] as const,
  )
  await page.mouse.click(box.x + point.x, box.y + point.y)
}

async function stateOf(page: Page) {
  return page.evaluate(() => (globalThis as unknown as { __atGame: { getState: () => unknown } }).__atGame.getState()) as Promise<{
    phase: string
    turnIndex: number
    players: string[]
    units: Array<{ id: string; owner: string; x: number; y: number }>
  }>
}

/** 大厅 → 部署 → 行动（甲先手，甲已把单位移动到 (11,7)） */
async function startGameAndMove(context: BrowserContext) {
  const alice = await context.newPage()
  const bob = await context.newPage()
  await alice.goto(localUrl('p-a', '甲将军'))
  await joinRoom(alice, ROOM, '甲将军')
  await waitForHost(alice)
  await bob.goto(localUrl('p-b', '乙将军'))
  await joinRoom(bob, ROOM, '乙将军')
  await expect(alice.getByTestId('player-item')).toHaveCount(2)
  await alice.getByTestId('ready-button').click()
  await bob.getByTestId('ready-button').click()
  await expect(alice.getByTestId('start-button')).toBeEnabled()
  await alice.getByTestId('start-button').click()
  await expect(alice.getByTestId('phase-label')).toHaveText('部署')

  await alice.getByTestId('deploy-sword').click()
  await clickTile(alice, 11, 4)
  await bob.getByTestId('deploy-sword').click()
  await clickTile(bob, 11, 19)
  await alice.getByTestId('deploy-done').click()
  await bob.getByTestId('deploy-done').click()
  await expect(alice.getByTestId('phase-label')).toHaveText('行动')

  await clickTile(alice, 11, 4)
  await clickTile(alice, 11, 7)
  await expect.poll(async () => (await stateOf(alice)).units.find((u) => u.owner === 'p-a')?.y).toBe(7)
  return { alice, bob }
}

test.describe('断线重连（本地传输）', () => {
  test('房主刷新 → 客户端暂停 → 房主回来恢复整局', async ({ context }) => {
    const { alice, bob } = await startGameAndMove(context)
    const unitId = (await stateOf(alice)).units.find((u) => u.owner === 'p-a')!.id

    // 房主刷新（同一标签页：sessionStorage 保留房间码，playerId 由 ?as= 固定）
    await alice.reload()
    await expect(bob.getByTestId('pause-banner')).toBeVisible({ timeout: 20_000 })
    await expect(bob.getByTestId('pause-banner')).toContainText('房主已断线')
    await expect(bob.getByTestId('end-turn')).toBeDisabled()

    // 房主回来 → 自动恢复
    await expect(alice.getByTestId('phase-label')).toHaveText('行动', { timeout: 30_000 })
    await expect(bob.getByTestId('pause-banner')).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(async () => (await stateOf(bob)).units.find((u) => u.id === unitId)?.y).toBe(7)
    expect((await stateOf(alice)).units.find((u) => u.id === unitId)?.y).toBe(7)
  })

  test('对手刷新 → 席位保留 → 回来后继续对局', async ({ context }) => {
    const { alice, bob } = await startGameAndMove(context)

    await bob.reload()
    // 席位保留：仍是 2 人（不会因为刷新被踢出对局）
    await expect(alice.getByTestId('score-p-b')).toHaveCount(1)
    // 刷新期间是甲的回合 → 对局不被暂停（只可能有轻提示）
    await expect(alice.getByTestId('phase-label')).toHaveText('行动')
    await expect(alice.getByTestId('end-turn')).toBeEnabled()

    // 乙自动回到对局
    await expect(bob.getByTestId('phase-label')).toHaveText('行动', { timeout: 30_000 })
    await expect(alice.getByTestId('pause-banner')).toHaveCount(0, { timeout: 30_000 })
    await expect(alice.getByTestId('offline-hint')).toHaveCount(0, { timeout: 30_000 })

    // 甲结束回合后轮到乙，乙可以正常行动
    await alice.getByTestId('end-turn').click()
    await expect(bob.getByTestId('end-turn')).toBeEnabled({ timeout: 20_000 })
    await clickTile(bob, 11, 19)
    await clickTile(bob, 11, 16)
    await expect.poll(async () => (await stateOf(alice)).units.find((u) => u.owner === 'p-b')?.y).toBe(16)
  })

  test('对手关闭页面 → 轮到他时房主可跳过其回合', async ({ context }) => {
    const { alice, bob } = await startGameAndMove(context)

    await bob.close()
    await expect(alice.getByTestId('pause-banner')).toHaveCount(0, { timeout: 15_000 }) // 还是甲的回合，不暂停

    await alice.getByTestId('end-turn').click()
    await expect(alice.getByTestId('pause-banner')).toBeVisible({ timeout: 20_000 })
    await expect(alice.getByTestId('pause-banner')).toContainText('对手已断线')
    await expect(alice.getByTestId('skip-turn')).toBeVisible()

    await alice.getByTestId('skip-turn').click()
    await expect(alice.getByTestId('end-turn')).toBeEnabled({ timeout: 20_000 })
    await expect(alice.getByTestId('pause-banner')).toHaveCount(0)
    // 掉线玩家的部队仍在场上（席位与兵力都保留）
    expect((await stateOf(alice)).units.filter((u) => u.owner === 'p-b')).toHaveLength(1)
  })
})
