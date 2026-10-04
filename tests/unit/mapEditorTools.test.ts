/** 地图编辑器的纯函数工具：对称绘制的落笔集合、格子坐标换算 */

import { describe, expect, it } from 'vitest'
import { createBlankMap } from '../../src/game/mapTemplates'
import { cellsWithSymmetry, cellFromPoint, rectFromCells } from '../../src/ui/mapEditorCanvas'

const map24 = createBlankMap({ id: 'user_sym', name: '对称测试', width: 24, height: 24, players: 2 })

describe('cellsWithSymmetry', () => {
  it('关：只落当前格', () => {
    expect(cellsWithSymmetry(map24, { x: 3, y: 5 }, 'none')).toEqual([{ x: 3, y: 5 }])
  })

  it('左右镜像：x → w-1-x，y 不变', () => {
    expect(cellsWithSymmetry(map24, { x: 3, y: 5 }, 'mirrorX')).toEqual([
      { x: 3, y: 5 },
      { x: 20, y: 5 },
    ])
  })

  it('上下镜像：y → h-1-y，x 不变', () => {
    expect(cellsWithSymmetry(map24, { x: 3, y: 5 }, 'mirrorY')).toEqual([
      { x: 3, y: 5 },
      { x: 3, y: 18 },
    ])
  })

  it('中心对称：两者同时（180° 旋转）', () => {
    expect(cellsWithSymmetry(map24, { x: 3, y: 5 }, 'center')).toEqual([
      { x: 3, y: 5 },
      { x: 20, y: 18 },
    ])
  })

  it('落点在中线上时镜像就是自己，去重后只落一格', () => {
    // 24 格的中线在 11.5，用奇数尺寸才可能出现"自己镜像自己"
    const odd = createBlankMap({ id: 'user_odd', name: '奇数图', width: 21, height: 21, players: 2 })
    expect(cellsWithSymmetry(odd, { x: 10, y: 4 }, 'mirrorX')).toEqual([{ x: 10, y: 4 }])
    expect(cellsWithSymmetry(odd, { x: 4, y: 10 }, 'mirrorY')).toEqual([{ x: 4, y: 10 }])
    // 正中一格：中心对称就是它自己
    expect(cellsWithSymmetry(odd, { x: 10, y: 10 }, 'center')).toEqual([{ x: 10, y: 10 }])
  })

  it('镜像格永远落在地图内（边界格也不越界）', () => {
    for (const symmetry of ['mirrorX', 'mirrorY', 'center'] as const) {
      for (const cell of [
        { x: 0, y: 0 },
        { x: 23, y: 23 },
        { x: 0, y: 23 },
        { x: 23, y: 0 },
      ]) {
        for (const result of cellsWithSymmetry(map24, cell, symmetry)) {
          expect(result.x).toBeGreaterThanOrEqual(0)
          expect(result.y).toBeGreaterThanOrEqual(0)
          expect(result.x).toBeLessThan(24)
          expect(result.y).toBeLessThan(24)
        }
      }
    }
  })
})

describe('cellFromPoint / rectFromCells', () => {
  it('屏幕坐标换算到格子；图外返回 null', () => {
    const rect = { left: 100, top: 50 }
    expect(cellFromPoint(map24, 20, rect, 100 + 45, 50 + 25)).toEqual({ x: 2, y: 1 })
    expect(cellFromPoint(map24, 20, rect, 99, 60)).toBeNull()
    expect(cellFromPoint(map24, 20, rect, 100 + 24 * 20, 60)).toBeNull()
  })

  it('拖拽方向不影响矩形（起止点可颠倒）', () => {
    expect(rectFromCells({ x: 5, y: 8 }, { x: 2, y: 3 })).toEqual({ x0: 2, y0: 3, x1: 5, y1: 8 })
  })
})
