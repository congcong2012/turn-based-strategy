/* 美化后 UI 截图脚本：主页 / 规则 / PVE 设置 / 对局中（桌面 + 手机宽度）
   注意：本机 browser.close() 会永久挂住，收尾只发起不等待，靠 process.exit()。 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173'
const OUT = fileURLToPath(new URL('../../tmp/ui-beautify/', import.meta.url))
mkdirSync(OUT, { recursive: true })

async function shoot(page, name) {
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: true })
  console.log('shot:', name)
}

const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await shoot(page, '1-home')

  await page.getByTestId('entry-rules').click()
  await page.waitForTimeout(300)
  await shoot(page, '2-rules')

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByTestId('entry-pve').click()
  await page.waitForTimeout(300)
  await shoot(page, '3-pve-setup')

  await page.getByRole('button', { name: '开始对局' }).click()
  await page.waitForSelector('canvas', { timeout: 15000 })
  await page.waitForTimeout(1200)
  await shoot(page, '4-playing')

  // 手机宽度
  const mob = await (await browser.newContext({ viewport: { width: 393, height: 760 } })).newPage()
  await mob.goto(BASE, { waitUntil: 'networkidle' })
  await shoot(mob, '5-home-mobile')
  console.log('ALL_DONE')
} catch (err) {
  console.error('FAILED', err)
  process.exitCode = 1
} finally {
  browser.close() // 不 await：本机会挂住，进程退出时由 OS 回收
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref()
}
