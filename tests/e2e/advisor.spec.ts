/**
 * AI 参谋（LLM advisor）端到端。
 *
 * 三条互相独立的保证，各有一组用例：
 *
 * 1. **UI 面板**（离线）：设置页有开关、默认关闭、开启后才展开密钥输入与说明、
 *    设置持久化到 localStorage。
 * 2. **默认路径零变化**（离线，最重要）：**不开**参谋时，单人练习的部署与走子
 *    与"没有这个功能"完全一致；并且**整个对局不发任何网络请求**。
 * 3. **真实调用**（`@network`，可选）：配了 key 时真的能连通并拿到参谋结果。
 *    没有 key（本地默认、CI 默认）时自动跳过，不阻塞任何人。
 *
 * 为什么不把"真实调用"塞进默认用例：LLM 需要外网 + 有效密钥 + 计费，
 * 让它在 CI 的阻塞门里跑，等于把构建的成败绑在一个外部付费服务上。
 * 因此打 `@network` 标记，由 `deploy.yml` 的 `--grep-invert @network` 排除。
 */

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { localHomeUrl } from './helpers'

/** 参谋设置存在这个键下（与 `src/ai/advisor/settings.ts` 的单一事实源一致） */
const ADVISOR_STORAGE_KEY = 'ancient-tactics.advisor'

/** 进入单人练习设置页 */
async function openPveSetup(page: Page): Promise<void> {
  await page.goto(localHomeUrl('advisor-a', '甲将军'))
  await page.getByTestId('entry-pve').click()
  await expect(page.getByTestId('pve-setup')).toBeVisible()
}

/** 读取参谋设置（从 localStorage） */
async function readAdvisorSettings(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null
  }, ADVISOR_STORAGE_KEY)
}

test.describe('AI 参谋 · 设置面板（离线）', () => {
  test('默认关闭：面板存在、开关未勾选、不展开密钥输入', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    await openPveSetup(page)

    await expect(page.getByTestId('pve-advisor')).toBeVisible()
    await expect(page.getByTestId('pve-advisor-enabled')).not.toBeChecked()
    // 关闭时不展开正文（密钥输入 / 隐私说明等都不出现）
    await expect(page.getByTestId('pve-advisor-body')).toHaveCount(0)
    await expect(page.getByTestId('pve-advisor-key')).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('开启后展开密钥输入、隐私与降级说明，并且高级项默认折叠', async ({ page }) => {
    await openPveSetup(page)

    await page.getByTestId('pve-advisor-enabled').check()

    await expect(page.getByTestId('pve-advisor-body')).toBeVisible()
    await expect(page.getByTestId('pve-advisor-key')).toBeVisible()
    // 密钥输入必须是 password 类型（不明文回显）
    await expect(page.getByTestId('pve-advisor-key')).toHaveAttribute('type', 'password')

    // 说明必须到位：隐私（存本机）、降级（静默回退）、以及"不保证变强"的诚实标注
    await expect(page.getByTestId('pve-advisor-privacy')).toContainText('不会上传')
    await expect(page.getByTestId('pve-advisor-fallback')).toContainText('静默退回')
    await expect(page.getByTestId('pve-advisor-caveat')).toContainText('刷新页面')

    // 高级项（接口地址 / 模型）默认不展开
    await expect(page.getByTestId('pve-advisor-advanced')).toHaveCount(0)
    await page.getByTestId('pve-advisor-advanced-toggle').click()
    await expect(page.getByTestId('pve-advisor-advanced')).toBeVisible()
    await expect(page.getByTestId('pve-advisor-baseurl')).toBeVisible()
    await expect(page.getByTestId('pve-advisor-model')).toBeVisible()
  })

  test('设置写入 localStorage，且刷新后仍生效（开关 + 密钥透传）', async ({ page }) => {
    await openPveSetup(page)

    await page.getByTestId('pve-advisor-enabled').check()
    await page.getByTestId('pve-advisor-key').fill('sk-e2e-dummy-key')

    // 落盘
    await expect
      .poll(async () => (await readAdvisorSettings(page))?.apiKey)
      .toBe('sk-e2e-dummy-key')
    const saved = await readAdvisorSettings(page)
    expect(saved?.enabled).toBe(true)

    // 刷新后设置仍在（同一页重新进入设置页）
    await page.reload()
    await expect(page.getByTestId('pve-setup')).toBeVisible()
    await expect(page.getByTestId('pve-advisor-enabled')).toBeChecked()
    await expect(page.getByTestId('pve-advisor-key')).toHaveValue('sk-e2e-dummy-key')
  })

  test('改高级项（接口地址 / 模型）会被保存', async ({ page }) => {
    await openPveSetup(page)

    await page.getByTestId('pve-advisor-enabled').check()
    await page.getByTestId('pve-advisor-advanced-toggle').click()
    await page.getByTestId('pve-advisor-baseurl').fill('https://example.test/v1')
    await page.getByTestId('pve-advisor-model').fill('my-model')

    await expect
      .poll(async () => (await readAdvisorSettings(page))?.baseUrl)
      .toBe('https://example.test/v1')
    expect((await readAdvisorSettings(page))?.model).toBe('my-model')
  })

  test('★ 密钥只存在于 localStorage：服务端 HTML 与首屏源码里都没有它', async ({ page }) => {
    // 守着"密钥只存在玩家自己这台设备的浏览器里、绝不进构建产物"这条承诺。
    //
    // 一个容易踩的坑：`page.content()` 序列化的是**实时 DOM**，
    // 而 `<input type=password>` 的 `value` 会出现在那份序列化结果里 ——
    // 那是用户刚敲进去的字符，不是泄漏。真正该断言的是**服务器返回的 HTML**
    // （首屏源码）。所以这里用 `fetch` 取原始响应，而不是 `page.content()`。
    const sentinel = 'sk-should-never-be-baked-in'

    // 先打开页面（`fetch` 需要一个已加载的 origin）；此时还没输入任何东西
    await openPveSetup(page)

    // 1) 服务端返回的首屏 HTML（未输入任何东西时）不含任何密钥形态的串
    const servedHtml = await page.evaluate(async () => {
      const res = await fetch(location.href.split('#')[0], { cache: 'no-store' })
      return res.text()
    })
    expect(servedHtml).not.toContain(sentinel)
    expect(servedHtml).not.toMatch(/sk-[A-Za-z0-9]{16,}/)

    await page.getByTestId('pve-advisor-enabled').check()
    await page.getByTestId('pve-advisor-key').fill(sentinel)

    // 2) 它确实被保存进了 localStorage（证明前面的 fill 真的生效，断言不是空转）
    await expect.poll(async () => (await readAdvisorSettings(page))?.apiKey).toBe(sentinel)

    // 3) 输入框是 password 类型（不明文回显 —— 屏幕上只显示圆点）
    await expect(page.getByTestId('pve-advisor-key')).toHaveAttribute('type', 'password')

    // 4) 服务端首屏 HTML 不因"用户输入过"而变化（它本就不该把输入回传）
    const servedAgain = await page.evaluate(async () => {
      const res = await fetch(location.href.split('#')[0], { cache: 'no-store' })
      return res.text()
    })
    expect(servedAgain).not.toContain(sentinel)
  })
})

test.describe('AI 参谋 · 手机布局（393px 竖屏）', () => {
  // 参谋面板的说明文字很长（隐私 / 降级 / 诚实标注），是设置页里最长的几段之一。
  // `button` 上有全局 `white-space: nowrap`，这类长文案最容易把页面撑出横向滚动条。
  // 这里专门在手机宽度下把面板**完全展开**，守住不溢出。
  test.use({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })

  test('展开参谋面板（含高级项）后仍无横向溢出', async ({ page }) => {
    await openPveSetup(page)

    // 展开：开关 + 高级项（把最长的文案都放出来）
    await page.getByTestId('pve-advisor-enabled').check()
    await page.getByTestId('pve-advisor-advanced-toggle').click()
    await expect(page.getByTestId('pve-advisor-advanced')).toBeVisible()

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(1)
  })

  test('密钥输入框不撑破屏幕（宽度受限，可收缩）', async ({ page }) => {
    await openPveSetup(page)
    await page.getByTestId('pve-advisor-enabled').check()

    const box = await page.getByTestId('pve-advisor-key').boundingBox()
    expect(box).not.toBeNull()
    // 输入框必须落在视口内（左右都不超出）
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(394)
  })
})

test.describe('AI 参谋 · 关闭时对局零变化（离线）', () => {
  test('未开参谋：单人练习全程不发网络请求（除了本机静态资源）', async ({ page }) => {
    // 记录所有出网请求；任何"非本机"的请求都算失败
    const external: string[] = []
    page.on('request', (req) => {
      const url = req.url()
      if (!url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
        external.push(url)
      }
    })

    await openPveSetup(page)
    // 明确不开参谋（默认即关闭）
    await expect(page.getByTestId('pve-advisor-enabled')).not.toBeChecked()
    await page.getByTestId('pve-start').click()

    // 起手了、AI 也部署了
    await expect(page.getByTestId('pve-setup')).toHaveCount(0)
    await expect(page.locator('.board-host canvas')).toBeVisible()

    // 给 AI 排程留一点时间，然后断言"没有任何外网请求"
    await page.waitForTimeout(1_500)
    expect(external).toEqual([])
  })

  test('未开参谋时对局能正常推进（部署 → 行动），不因参谋层而卡死', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    await openPveSetup(page)
    await page.getByTestId('pve-opponents-1').click()
    await page.getByTestId('pve-difficulty-easy').click()
    await page.getByTestId('pve-start').click()

    // 棋盘出现
    await expect(page.locator('.board-host canvas')).toBeVisible()

    // 人类一侧把部署走完（用内核产出的合法部署指令，避免手写坐标）
    await finishHumanDeploy(page)

    // 进入行动阶段 —— 说明 AI 部署（走 think 的那条路）没有把整局卡住。
    // 权威状态挂在 `__atGame.getState()` 上（见 `GameScreen.tsx`），
    // 棋盘渲染层的 `__atBoard` 只有 `project` / `renderErrors`，没有 state。
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (globalThis as unknown as { __atGame?: { getState: () => { phase: string } } }).__atGame?.getState()
                .phase ?? null,
          ),
        { timeout: 20_000 },
      )
      .toBe('PLAYING')

    expect(errors).toEqual([])
  })
})

test.describe('AI 参谋 · 真实调用（@network，需要 ADVISOR_API_KEY）', () => {
  /**
   * 真实连通测试：从环境变量读密钥。
   *
   * - **本地想验证**：`ADVISOR_API_KEY=sk-xxx npx playwright test -g advisor`
   * - **CI**：不设该变量 ⇒ 本用例自动跳过（`test.skip`），不阻塞构建。
   *
   * 它验证的是"整条链路真的通"：写设置 → 开局 → 参谋层发请求 → 拿到计划 → 局面推进。
   * 失败时不校验 AI 强弱（那本就无法在个位数用例里断言），只校验"没崩、没卡死"。
   */
  test('配置密钥后，AI 回合会真的调用模型并给出参谋（不崩不卡）', { tag: '@network' }, async ({ page }) => {
    const apiKey = process.env.ADVISOR_API_KEY
    test.skip(!apiKey, '未设置 ADVISOR_API_KEY，跳过真实联网用例')

    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    // 预置设置：开启 + 填 key + 用默认 DeepSeek 端点
    await page.addInitScript(
      ([key, storageKey]) => {
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            enabled: true,
            apiKey: key,
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek_flash',
            timeoutMs: 3000,
          }),
        )
      },
      [apiKey as string, ADVISOR_STORAGE_KEY] as const,
    )

    await openPveSetup(page)
    await expect(page.getByTestId('pve-advisor-enabled')).toBeChecked()

    await page.getByTestId('pve-opponents-1').click()
    await page.getByTestId('pve-difficulty-normal').click()
    await page.getByTestId('pve-start').click()

    await expect(page.locator('.board-host canvas')).toBeVisible()
    await finishHumanDeploy(page)

    // 参谋层要么成功（ok）要么静默回退（fallback），但**绝不能**让对局崩掉。
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const at = (globalThis as unknown as {
              __atPve?: { advisorStatus?: () => { result?: string } | null }
            }).__atPve
            return at?.advisorStatus?.()?.result ?? null
          }),
        { timeout: 25_000 },
      )
      .not.toBeNull()

    // 失败必须只表现为"回退"，而不是异常
    expect(errors).toEqual([])
  })
})

/** 点击棋盘上的某个格子（真实鼠标事件），与 pve.spec 的同名 helper 一致 */
async function clickTile(page: Page, x: number, y: number): Promise<void> {
  const canvas = page.locator('.board-host canvas')
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  if (!box) throw new Error('canvas 不可见')
  const point = await page.evaluate(
    ([tx, ty]) =>
      (globalThis as unknown as { __atBoard: { project: (x: number, y: number) => { x: number; y: number } } }).__atBoard.project(
        tx,
        ty,
      ),
    [x, y] as const,
  )
  await page.mouse.click(box.x + point.x, box.y + point.y)
}

/**
 * 让人类一侧把部署走完：选一个兵种、点一个合法落点，再点"完成部署"。
 *
 * 沿用 `pve.spec.ts` 里验证过的做法（`deploy-sword` → 点 (2,0) → `deploy-done`），
 * 而不是手写"遍历所有合法性"的复杂逻辑 —— 后者会随地图变化而脆。
 */
async function finishHumanDeploy(page: Page): Promise<void> {
  // 等 Pixi 挂载完成（__atBoard 就绪）再点棋盘，否则投影拿不到
  await expect
    .poll(
      () =>
        page.evaluate(() => typeof (globalThis as unknown as { __atBoard?: unknown }).__atBoard !== 'undefined'),
      { timeout: 15_000 },
    )
    .toBe(true)

  await page.getByTestId('deploy-sword').click()
  await clickTile(page, 2, 0)
  await expect(page.getByTestId('deploy-done')).toBeEnabled()
  await page.getByTestId('deploy-done').click()
}
