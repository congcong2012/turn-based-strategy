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

    // M2：开始游戏后双方进入对局界面（部署阶段）
    await alice.getByTestId('start-button').click()
    await expect(alice.getByTestId('phase-label')).toHaveText('部署')
    await expect(bob.getByTestId('phase-label')).toHaveText('部署')
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
    // 填了码后仍然是"加入或创建"：房里有人是加入，没人你就是房主
    await expect(page.getByTestId('join-button')).toHaveText('加入 / 创建房间')
    await expect(page.getByTestId('join-button')).toBeEnabled()

    await input.fill('ab1')
    await expect(input).toHaveValue('AB')
    await expect(page.getByTestId('join-button')).toBeDisabled()
    // 填了一半时给出原因，并说明"清空就能创建"（走查 F6）
    await expect(page.getByTestId('room-code-hint')).toBeVisible()
  })

  test('★ 留空直接「创建房间」：不必先点随机生成（走查 F6），首屏也不显示技术参数（F7）', async ({ page }) => {
    // localUrl 自带 `page=lobby`，直接落在大厅
    await page.goto(localUrl('cr-a', '开房的人'))
    await expect(page.getByTestId('join-panel')).toBeVisible()

    // F7：没进房前不该把「信令 / peer」糊在第一屏
    await expect(page.getByTestId('lobby-idle-hint')).toBeVisible()
    await expect(page.getByTestId('status-line')).toHaveCount(0)

    const join = page.getByTestId('join-button')
    await expect(join).toHaveText('创建房间')
    await expect(join).toBeEnabled()
    await join.click()

    // 真的开了一间房：房间码出现，身份是房主
    await expect(page.getByTestId('room-code-display')).toHaveText(/^[A-Z0-9]{6}$/)
    await waitForHost(page)
    // 进房后技术参数才出现（出问题时要靠它判断）
    await expect(page.getByTestId('status-line')).toBeVisible()
  })
  test('★ 2v2：四个席位才能开局；开局后两队各两人、同队同标', async ({ context }) => {
    const alice = await context.newPage()
    const bob = await context.newPage()

    await alice.goto(localUrl('t2-a', '甲将军'))
    await joinRoom(alice, ROOM, '甲将军')
    await waitForHost(alice)
    await bob.goto(localUrl('t2-b', '乙将军'))
    await joinRoom(bob, ROOM, '乙将军')
    await expect(alice.getByTestId('player-item')).toHaveCount(2)

    // 切 2v2：只有 2 个席位 → 说明出现，开始按钮保持禁用
    await alice.getByTestId('team-mode-select').selectOption('2v2')
    await expect(alice.getByTestId('team-mode-hint')).toBeVisible()
    await alice.getByTestId('ready-button').click()
    await bob.getByTestId('ready-button').click()
    await expect(alice.getByTestId('start-button')).toBeDisabled()

    // AI 补到 4 席 → 可开局（2 真人 + 2 AI）
    await alice.getByTestId('ai-slots-select').selectOption('4')
    await expect(alice.getByTestId('start-button')).toBeEnabled()
    await alice.getByTestId('start-button').click()
    await expect(alice.getByTestId('phase-label')).toHaveText('部署')

    // 四个队伍标签，两名真人分属不同队（对角同队：0&3 vs 1&2）
    await expect(alice.locator('[data-testid^="teamtag-"]')).toHaveCount(4)
    await expect(alice.getByTestId('teamtag-t2-a')).toHaveText(/甲队/)
    await expect(alice.getByTestId('teamtag-t2-b')).toHaveText(/乙队/)

    // 客机看到的是同一份分组
    await expect(bob.getByTestId('teamtag-t2-a')).toHaveText(/甲队/)
    await expect(bob.getByTestId('teamtag-t2-b')).toHaveText(/乙队/)
  })

})
