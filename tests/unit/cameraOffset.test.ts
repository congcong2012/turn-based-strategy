/**
 * 相机偏移收敛（`src/render/camera.ts`）。
 *
 * 守的是一条**每局都会踩到**的边界：自动对准部署区时，目标贴着地图边缘，
 * "居中"就变成"越过边界"——上方一片空白、另一半地图被推出屏幕。
 * 这些用例把"大/小/贴边/退化"四种情况钉死，避免以后调相机又调回去。
 */

import { describe, expect, it } from 'vitest'
import { clampCameraOffset } from '../../src/render/camera'

describe('clampCameraOffset · 内容比视口小 → 居中', () => {
  it('居中偏移由视口与内容决定', () => {
    // 视口 800，内容 600 ⇒ 左右各留 100
    expect(clampCameraOffset(0, 800, 600)).toBe(100)
    expect(clampCameraOffset(999, 800, 600)).toBe(100)
  })
})

describe('clampCameraOffset · 内容比视口大 → 贴边、绝不留空', () => {
  it('★ 目标贴着上边缘（偏移为正）→ 收敛到 0，不再越过地图', () => {
    // 这正是部署区的场景：地图 900 高、视口 800，居中到顶部区域会得到 +300
    expect(clampCameraOffset(300, 800, 900)).toBe(0)
  })

  it('★ 目标贴着下边缘（偏移过负）→ 收敛到 视口-内容', () => {
    expect(clampCameraOffset(-500, 800, 900)).toBe(-100)
  })

  it('本来就在合法区间内 → 原样保留（不干扰正常的"对准某一小块"）', () => {
    expect(clampCameraOffset(-50, 800, 900)).toBe(-50)
    expect(clampCameraOffset(0, 800, 900)).toBe(0)
  })
})

describe('clampCameraOffset · 退化输入不产生 NaN', () => {
  it('视口或内容为 0 / 负数 → 原样返回', () => {
    expect(clampCameraOffset(12, 0, 900)).toBe(12)
    expect(clampCameraOffset(12, 800, 0)).toBe(12)
    expect(clampCameraOffset(Number.NaN, 800, 900)).toBe(Number.NaN)
  })

  it('结果永远是有限数（渲染层拿到 NaN 会整块消失）', () => {
    expect(Number.isFinite(clampCameraOffset(300, 800, 900))).toBe(true)
    expect(Number.isFinite(clampCameraOffset(-300, 800, 900))).toBe(true)
  })
})
