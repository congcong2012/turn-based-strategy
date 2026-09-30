/**
 * 线上自检：对**已部署的站点**跑一遍用户可见的关键路径（真实公网信令）。
 *
 *   node scripts/verify-live.mjs                        # 默认检查 GitHub Pages 线上地址
 *   LIVE_URL=http://127.0.0.1:4180/turn-based-strategy/ node scripts/verify-live.mjs
 *
 * 覆盖：主页三入口 / PVE 占位弹层 / 规则速查 / 捐赠二维码真实加载 / 版本号 /
 *      房间密码（邀请链接带 key、好友点开即入房、密码不一致配不上对）/ 刷新重连。
 * 退出码 0 = 全部通过。发版清单 docs/release-checklist.md 的第 9 步用它。
 */
import { chromium } from '@playwright/test'

const BASE = process.env.LIVE_URL ?? 'https://congcong2012.github.io/turn-based-strategy/'
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const rand = (n) => Array.from({ length: n }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('')
const ROOM = rand(6)
const PASSWORD = 'tea-' + rand(4).toLowerCase()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const problems = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  ' + detail : ''))
  if (!ok) problems.push(name + ' ' + detail)
}

setTimeout(() => {
  console.log('!! 线上自检超时，强制退出')
  process.exit(3)
}, 420000)

console.log('线上自检：' + BASE + '（房间 ' + ROOM + '）')

const browser = await chromium.launch()
const contextA = await browser.newContext()
const pageA = await contextA.newPage()
// 拦下剪贴板写入，用于检查邀请链接内容（必须在首次导航前注册）
await pageA.addInitScript(() => {
  window.__copied = ''
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text) => {
        window.__copied = text
        return Promise.resolve()
      },
    },
  })
})

try {
  // ---------- 1. 主页 ----------
  await pageA.goto(BASE, { waitUntil: 'domcontentloaded' })
  const homeErrors = []
  pageA.on('pageerror', (e) => homeErrors.push(String(e.message)))
  await pageA.waitForSelector('[data-testid=entry-online]', { timeout: 30000 })
  check('主页默认落地（三个入口）', await pageA.locator('[data-testid=entry-online]').isVisible())
  check('主页有规则速查入口', await pageA.locator('[data-testid=entry-rules]').isVisible())
  check('页脚有捐赠按钮', await pageA.locator('[data-testid=donate-button]').isVisible())
  const version = (await pageA.locator('[data-testid=version-line]').innerText()).trim()
  check('页脚显示版本号', /v\d+\.\d+\.\d+/.test(version), version.slice(0, 60))

  // ---------- 2. PVE 占位 ----------
  await pageA.locator('[data-testid=entry-pve]').click()
  await pageA.waitForSelector('[data-testid=pve-dialog]', { timeout: 10000 })
  const pveText = await pageA.locator('[data-testid=pve-dialog]').innerText()
  check('单人练习是"开发中"占位且有说明弹层', pveText.includes('开发中'))
  await pageA.locator('[data-testid=pve-dialog]').getByRole('button', { name: '知道了' }).click()
  await pageA.waitForSelector('[data-testid=pve-dialog]', { state: 'detached', timeout: 10000 })

  // ---------- 3. 规则速查 ----------
  await pageA.locator('[data-testid=entry-rules]').click()
  await pageA.waitForSelector('[data-testid=rules-units]', { timeout: 10000 })
  const rulesText = await pageA.locator('[data-testid=rules-units]').innerText()
  check('规则速查表格有真实数据', rulesText.includes('刀盾兵') && rulesText.includes('投石车'))

  // 规则速查 = 对局数值的同一份数据源：刀盾兵反步兵专精的数值必须原样出现
  const swordRow = (
    await pageA.locator('[data-testid=rules-matchup] tbody tr').first().locator('td').allInnerTexts()
  )
    .join(',')
    .replace(/\s+/g, '')
  check('规则速查里的刀盾兵克制数值与数据一致', swordRow === '55,75,80,45,12,70', swordRow)
  await pageA.getByRole('button', { name: '返回主页' }).click()
  await pageA.waitForSelector('[data-testid=entry-online]', { timeout: 10000 })

  // ---------- 4. 捐赠二维码 ----------
  await pageA.locator('[data-testid=donate-button]').click()
  const qr = pageA.locator('[data-testid=donate-qrcode]')
  await qr.waitFor({ timeout: 10000 })
  let qrWidth = 0
  for (let i = 0; i < 20 && qrWidth === 0; i += 1) {
    qrWidth = await qr.evaluate((el) => el.naturalWidth)
    if (qrWidth === 0) await sleep(500)
  }
  check('收款码图片真实加载', qrWidth > 0, qrWidth + 'px')
  await pageA.locator('[data-testid=donate-close]').click()

  // ---------- 5. 加密房 + 邀请链接 ----------
  await pageA.locator('[data-testid=entry-online]').click()
  await pageA.waitForSelector('[data-testid=join-panel]', { timeout: 10000 })

  // 大厅顶部的文案必须是当前玩法，而不是开发过程中的里程碑说明
  const lobbyHeader = await pageA.locator('.app-header').innerText()
  check('大厅顶部无过时过程文案', !lobbyHeader.includes('里程碑') && lobbyHeader.includes('房主'), lobbyHeader.split('\n')[0])

  // 大厅可以一键返回主页（v1.1.0：之前只能靠浏览器后退）
  await pageA.locator('[data-testid=back-home]').click()
  await pageA.waitForSelector('[data-testid=entry-online]', { timeout: 10000 })
  check('大厅可返回主页', true)
  await pageA.locator('[data-testid=entry-online]').click()
  await pageA.waitForSelector('[data-testid=join-panel]', { timeout: 10000 })
  await pageA.locator('[data-testid=nickname-input]').fill('线上甲将军')
  await pageA.locator('[data-testid=room-code-input]').fill(ROOM)
  await pageA.locator('[data-testid=room-password-input]').fill(PASSWORD)
  await pageA.locator('[data-testid=join-button]').click()
  await pageA.waitForSelector('[data-testid=room-code-display]', { timeout: 30000 })
  await pageA.waitForFunction(
    () => document.querySelector('[data-testid=role-label]')?.textContent === '你是房主',
    undefined,
    { timeout: 40000 },
  )
  check('加密房创建成功（房主）', await pageA.locator('[data-testid=password-badge]').isVisible())
  await pageA.locator('[data-testid=copy-link-button]').click()
  await sleep(500)
  const link = await pageA.evaluate(() => window.__copied)
  check('邀请链接带房间码与密码', link.includes('room=' + ROOM) && link.includes('key=' + PASSWORD), link.slice(0, 80))

  // ---------- 6. 好友用邀请链接入房（真实 P2P + 密码） ----------
  const contextB = await browser.newContext()
  const pageB = await contextB.newPage()
  const errorsB = []
  pageB.on('pageerror', (e) => errorsB.push(String(e.message)))
  await pageB.goto(link, { waitUntil: 'domcontentloaded' })
  await pageB.waitForSelector('[data-testid=room-code-input]', { timeout: 30000 })
  check('邀请链接自动预填房间码', (await pageB.locator('[data-testid=room-code-input]').inputValue()) === ROOM)
  check('邀请链接自动预填密码', (await pageB.locator('[data-testid=room-password-input]').inputValue()) === PASSWORD)
  await pageB.locator('[data-testid=nickname-input]').fill('线上乙将军')
  await pageB.locator('[data-testid=join-button]').click()
  await pageB.waitForSelector('[data-testid=room-code-display]', { timeout: 30000 })
  await pageA.waitForFunction(
    () => document.querySelectorAll('[data-testid=player-item]').length === 2,
    undefined,
    { timeout: 60000 },
  )
  await pageB.waitForFunction(
    () => document.querySelectorAll('[data-testid=player-item]').length === 2,
    undefined,
    { timeout: 60000 },
  )
  const listA = await pageA.locator('[data-testid=player-list]').innerText()
  const listB = await pageB.locator('[data-testid=player-list]').innerText()
  check('正确密码下双方互相可见', listA.includes('线上乙将军') && listB.includes('线上甲将军'))

  // ---------- 7. 密码不一致 → 配不上对（且不报错） ----------
  const contextC = await browser.newContext()
  const pageC = await contextC.newPage()
  const errorsC = []
  pageC.on('pageerror', (e) => errorsC.push(String(e.message)))
  await pageC.goto(BASE + '?page=lobby', { waitUntil: 'domcontentloaded' })
  await pageC.waitForSelector('[data-testid=join-panel]', { timeout: 30000 })
  await pageC.locator('[data-testid=nickname-input]').fill('线上丙将军')
  await pageC.locator('[data-testid=room-code-input]').fill(ROOM)
  await pageC.locator('[data-testid=room-password-input]').fill('wrong-' + PASSWORD)
  await pageC.locator('[data-testid=join-button]').click()
  await pageC.waitForSelector('[data-testid=room-code-display]', { timeout: 30000 })
  await sleep(30000) // 密码不一致的报错要等对方的 offer 到达才会出现，给足时间
  const cItems = await pageC.locator('[data-testid=player-item]').count()
  const cErrorText = (await pageC.locator('[data-testid=error]').allInnerTexts()).join(' / ').trim()
  check('密码不一致时看不见对方（连接层拒绝配对）', cItems === 1, '列表 ' + cItems + ' 人')
  // 提示文案必须是中文且指向密码（Trystero 原文是
  // "incorrect room password when decrypting offer"，直接甩给玩家毫无帮助）
  if (cErrorText) {
    check('错误密码的提示已中文化并指向密码', cErrorText.includes('房间密码'), cErrorText.slice(0, 60))
  } else {
    console.log('  ℹ️  错误密码方暂无提示（浏览器/网络差异，仅影响提示不影响结论）')
  }

  // ---------- 8. 刷新重连（v1.0.0 修复的重点） ----------
  await pageB.reload({ waitUntil: 'domcontentloaded' })
  await pageB.waitForSelector('[data-testid=room-code-display]', { timeout: 30000 })
  await pageB.waitForFunction(
    () => document.querySelectorAll('[data-testid=player-item]').length === 2,
    undefined,
    { timeout: 60000 },
  )
  const roleB = await pageB.locator('[data-testid=role-label]').innerText()
  check('刷新后自动回到加密房并看到所有人', roleB.trim() === '你是玩家', '角色：' + roleB.trim())
  await pageA.waitForFunction(
    () => document.querySelectorAll('[data-testid=player-item]').length === 2,
    undefined,
    { timeout: 60000 },
  )
  check('房主侧刷新后无重复玩家', (await pageA.locator('[data-testid=player-item]').count()) === 2)

  // ---------- 9. 无页面异常 ----------
  check('主页/大厅无 JS 异常', homeErrors.length === 0, homeErrors.join(' | ').slice(0, 160))
  check('好友侧无 JS 异常', errorsB.length === 0, errorsB.join(' | ').slice(0, 160))
  check('错误密码侧无 JS 异常', errorsC.length === 0, errorsC.join(' | ').slice(0, 160))

  await contextA.close()
  await contextB.close()
  await contextC.close()
} catch (err) {
  check('自检过程未抛异常', false, String(err?.message ?? err).slice(0, 200))
} finally {
  await browser.close().catch(() => {})
}

const passed = results.filter((r) => r.ok).length
console.log('\n线上自检结果：' + passed + '/' + results.length + ' 通过')
if (problems.length > 0) {
  console.log('未通过：\n- ' + problems.join('\n- '))
}
process.exit(problems.length === 0 ? 0 : 1)
