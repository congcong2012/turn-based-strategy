/**
 * 地图编辑器的画布绘制与命中测试。
 *
 * 独立成模块的原因：`MapEditor.tsx` 已经要管笔刷、校验、存档、导入导出，
 * 把"画格子"和"屏幕坐标 → 格子坐标"抽出来，组件只剩事件接线，也更好单测
 * （`cellFromPoint` 是纯函数）。
 */

import type { GameData, MapDef } from '../game/data'

/** 四名玩家的标识色（与联机大厅的队伍色无耦合，仅编辑器用） */
export const OWNER_COLORS = ['#e0605c', '#5c93e0', '#5cc48a', '#e0b45c'] as const
export const NEUTRAL_COLOR = '#9aa0a6'

export interface ZonePreview {
  player: number
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface DrawOptions {
  cellSize: number
  /** 正在拖拽的部署区预览（松手前不影响数据） */
  zonePreview?: ZonePreview | null
  /** 鼠标悬停的格子（画一个高亮框） */
  hover?: { x: number; y: number } | null
  /** 当前笔刷的目标玩家（高亮对应部署区） */
  activePlayer?: number | null
}

export function canvasWidth(map: MapDef, cellSize: number): number {
  return map.width * cellSize
}

export function canvasHeight(map: MapDef, cellSize: number): number {
  return map.height * cellSize
}

/**
 * 屏幕坐标 → 格子坐标（**纯函数**，便于单测）。
 *
 * `rect` 是 canvas 的 `getBoundingClientRect()`；返回 null 表示落在图外。
 */
export function cellFromPoint(
  map: MapDef,
  cellSize: number,
  rect: { left: number; top: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const x = Math.floor((clientX - rect.left) / cellSize)
  const y = Math.floor((clientY - rect.top) / cellSize)
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return null
  return { x, y }
}

/** 由两个格子得到规范化矩形（拖拽方向无所谓） */
export function rectFromCells(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: Math.min(a.x, b.x),
    y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x),
    y1: Math.max(a.y, b.y),
  }
}

/**
 * 对称绘制模式。
 *
 * 为什么需要：两张内置地图都是严格对称的，做一张**能开局的对战图**几乎都要对称摆地形与据点 ——
 * 一格一格手动镜像又慢又容易错位。
 * 只作用在**地形与据点**上；部署区是每个玩家一块矩形，本来就只有 2–4 块，手工拖更直接
 * （而且"镜像部署区"会连带覆盖另一个玩家的区，语义反而更绕）。
 */
export type SymmetryMode = 'none' | 'mirrorX' | 'mirrorY' | 'center'

export const SYMMETRY_OPTIONS: Array<{ value: SymmetryMode; label: string }> = [
  { value: 'none', label: '关' },
  { value: 'mirrorX', label: '左右镜像' },
  { value: 'mirrorY', label: '上下镜像' },
  { value: 'center', label: '中心对称' },
]

/**
 * 一次绘制要落笔的所有格子（含对称镜像，去重后返回）。
 *
 * 注意「左右镜像」= 沿**竖向中线**翻到另一半（x → w-1-x），
 * 「上下镜像」= 沿**横向中线**（y → h-1-y），「中心对称」= 两者同时（180° 旋转）。
 * 奇数尺寸时中线那一列/行是自己的镜像，去重后不会重复落笔。
 */
export function cellsWithSymmetry(
  map: MapDef,
  cell: { x: number; y: number },
  symmetry: SymmetryMode,
): Array<{ x: number; y: number }> {
  const mirrorX = { x: map.width - 1 - cell.x, y: cell.y }
  const mirrorY = { x: cell.x, y: map.height - 1 - cell.y }
  const center = { x: map.width - 1 - cell.x, y: map.height - 1 - cell.y }

  const raw =
    symmetry === 'mirrorX' ? [cell, mirrorX]
    : symmetry === 'mirrorY' ? [cell, mirrorY]
    : symmetry === 'center' ? [cell, center]
    : [cell]

  const seen = new Set<string>()
  return raw.filter((c) => {
    const key = c.x + ',' + c.y
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function drawMap(
  ctx: CanvasRenderingContext2D,
  map: MapDef,
  data: GameData,
  options: DrawOptions,
): void {
  const { cellSize, zonePreview = null, hover = null, activePlayer = null } = options
  const w = canvasWidth(map, cellSize)
  const h = canvasHeight(map, cellSize)

  ctx.clearRect(0, 0, w, h)

  // 1) 地形
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const id = map.terrain[y * map.width + x]
      const terrain = data.terrain[id]
      ctx.fillStyle = terrain?.color ?? '#000000'
      ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize)
    }
  }

  // 2) 部署区（半透明色块 + 玩家序号）
  map.deployZones.forEach((zone, index) => {
    const color = OWNER_COLORS[index % OWNER_COLORS.length]
    ctx.fillStyle = hexToRgba(color, activePlayer === index ? 0.4 : 0.22)
    ctx.fillRect(
      zone.x0 * cellSize,
      zone.y0 * cellSize,
      (zone.x1 - zone.x0 + 1) * cellSize,
      (zone.y1 - zone.y0 + 1) * cellSize,
    )
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.setLineDash([5, 4])
    ctx.strokeRect(
      zone.x0 * cellSize + 1,
      zone.y0 * cellSize + 1,
      (zone.x1 - zone.x0 + 1) * cellSize - 2,
      (zone.y1 - zone.y0 + 1) * cellSize - 2,
    )
    ctx.setLineDash([])
    if (cellSize >= 14) {
      ctx.fillStyle = '#ffffff'
      ctx.font = `bold ${Math.floor(cellSize * 0.5)}px system-ui, sans-serif`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(
        String(index + 1),
        zone.x0 * cellSize + 3,
        zone.y0 * cellSize + 2,
      )
    }
  })

  // 3) 拖拽中的部署区预览
  if (zonePreview) {
    const color = OWNER_COLORS[zonePreview.player % OWNER_COLORS.length]
    ctx.fillStyle = hexToRgba(color, 0.45)
    ctx.fillRect(
      zonePreview.x0 * cellSize,
      zonePreview.y0 * cellSize,
      (zonePreview.x1 - zonePreview.x0 + 1) * cellSize,
      (zonePreview.y1 - zonePreview.y0 + 1) * cellSize,
    )
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.strokeRect(
      zonePreview.x0 * cellSize,
      zonePreview.y0 * cellSize,
      (zonePreview.x1 - zonePreview.x0 + 1) * cellSize,
      (zonePreview.y1 - zonePreview.y0 + 1) * cellSize,
    )
  }

  // 4) 网格线
  ctx.strokeStyle = 'rgba(0,0,0,0.22)'
  ctx.lineWidth = 1
  for (let x = 0; x <= map.width; x += 1) {
    ctx.beginPath()
    ctx.moveTo(x * cellSize + 0.5, 0)
    ctx.lineTo(x * cellSize + 0.5, h)
    ctx.stroke()
  }
  for (let y = 0; y <= map.height; y += 1) {
    ctx.beginPath()
    ctx.moveTo(0, y * cellSize + 0.5)
    ctx.lineTo(w, y * cellSize + 0.5)
    ctx.stroke()
  }

  // 5) 据点
  for (const building of map.buildings) {
    const def = data.buildings[building.type]
    const cx = building.x * cellSize + cellSize / 2
    const cy = building.y * cellSize + cellSize / 2
    const radius = Math.max(3, cellSize * 0.36)
    const ownerColor =
      building.owner === null ? NEUTRAL_COLOR : OWNER_COLORS[building.owner % OWNER_COLORS.length]

    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(20, 18, 14, 0.72)'
    ctx.fill()
    ctx.lineWidth = Math.max(1.5, cellSize * 0.09)
    ctx.strokeStyle = ownerColor
    ctx.stroke()

    if (cellSize >= 13) {
      ctx.fillStyle = '#f5efe2'
      ctx.font = `${Math.floor(cellSize * 0.52)}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(def?.glyph ?? '?', cx, cy + 1)
    }
  }

  // 6) 悬停高亮
  if (hover) {
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.strokeRect(hover.x * cellSize + 1, hover.y * cellSize + 1, cellSize - 2, cellSize - 2)
  }
}
