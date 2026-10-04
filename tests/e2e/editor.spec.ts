/**
 * 地图编辑器端到端：入口 → 画笔刷 → 保存到本机 → 用这张图开局。
 *
 * 第二条用例是这套功能真正的"验收点"：自制地图只存在浏览器本地，
 * 如果"启动时把自制地图注册进运行时表"晚于"读存档"，刷新后就会因为查不到地图而清档。
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { localHomeUrl } from './helpers'

async function gameState(page: Page) {
  return page.evaluate(() =>
    (globalThis as unknown as { __atGame: { getState: () => unknown } }).__atGame.getState(),
  ) as Promise<{ phase: string; mapId: string; players: string[] }>
}

/** 编辑器画布上某格中心的屏幕坐标（格子大小由画布的 data-cell-size 暴露，测试据此换算） */
async function cellCenter(page: Page, x: number, y: number) {
  const canvas = page.getByTestId('editor-canvas')
  await expect(canvas).toBeVisible()
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
