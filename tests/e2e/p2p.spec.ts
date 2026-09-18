/**
 * 真实 P2P E2E：两个独立浏览器上下文（各自 localStorage = 两个不同玩家），
 * 通过 Trystero + 公共 MQTT 信令建立 WebRTC DataChannel。
 * 需要能访问 broker.emqx.io / broker.hivemq.com。
 */
import { expect, test } from '@playwright/test'
import { joinRoom, randomRoom, waitForHost } from './helpers'
import type { BrowserContext } from '@playwright/test'

async function newPlayer(context: BrowserContext, nickname: string, room: string) {
  const page = await context.newPage()
  await page.goto('/')
  await joinRoom(page, room, nickname)
  return page
}

test.describe('真实 P2P（Trystero + 公共 MQTT 信令）', () => {
  test('两个浏览器上下文用同一房间码互相可见，刷新后仍能重连', async ({ browser }) => {
    test.setTimeout(180_000)
    const room = randomRoom()
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()

    const alice = await newPlayer(ctxA, '甲将军', room)
    await waitForHost(alice, 30_000)

    const bob = await newPlayer(ctxB, '乙将军', room)

    await expect(alice.getByTestId('player-item')).toHaveCount(2, { timeout: 60_000 })
    await expect(bob.getByTestId('player-item')).toHaveCount(2, { timeout: 60_000 })
    await expect(alice.getByTestId('player-list')).toContainText('乙将军')
    await expect(bob.getByTestId('player-list')).toContainText('甲将军')
    await expect(
      alice.getByTestId('player-item').filter({ hasText: '甲将军' }).getByTestId('host-badge'),
    ).toBeVisible()

    // 准备状态经真实 P2P 同步
    await bob.getByTestId('ready-button').click()
    await expect(alice.getByTestId('player-item').filter({ hasText: '乙将军' })).toHaveAttribute(
      'data-ready',
      'true',
      { timeout: 30_000 },
    )

    // 刷新重连：localStorage 身份保留，无重复玩家
    await bob.reload()
    await expect(bob.getByTestId('room-code-display')).toHaveText(room, { timeout: 30_000 })
    await expect(alice.getByTestId('player-item')).toHaveCount(2, { timeout: 60_000 })
    await expect(bob.getByTestId('player-item')).toHaveCount(2, { timeout: 60_000 })

    await ctxA.close()
    await ctxB.close()
  })
})
