/**
 * v1.0.0 发版验收（本地传输版）：主页 / 规则速查 / 捐赠 / 版本号 / 房间密码。
 * 这些是「发版回归清单」里可自动化的部分，每次发版必须全绿。
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { ROOM, joinRoom, localHomeUrl, localUrl, waitForHost } from './helpers'

/** 页面上不该出现横向滚动条（手机上最容易出问题的地方） */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
}

test.describe('主页 / 规则速查 / 单人练习', () => {
  test('主页三个入口可用，规则速查表格来自数据文件', async ({ page }) => {
    await page.goto(localHomeUrl('r-a', '甲将军'))

    // 主页 = 默认落地页（不再直接甩进大厅）
    await expect(page.getByTestId('entry-online')).toBeVisible()
    await expect(page.getByTestId('entry-pve')).toBeVisible()
    await expect(page.getByTestId('entry-rules')).toBeVisible()
    await expect(page.getByTestId('version-line')).toContainText('v')
    await expect(page.getByTestId('donate-button')).toBeVisible()

    // 单人练习：明确标注"开发中"，点击给出说明弹层
    await expect(page.getByTestId('entry-pve')).toContainText('开发中')
    await page.getByTestId('entry-pve').click()
    await expect(page.getByTestId('pve-dialog')).toBeVisible()
    await expect(page.getByTestId('pve-dialog')).toContainText('AI 对手')
    await page.getByTestId('pve-dialog').getByRole('button', { name: '知道了' }).click()
    await expect(page.getByTestId('pve-dialog')).toHaveCount(0)

    // 规则速查
    await page.getByTestId('entry-rules').click()
    await expect(page.getByTestId('rules-units')).toBeVisible()
    await expect(page.getByTestId('rules-matchup')).toBeVisible()
    await expect(page.getByTestId('rules-terrain')).toBeVisible()
    await expect(page.getByTestId('rules-units')).toContainText('刀盾兵')
    await page.getByRole('button', { name: '返回主页' }).click()
    await expect(page.getByTestId('entry-online')).toBeVisible()

    // 联机对战 → 大厅
    await page.getByTestId('entry-online').click()
    await expect(page.getByTestId('join-panel')).toBeVisible()
  })

  test('旧邀请链接（?room=）依然直接进大厅，不被主页拦截', async ({ page }) => {
    await page.goto('/?transport=local&as=r-b&nick=甲将军&room=AB23CD')
    await expect(page.getByTestId('join-panel')).toBeVisible()
    await expect(page.getByTestId('room-code-input')).toHaveValue('AB23CD')
  })
})

test.describe('大厅', () => {
  test('可以一键返回主页，且不再残留里程碑过时文案', async ({ page }) => {
    await page.goto(localUrl('r-j', '甲将军'))
    await expect(page.getByTestId('join-panel')).toBeVisible()
    // 大厅顶部写的是当前玩法，不是"里程碑 M1…"
    await expect(page.locator('.app-header')).not.toContainText('里程碑')
    await expect(page.locator('.app-header')).toContainText('房主')

    await page.getByTestId('back-home').click()
    await expect(page.getByTestId('entry-online')).toBeVisible()
    await expect(page.getByTestId('version-line')).toContainText('v')
  })
})

test.describe('捐赠与版本号', () => {
  test('点击捐赠按钮显示收款码，图片真的加载成功（子路径 base 正确）', async ({ page }) => {
    await page.goto(localUrl('r-c', '甲将军'))
    await page.getByTestId('donate-button').click()
    await expect(page.getByTestId('donate-dialog')).toBeVisible()
    await expect(page.getByTestId('donate-dialog')).toContainText('请我喝杯茶')

    const qr = page.getByTestId('donate-qrcode')
    await expect(qr).toBeVisible()
    await expect
      .poll(() => qr.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 })
      .toBeGreaterThan(0)

    await page.getByTestId('donate-close').click()
    await expect(page.getByTestId('donate-dialog')).toHaveCount(0)
  })

  test('诊断信息里带版本号与页面地址（发给房主就能定位版本）', async ({ page }) => {
    await page.goto(localUrl('r-d', '甲将军'))
    await page.getByTestId('diagnostics').click()
    await expect(page.getByTestId('diagnostics-body')).toContainText('版本: v')
    await expect(page.getByTestId('diagnostics-body')).toContainText('页面: http')
  })
})

test.describe('手机布局（393px 竖屏）', () => {
  test.use({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })

  test('主页 / 规则速查 / 捐赠弹层在手机宽度下不横向溢出，内容都在屏内', async ({ page }) => {
    await page.goto(localHomeUrl('r-h', '甲将军'))
    await expect(page.getByTestId('entry-online')).toBeVisible()
    await expect(page.getByTestId('donate-button')).toBeVisible()
    await expectNoHorizontalOverflow(page)

    // 三个入口都完整落在视口里
    for (const id of ['entry-online', 'entry-pve', 'entry-rules']) {
      const box = await page.getByTestId(id).boundingBox()
      expect(box, id + ' 应该有布局盒').not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(-1)
      expect(box!.x + box!.width).toBeLessThanOrEqual(394)
      expect(box!.height).toBeGreaterThan(40)
    }

    await page.getByTestId('entry-rules').click()
    await expect(page.getByTestId('rules-units')).toBeVisible()
    await expectNoHorizontalOverflow(page)

    await page.getByRole('button', { name: '返回主页' }).click()
    await page.getByTestId('donate-button').click()
    const qr = page.getByTestId('donate-qrcode')
    await expect(qr).toBeVisible()
    await expect
      .poll(() => qr.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 })
      .toBeGreaterThan(0)
    const qrBox = await qr.boundingBox()
    expect(qrBox!.x).toBeGreaterThanOrEqual(0)
    expect(qrBox!.x + qrBox!.width).toBeLessThanOrEqual(394)
    await expectNoHorizontalOverflow(page)
  })
})

test.describe('房间密码', () => {
  test('加密房：邀请链接带 key，好友用链接进入自动填入密码并成功入房', async ({ context }) => {
    const alice = await context.newPage()
    // 拦下剪贴板写入，检查邀请链接里确实带了密码
    await alice.addInitScript(() => {
      const w = window as unknown as { __copied: string }
      w.__copied = ''
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text: string) => {
            w.__copied = text
            return Promise.resolve()
          },
        },
      })
    })

    await alice.goto(localUrl('r-e', '甲将军'))
    await alice.getByTestId('room-password-input').fill('tea-2024')
    await joinRoom(alice, ROOM, '甲将军')
    await waitForHost(alice)

    await expect(alice.getByTestId('password-badge')).toHaveText('已加密')
    await expect(alice.getByTestId('password-hint')).toBeVisible()

    await alice.getByTestId('copy-link-button').click()
    const link = await alice.evaluate(() => (window as unknown as { __copied: string }).__copied)
    expect(link).toContain('room=' + ROOM)
    expect(link).toContain('key=tea-2024')

    // 好友点开邀请链接：房间码 + 密码自动填好（DEV 下额外加回本地传输参数）
    const bob = await context.newPage()
    await bob.goto('/?transport=local&as=r-f&nick=' + encodeURIComponent('乙将军') + '&room=' + ROOM + '&key=tea-2024')
    await expect(bob.getByTestId('room-code-input')).toHaveValue(ROOM)
    await expect(bob.getByTestId('room-password-input')).toHaveValue('tea-2024')

    await bob.getByTestId('nickname-input').fill('乙将军')
    await bob.getByTestId('join-button').click()
    await expect(bob.getByTestId('room-code-display')).toHaveText(ROOM)
    await expect(bob.getByTestId('password-badge')).toHaveText('已加密')

    // 双方互相可见（本地传输不校验密码，密码语义由 Trystero 的密钥派生保证）
    await expect(alice.getByTestId('player-item')).toHaveCount(2)
    await expect(bob.getByTestId('player-list')).toContainText('甲将军')
  })

  test('用邀请链接进来的标签页，刷新后自动回到房间（不再需要重新点加入）', async ({ context }) => {
    const page = await context.newPage()
    // 模拟好友：从邀请链接进入（DEV 下额外带本地传输参数）
    await page.goto('/?transport=local&as=r-i&nick=' + encodeURIComponent('乙将军') + '&room=' + ROOM + '&key=tea-2024')
    await expect(page.getByTestId('room-code-input')).toHaveValue(ROOM)
    await page.getByTestId('join-button').click()
    await expect(page.getByTestId('room-code-display')).toHaveText(ROOM)

    await page.reload()
    // 链接里就是刚才那个房间 → 自动回去（并复用记住的密码）
    await expect(page.getByTestId('room-code-display')).toHaveText(ROOM)
    await expect(page.getByTestId('password-badge')).toHaveText('已加密')
  })

  test('无密码房间：不显示加密徽章，邀请链接里没有 key', async ({ context }) => {
    const page = await context.newPage()
    await page.addInitScript(() => {
      const w = window as unknown as { __copied: string }
      w.__copied = ''
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text: string) => {
            w.__copied = text
            return Promise.resolve()
          },
        },
      })
    })
    await page.goto(localUrl('r-g', '甲将军'))
    await joinRoom(page, ROOM, '甲将军')
    await waitForHost(page)

    await expect(page.getByTestId('password-badge')).toHaveCount(0)
    await page.getByTestId('copy-link-button').click()
    const link = await page.evaluate(() => (window as unknown as { __copied: string }).__copied)
    expect(link).toContain('room=' + ROOM)
    expect(link).not.toContain('key=')
  })
})
