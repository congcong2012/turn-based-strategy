/**
 * M7 手动直连 E2E：公共信令完全不参与，两端通过复制粘贴连接码建立真实 WebRTC 直连，
 * 之后大厅与对局流程与正常房间完全一致。
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { ROOM } from './helpers'

async function openJoinPanel(page: Page, nickname: string) {
  await page.goto('/?debug=1&page=lobby')
  await page.getByTestId('nickname-input').fill(nickname)
  await page.getByTestId('room-code-input').fill(ROOM)
  await page.getByTestId('mode-manual').click()
}

test.describe('手动直连（无公共信令）', () => {
  test('复制粘贴连接码即可建立直连并正常开局', async ({ browser }) => {
    test.setTimeout(180_000)
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const alice = await ctxA.newPage()
    const bob = await ctxB.newPage()
    const problems: string[] = []
    for (const page of [alice, bob]) {
      page.on('pageerror', (e) => problems.push(String(e.message).slice(0, 200)))
    }

    // 房主生成邀请码
    await openJoinPanel(alice, '甲将军')
    await alice.getByTestId('manual-host').click()
    await expect(alice.getByTestId('manual-code')).toBeVisible({ timeout: 30_000 })
    const offerCode = await alice.getByTestId('manual-code').inputValue()
    expect(offerCode.startsWith('AT1:')).toBe(true)
    expect(offerCode.length).toBeGreaterThan(200)

    // 好友粘贴邀请码 → 得到应答码
    await openJoinPanel(bob, '乙将军')
    await bob.getByTestId('manual-guest').click()
    await expect(bob.getByTestId('manual-input')).toBeVisible({ timeout: 20_000 })
    await bob.getByTestId('manual-input').fill(offerCode)
    await bob.getByTestId('manual-submit').click()
    await expect(bob.getByTestId('manual-code')).toBeVisible({ timeout: 30_000 })
    const answerCode = await bob.getByTestId('manual-code').inputValue()
    expect(answerCode.startsWith('AT1:')).toBe(true)

    // 房主粘贴应答码 → 完成连接
    await alice.getByTestId('manual-input').fill(answerCode)
    await alice.getByTestId('manual-submit').click()

    // 双方进入房间并看到彼此
    await expect(alice.getByTestId('player-item')).toHaveCount(2, { timeout: 60_000 })
    await expect(bob.getByTestId('player-item')).toHaveCount(2, { timeout: 60_000 })
    await expect(alice.getByTestId('connection-badge')).toHaveAttribute('data-state', 'connected')
    await expect(bob.getByTestId('connection-badge')).toHaveAttribute('data-state', 'connected')
    await expect(alice.getByTestId('player-list')).toContainText('乙将军')

    // 直连之上照常开局
    await alice.getByTestId('ready-button').click()
    await bob.getByTestId('ready-button').click()
    await expect(alice.getByTestId('start-button')).toBeEnabled({ timeout: 20_000 })
    await alice.getByTestId('start-button').click()
    await expect(alice.getByTestId('phase-label')).toHaveText('部署', { timeout: 30_000 })
    await expect(bob.getByTestId('phase-label')).toHaveText('部署', { timeout: 30_000 })

    expect(problems).toEqual([])
    await ctxA.close()
    await ctxB.close()
  })
})
