/**
 * M7 连接状态指示 E2E：等待对手 → 已连接 → 重连中，以及诊断面板内容。
 */
import { expect, test } from '@playwright/test'
import { ROOM, joinRoom, localUrl, waitForHost } from './helpers'

test.describe('连接状态指示（本地传输）', () => {
  test('状态徽章随连接情况变化，诊断面板可复制', async ({ context }) => {
    const alice = await context.newPage()
    await alice.goto(localUrl('cs-a', '甲将军'))
    await joinRoom(alice, ROOM, '甲将军')
    await waitForHost(alice)

    // 一个人时：信令已连上，等对手进房
    await expect(alice.getByTestId('connection-badge')).toHaveAttribute('data-state', 'waiting', { timeout: 15_000 })
    await expect(alice.getByTestId('connection-text')).toHaveText('等待对手加入')

    // 对手进来 → 已连接
    const bob = await context.newPage()
    await bob.goto(localUrl('cs-b', '乙将军'))
    await joinRoom(bob, ROOM, '乙将军')
    await expect(alice.getByTestId('player-item')).toHaveCount(2)
    await expect(alice.getByTestId('connection-badge')).toHaveAttribute('data-state', 'connected', { timeout: 20_000 })
    await expect(alice.getByTestId('connection-text')).toHaveText('已连接')

    // 诊断面板能看到房间码、玩家与状态
    await alice.getByTestId('diagnostics').click()
    const body = await alice.getByTestId('diagnostics-body').textContent()
    expect(body).toContain(ROOM)
    expect(body).toContain('乙将军')
    expect(body).toContain('已连接')

    // 对手关掉页面 → 名单里还有他 → 重连中（并给出备用方案入口）
    await bob.close()
    await expect(alice.getByTestId('player-item')).toHaveCount(1)
    await expect(alice.getByTestId('connection-badge')).toHaveAttribute('data-state', 'waiting', { timeout: 20_000 })
  })

  test('信令策略可一键切换（失败时的降级入口）', async ({ context }) => {
    const alice = await context.newPage()
    await alice.goto(localUrl('cs-c', '甲将军'))
    await joinRoom(alice, ROOM, '甲将军')
    await waitForHost(alice)
    await expect(alice.getByTestId('strategy-label')).toHaveText('MQTT')
    await alice.getByTestId('strategy-select').selectOption('torrent')
    await expect(alice.getByTestId('strategy-label')).toHaveText('Torrent')
    // 切换信令会重连回同一个房间
    await expect(alice.getByTestId('room-code-display')).toHaveText(ROOM, { timeout: 20_000 })
  })
})
