/**
 * 本地传输 E2E：两个标签页走 BroadcastChannel，验证大厅全部交互（不依赖公网信令）。
 * 与生产路径共用同一套 session / 协议逻辑，只替换传输层。
 */
import { expect, test } from '@playwright/test'
import { ROOM, joinRoom, localUrl, waitForHost } from './helpers'

test.describe('大厅（本地传输）', () => {
  test('两名玩家用同一房间码连接，互相看到昵称与房主标识', async ({ context }) => {
    const alice = await context.newPage()
    const bob = await context.newPage()

    await alice.goto(localUrl('p-a', '甲将军'))
    await joinRoom(alice, ROOM, '甲将军')
    await waitForHost(alice)

    await bob.goto(localUrl('p-b', '乙将军'))
    await joinRoom(bob, ROOM, '乙将军')

    // 互相看到昵称（就是验收标准里的"两个浏览器看到彼此昵称"）
    await expect(alice.getByTestId('player-item')).toHaveCount(2)
    await expect(bob.getByTestId('player-item')).toHaveCount(2)
    await expect(alice.getByTestId('player-list')).toContainText('乙将军')
    await expect(bob.getByTestId('player-list')).toContainText('甲将军')

    // 房主标识正确：第一个加入者 alice 有，bob 没有
    await expect(
      alice.getByTestId('player-item').filter({ hasText: '甲将军' }).getByTestId('host-badge'),
    ).toBeVisible()
    await expect(
      bob.getByTestId('player-item').filter({ hasText: '乙将军' }).getByTestId('host-badge'),
    ).toHaveCount(0)
    await expect(bob.getByTestId('role-label')).toHaveText('你是玩家')
  })

  test('准备状态同步：全员准备后房主可开始游戏', async ({ context }) => {
    const alice = await context.newPage()
    const bob = await context.newPage()

    await alice.goto(localUrl('p-a', '甲将军'))
    await joinRoom(alice, ROOM, '甲将军')
    await waitForHost(alice)
    await bob.goto(localUrl('p-b', '乙将军'))
    await joinRoom(bob, ROOM, '乙将军')
    await expect(alice.getByTestId('player-item')).toHaveCount(2)

    await expect(alice.getByTestId('start-button')).toBeDisabled()

    await alice.getByTestId('ready-button').click()
    await expect(alice.getByTestId('start-button')).toBeDisabled() // bob 还没准备

    await bob.getByTestId('ready-button').click()
    // 注意：列表里房主排第一，必须按行定位，不能用 .first()
    await expect(
      bob.getByTestId('player-item').filter({ hasText: '乙将军' }).getByTestId('ready-badge'),
    ).toHaveText('✓ 已准备')
    await expect(
      alice.getByTestId('player-item').filter({ hasText: '乙将军' }),
    ).toHaveAttribute('data-ready', 'true')
    await expect(alice.getByTestId('start-button')).toBeEnabled()

    await alice.getByTestId('start-button').click()
    await expect(alice.getByTestId('notice')).toContainText('M2')
    await expect(bob.getByTestId('notice')).toContainText('M2')
  })

  test('刷新页面后自动重新加入，且不产生重复玩家', async ({ context }) => {
    const alice = await context.newPage()
    const bob = await context.newPage()

    await alice.goto(localUrl('p-a', '甲将军'))
    await joinRoom(alice, ROOM, '甲将军')
    await waitForHost(alice)
    await bob.goto(localUrl('p-b', '乙将军'))
    await joinRoom(bob, ROOM, '乙将军')
    await expect(alice.getByTestId('player-item')).toHaveCount(2)

    await bob.getByTestId('ready-button').click()
    await expect(
      alice.getByTestId('player-item').filter({ hasText: '乙将军' }),
    ).toHaveAttribute('data-ready', 'true')

    await bob.reload()

    // 自动回到房间（不再需要重新输入房间码）
    await expect(bob.getByTestId('room-code-display')).toHaveText(ROOM)
    await expect(bob.getByTestId('player-item')).toHaveCount(2)
    await expect(alice.getByTestId('player-item')).toHaveCount(2)
    await expect(alice.getByTestId('player-list')).toContainText('乙将军')

    // 重连后准备状态重置（房主重新收集意图）
    await expect(
      bob.getByTestId('player-item').filter({ hasText: '乙将军' }).getByTestId('ready-badge'),
    ).toHaveText('未准备')
  })

  test('玩家关闭页面 → 列表移除；房主关闭 → 剩余玩家接管', async ({ context }) => {
    const alice = await context.newPage()
    const bob = await context.newPage()

    await alice.goto(localUrl('p-a', '甲将军'))
    await joinRoom(alice, ROOM, '甲将军')
    await waitForHost(alice)
    await bob.goto(localUrl('p-b', '乙将军'))
    await joinRoom(bob, ROOM, '乙将军')
    await expect(alice.getByTestId('player-item')).toHaveCount(2)

    await bob.close()
    await expect(alice.getByTestId('player-item')).toHaveCount(1, { timeout: 10_000 })

    await alice.close()
    // 房主掉线：剩余的 bob 已在上面关闭 → 这里用第三个页面验证接管
    const carol = await context.newPage()
    await carol.goto(localUrl('p-c', '丙将军'))
    await joinRoom(carol, ROOM, '丙将军')
    await waitForHost(carol, 15_000)
    await expect(carol.getByTestId('player-item')).toHaveCount(1)
  })

  test('房主掉线后，剩余玩家在宽限期后接管房主', async ({ context }) => {
    const alice = await context.newPage()
    const bob = await context.newPage()

    await alice.goto(localUrl('p-a', '甲将军'))
    await joinRoom(alice, ROOM, '甲将军')
    await waitForHost(alice)
    await bob.goto(localUrl('p-b', '乙将军'))
    await joinRoom(bob, ROOM, '乙将军')
    await expect(bob.getByTestId('role-label')).toHaveText('你是玩家')

    await alice.close()

    await expect(bob.getByTestId('role-label')).toHaveText('你是房主', { timeout: 20_000 })
    await expect(bob.getByTestId('player-item')).toHaveCount(1)
  })

  test('房间码输入会被归一化，非法码不能加入', async ({ page }) => {
    await page.goto(localUrl('p-a', '甲将军'))
    const input = page.getByTestId('room-code-input')

    await input.fill('ab23cd')
    await expect(input).toHaveValue('AB23CD')
    await expect(page.getByTestId('join-button')).toBeEnabled()

    await input.fill('ab1')
    await expect(input).toHaveValue('AB')
    await expect(page.getByTestId('join-button')).toBeDisabled()
  })
})
