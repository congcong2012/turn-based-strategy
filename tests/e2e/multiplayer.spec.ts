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
    page.on('pageerror', (e) => console.log('[' + nick + ' pageerror]', String(e.message).slice(0, 400)))
    page.on('console', (m) => { if (m.type() === 'error') console.log('[' + nick + ' console]', m.text().slice(0, 300)) })
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

test.describe('AI 补位与观战（本地传输）', () => {
  test('★ AI 补位：2 名真人选「共 4 方」→ 开局多出两个 AI，且 AI 自己会部署', async ({ context }) => {
    const alice = await context.newPage()
    const bob = await context.newPage()
    await alice.goto(localUrl('ab-a', '甲将军'))
    await joinRoom(alice, ROOM, '甲将军')
    await waitForHost(alice)
    await bob.goto(localUrl('ab-b', '乙将军'))
    await joinRoom(bob, ROOM, '乙将军')
    await expect(alice.getByTestId('player-item')).toHaveCount(2)

    // 房主把 AI 补位设成"共 4 方"
    await alice.getByTestId('ai-slots-select').selectOption('4')
    await expect(alice.getByTestId('ai-slots-hint')).toContainText('补 2 个 AI')
    // 客机也能看到这个设置（走 lobby 快照同步）
    await expect(bob.getByTestId('ai-slots-label')).toContainText('共 4 方')

    await alice.getByTestId('ready-button').click()
    await bob.getByTestId('ready-button').click()
    await expect(alice.getByTestId('start-button')).toBeEnabled()
    await alice.getByTestId('start-button').click()
    await expect(alice.getByTestId('phase-label')).toHaveText('部署')

    // 4 方：2 真人 + 2 AI
    await expect.poll(async () => (await stateOf(alice)).players.length, { timeout: 15_000 }).toBe(4)
    const players = (await stateOf(alice)).players
    expect(players.filter((p) => p.startsWith('ai-'))).toHaveLength(2)
    expect((await stateOf(bob)).players).toEqual(players)

    // AI 席位自动完成部署（不需要任何人操作）
    await expect
      .poll(
        async () => {
          const state = await stateOf(alice)
          return players.filter((p) => p.startsWith('ai-')).every((p) => (state.units.filter((u) => u.owner === p).length ?? 0) > 0)
        },
        { timeout: 20_000 },
      )
      .toBe(true)
  })

  test('★ 观战：不占席位、能看到对局，但界面上没有可操作按钮', async ({ context }) => {
    const alice = await context.newPage()
    const bob = await context.newPage()
    await alice.goto(localUrl('sp-a', '甲将军'))
    await joinRoom(alice, ROOM, '甲将军')
    await waitForHost(alice)
    await bob.goto(localUrl('sp-b', '乙将军'))
    await joinRoom(bob, ROOM, '乙将军')
    await expect(alice.getByTestId('player-item')).toHaveCount(2)

    await alice.getByTestId('ready-button').click()
    await bob.getByTestId('ready-button').click()
    await expect(alice.getByTestId('start-button')).toBeEnabled()
    await alice.getByTestId('start-button').click()
    await expect(alice.getByTestId('phase-label')).toHaveText('部署')

    // 第三人以观战身份进入（此时房间已有 2 人、对局已开始）
    const watcher = await context.newPage()
    await watcher.goto(localUrl('sp-c', '看客'))
    await watcher.getByTestId('nickname-input').fill('看客')
    await watcher.getByTestId('room-code-input').fill(ROOM)
    await watcher.getByTestId('spectate-button').click()

    // 观战者能看到对局（本作没有战争迷雾），并有明确的只读标识
    await expect(watcher.getByTestId('phase-label')).toHaveText('部署', { timeout: 20_000 })
    await expect(watcher.getByTestId('spectator-badge')).toBeVisible()
    await expect(watcher.getByTestId('spectator-hint')).toContainText('只能看')
    // 观战者不能放兵（部署面板里的兵种按钮一律不可用）
    await expect(watcher.getByTestId('deploy-sword')).toBeDisabled()
    await expect(watcher.getByTestId('deploy-done')).toBeDisabled()

    // 参战席位不受影响：仍然是 2 名玩家
    expect((await stateOf(alice)).players).toEqual(['sp-a', 'sp-b'])
  })

  test('★ 观战者的结算文案是中性的「对局结束」，而不是「败北」', async ({ context }) => {
    const alice = await context.newPage()
    const bob = await context.newPage()
    await alice.goto(localUrl('sp2-a', '甲将军'))
    await joinRoom(alice, ROOM, '甲将军')
    await waitForHost(alice)
    await bob.goto(localUrl('sp2-b', '乙将军'))
    await joinRoom(bob, ROOM, '乙将军')
    await expect(alice.getByTestId('player-item')).toHaveCount(2)

    await alice.getByTestId('ready-button').click()
    await bob.getByTestId('ready-button').click()
    await expect(alice.getByTestId('start-button')).toBeEnabled()
    await alice.getByTestId('start-button').click()
    await expect(alice.getByTestId('phase-label')).toHaveText('部署')

    const watcher = await context.newPage()
    await watcher.goto(localUrl('sp2-c', '看客'))
    await watcher.getByTestId('nickname-input').fill('看客')
    await watcher.getByTestId('room-code-input').fill(ROOM)
    await watcher.getByTestId('spectate-button').click()
    await expect(watcher.getByTestId('spectator-badge')).toBeVisible({ timeout: 20_000 })

    // 双方各部署一个兵并确认 → 进入行动阶段（认输按钮只在行动阶段渲染）
    await alice.getByTestId('deploy-sword').click()
    await clickTile(alice, 11, 4)
    await bob.getByTestId('deploy-sword').click()
    await clickTile(bob, 11, 19)
    await alice.getByTestId('deploy-done').click()
    await bob.getByTestId('deploy-done').click()
    await expect(alice.getByTestId('phase-label')).toHaveText('行动')

    // 甲将军认输 → 终局。观战者不属于任何一方，不能按"我方是否获胜"判胜负
    await alice.getByTestId('resign-button').click()
    await expect(watcher.getByTestId('game-over')).toBeVisible({ timeout: 20_000 })
    await expect(watcher.getByTestId('game-over-title')).toHaveText('对局结束')
    // 观战者也能看战绩，且没有任何一行被标成"我方"
    await expect(watcher.getByTestId('battle-tally')).toBeVisible()
    await expect(watcher.locator('.tally-table tr.tally-self')).toHaveCount(0)

    // 对照：参战者自己看到的是胜负文案
    await expect(alice.getByTestId('game-over-title')).toHaveText('败北')
  })
})
