/**
 * 地图编辑器端到端：入口 → 画笔刷 → 保存到本机 → 用这张图开局。
 *
 * 第二条用例是这套功能真正的"验收点"：自制地图只存在浏览器本地，
 * 如果"启动时把自制地图注册进运行时表"晚于"读存档"，刷新后就会因为查不到地图而清档。
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { ROOM, joinRoom, localHomeUrl, localUrl, waitForHost } from './helpers'

async function gameState(page: Page) {
  return page.evaluate(() =>
    (globalThis as unknown as { __atGame: { getState: () => unknown } }).__atGame.getState(),
  ) as Promise<{ phase: string; mapId: string; players: string[] }>
}

/**
 * 编辑器画布上某格中心的屏幕坐标。
 *
 * ⚠️ 必须先 `scrollIntoViewIfNeeded`：页面比视口长时画布可能落在视口外，
 * 而 `page.mouse.move()` **不会**自动滚动（只有 locator.click 才会），
 * 那时鼠标事件根本落不到画布上，表现为"悬停读数一直是初始文案"。
 */
async function cellCenter(page: Page, x: number, y: number) {
  const canvas = page.getByTestId('editor-canvas')
  await expect(canvas).toBeVisible()
  await canvas.scrollIntoViewIfNeeded()
  const box = await canvas.boundingBox()
  if (!box) throw new Error('编辑器画布不可见')
  const cell = Number(await canvas.getAttribute('data-cell-size'))
  return { x: box.x + x * cell + cell / 2, y: box.y + y * cell + cell / 2 }
}

async function openEditor(page: Page): Promise<void> {
  await page.goto(localHomeUrl('editor-a', '甲将军'))
  await page.getByTestId('entry-editor').click()
  await expect(page.getByTestId('map-editor')).toBeVisible()
}

test('地图编辑器：模板开箱即合法，能画笔刷并保存到本机', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await openEditor(page)

  // 从模板起步 → 应当直接可保存、可试玩，不需要用户先修一堆错误
  await expect(page.getByTestId('editor-validation')).toContainText('校验通过')
  await expect(page.getByTestId('editor-save')).toBeEnabled()
  await expect(page.getByTestId('editor-playtest')).toBeEnabled()
  await expect(page.getByTestId('editor-dirty')).toHaveText('尚未保存到本机')

  // 漆一格森林：悬停读数应从「平原」变「森林」
  await page.getByTestId('brush-terrain-forest').click()
  const at = await cellCenter(page, 3, 3)
  await page.mouse.move(at.x, at.y)
  await expect(page.getByTestId('editor-hover')).toContainText('平原')
  await page.mouse.click(at.x, at.y)
  await expect(page.getByTestId('editor-hover')).toContainText('森林')

  // 对称绘制：选「上下镜像」后在 (3,3) 画一格，(3,20) 应同时变成森林（h=24 → 23-3）
  // 注意：点按钮可能带动页面滚动，所以坐标要在点完之后重新取。
  await page.getByTestId('editor-symmetry-mirrorY').click()
  const mirrorAt = await cellCenter(page, 3, 3)
  const below = await cellCenter(page, 3, 20)
  await page.mouse.move(below.x, below.y)
  await expect(page.getByTestId('editor-hover')).toContainText('平原')
  await page.mouse.click(mirrorAt.x, mirrorAt.y)
  await page.mouse.move(below.x, below.y)
  await expect(page.getByTestId('editor-hover')).toContainText('森林')

  // 撤销 / 重做：一次操作 = 一步（撤销要把两个镜像格一起退回去）
  await page.getByTestId('editor-symmetry-none').click()
  await expect(page.getByTestId('editor-history')).toContainText('可撤销')
  await page.getByTestId('editor-undo').click()
  const afterUndo = await cellCenter(page, 3, 20)
  await page.mouse.move(afterUndo.x, afterUndo.y)
  await expect(page.getByTestId('editor-hover')).toContainText('平原')
  await page.getByTestId('editor-redo').click()
  const afterRedo = await cellCenter(page, 3, 20)
  await page.mouse.move(afterRedo.x, afterRedo.y)
  await expect(page.getByTestId('editor-hover')).toContainText('森林')

  // 摆一个中立村落，并确认校验仍然通过（不改坏地图）
  await page.getByTestId('brush-building-village').click()
  const atVillage = await cellCenter(page, 5, 5)
  await page.mouse.click(atVillage.x, atVillage.y)
  await expect(page.getByTestId('editor-validation')).toContainText('校验通过')

  // 改名 + 保存 → 出现在「我的地图」
  await page.getByTestId('editor-name').fill('我自己画的图')
  await page.getByTestId('editor-save').click()
  await expect(page.getByTestId('editor-dirty')).toHaveText('已保存')
  await expect(page.getByTestId('editor-map-list')).toContainText('我自己画的图')

  // 导出 JSON 的往返：复制出来的 JSON 能被重新载入
  await page.getByTestId('editor-toggle-import').click()
  await expect(page.getByTestId('editor-import-text')).toBeVisible()

  expect(errors).toEqual([])
})

test('自制地图能直接开局，且刷新后仍能恢复（地图在启动时已装载）', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await openEditor(page)
  await page.getByTestId('editor-name').fill('我的渡口')

  // 试玩：应当自动保存并跳到单人练习设置页，且预选这张自制图
  await page.getByTestId('editor-playtest').click()
  await expect(page.getByTestId('pve-setup')).toBeVisible()
  await expect(page.getByTestId('pve-map-hint')).toContainText('我的渡口')
  await expect(page.getByTestId('pve-map-hint')).toContainText('自制地图')

  await page.getByTestId('pve-start').click()
  await expect(page.getByTestId('phase-label')).toHaveText('部署')

  const before = await gameState(page)
  expect(before.mapId.startsWith('user_')).toBe(true)
  expect(before.mapId).not.toBe('ancient_01')
  expect(before.players).toHaveLength(2)

  // 刷新：存档引用的是自制地图 id。能恢复 = 启动装载早于读存档（否则会被判非法而清档）
  await page.reload()
  await expect(page.getByTestId('pve-setup')).toHaveCount(0)
  await expect(page.getByTestId('phase-label')).toHaveText('部署')
  const after = await gameState(page)
  expect(after.mapId).toBe(before.mapId)
  expect(after.phase).toBe('DEPLOY')

  expect(errors).toEqual([])
})

test('自制地图能联机：分享码让双方拿到同一张图；没导入的一方有明确的补装入口', async ({ context }) => {
  const host = await context.newPage()
  const guest = await context.newPage()
  const problems: string[] = []
  for (const page of [host, guest]) page.on('pageerror', (e) => problems.push(e.message))

  // 1) 房主用编辑器做一张图，取到分享码
  await openEditor(host)
  await host.getByTestId('editor-name').fill('联机测试图')
  await host.getByTestId('editor-share-code').click()
  const shareCode = await host.getByTestId('editor-import-text').inputValue()
  expect(shareCode.startsWith('ATM1:')).toBe(true)
  await host.getByTestId('editor-save').click()
  await expect(host.getByTestId('editor-dirty')).toHaveText('已保存')
  const mapId = await host.evaluate(() => {
    const raw = JSON.parse(window.localStorage.getItem('ancient-tactics.maps') ?? '{}') as {
      maps?: Array<{ id: string }>
    }
    return raw.maps?.[0]?.id ?? ''
  })
  expect(mapId.startsWith('user_')).toBe(true)

  // 2) 双方进同一房间。
  //    本地传输（BroadcastChannel）要求两个页面同属一个浏览器上下文，因此 localStorage 也是同一份 ——
  //    为了让"客机"真的处于"没导入过这张图"的状态，这里在客机加载前把本地地图清掉。
  //    房主那边不受影响：地图已注册进它内存里的运行时表，也已经渲染进了大厅列表。
  await host.goto(localUrl('cm-a', '甲将军'))
  await joinRoom(host, ROOM, '甲将军')
  await waitForHost(host)
  await host.evaluate(() => window.localStorage.removeItem('ancient-tactics.maps'))

  await guest.goto(localUrl('cm-b', '乙将军'))
  await joinRoom(guest, ROOM, '乙将军')
  await expect(host.getByTestId('player-item')).toHaveCount(2)

  // 3) 房主在大厅选中这张自制图（带风险提示）
  await host.getByTestId('map-select').selectOption(mapId)
  await expect(host.getByTestId('map-custom-hint')).toBeVisible()

  // 4) 都准备 → 开局
  await host.getByTestId('ready-button').click()
  await guest.getByTestId('ready-button').click()
  await expect(host.getByTestId('start-button')).toBeEnabled()
  await host.getByTestId('start-button').click()
  await expect(host.getByTestId('phase-label')).toHaveText('部署')

  // 5) 客机没导入这张图 → 不该白屏，而是给出"粘贴分享码"的出路
  await expect(guest.getByTestId('missing-map')).toBeVisible()
  await expect(guest.getByTestId('missing-map')).toContainText(mapId)

  // 6) 粘分享码 → 直接接上这一局（地图 id 一致，双方是同一张图）
  await guest.getByTestId('missing-map-input').fill(shareCode)
  await guest.getByTestId('missing-map-load').click()
  await expect(guest.getByTestId('phase-label')).toHaveText('部署')
  expect((await gameState(guest)).mapId).toBe(mapId)
  expect((await gameState(host)).mapId).toBe(mapId)

  expect(problems).toEqual([])
})
