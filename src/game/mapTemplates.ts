/**
 * 地图工厂与几何变换（纯函数）。
 *
 * 编辑器需要两件事：从**一张可玩的模板**起步（而不是空白格子），
 * 以及改变尺寸时**尽量保住已画的内容**。两者都放这里，便于单测。
 */

import type { MapDef } from './data'

export interface BlankMapOptions {
  id: string
  name: string
  width: number
  height: number
  players: number
}

/**
 * 生成一张对称、可直接开局的模板地图。
 *
 * 布局规则（2 人）：上下两条部署带，各自一个王城 + 两个兵营，中间交叉排布中立村落。
 * 3 人：上一条带 + 下带左右各一块；4 人：四角各一块。
 * 王城都落在自己的部署区内（否则编辑器会提示"王城不在部署区"）。
 */
export function createBlankMap(options: BlankMapOptions): MapDef {
  const width = Math.max(12, Math.floor(options.width))
  const height = Math.max(12, Math.floor(options.height))
  const players = Math.min(4, Math.max(2, Math.floor(options.players)))
  const cx = Math.floor(width / 2)
  const cy = Math.floor(height / 2)

  const terrain = new Array<string>(width * height).fill('plain')
  const deployZones: MapDef['deployZones'] = []
  const buildings: MapDef['buildings'] = []
  let seq = 0
  const addBuilding = (type: string, x: number, y: number, owner: number | null): void => {
    seq += 1
    buildings.push({ id: 'b' + seq, type, x, y, owner })
  }

  if (players === 2) {
    deployZones.push({ x0: 0, y0: 0, x1: width - 1, y1: 3 })
    deployZones.push({ x0: 0, y0: height - 4, x1: width - 1, y1: height - 1 })
    addBuilding('hq', cx, 2, 0)
    addBuilding('barracks', clamp(cx - 5, 0, width - 1), 2, 0)
    addBuilding('barracks', clamp(cx + 5, 0, width - 1), 2, 0)
    addBuilding('hq', cx, height - 3, 1)
    addBuilding('barracks', clamp(cx - 5, 0, width - 1), height - 3, 1)
    addBuilding('barracks', clamp(cx + 5, 0, width - 1), height - 3, 1)
    addBuilding('village', cx, cy, null)
    addBuilding('village', clamp(cx - 6, 0, width - 1), cy, null)
    addBuilding('village', clamp(cx + 6, 0, width - 1), cy, null)
    addBuilding('village', cx, clamp(cy - 4, 0, height - 1), null)
    addBuilding('village', cx, clamp(cy + 4, 0, height - 1), null)
  } else if (players === 3) {
    deployZones.push({ x0: 0, y0: 0, x1: width - 1, y1: 3 })
    deployZones.push({ x0: 0, y0: height - 4, x1: Math.max(4, cx - 2), y1: height - 1 })
    deployZones.push({ x0: Math.min(width - 5, cx + 2), y0: height - 4, x1: width - 1, y1: height - 1 })
    addBuilding('hq', cx, 2, 0)
    addBuilding('barracks', clamp(cx - 5, 0, width - 1), 2, 0)
    addBuilding('barracks', clamp(cx + 5, 0, width - 1), 2, 0)
    addBuilding('hq', Math.floor((0 + Math.max(4, cx - 2)) / 2), height - 3, 1)
    addBuilding('barracks', clamp(Math.floor((0 + Math.max(4, cx - 2)) / 2) - 3, 0, width - 1), height - 3, 1)
    addBuilding('hq', Math.floor((Math.min(width - 5, cx + 2) + width - 1) / 2), height - 3, 2)
    addBuilding('barracks', clamp(Math.floor((Math.min(width - 5, cx + 2) + width - 1) / 2) + 3, 0, width - 1), height - 3, 2)
    addBuilding('village', cx, cy, null)
    addBuilding('village', cx, clamp(cy - 4, 0, height - 1), null)
    addBuilding('village', cx, clamp(cy + 4, 0, height - 1), null)
    addBuilding('village', clamp(cx - 6, 0, width - 1), cy, null)
    addBuilding('village', clamp(cx + 6, 0, width - 1), cy, null)
  } else {
    const z = 6
    deployZones.push({ x0: 0, y0: 0, x1: z, y1: z })
    deployZones.push({ x0: width - 1 - z, y0: 0, x1: width - 1, y1: z })
    deployZones.push({ x0: 0, y0: height - 1 - z, x1: z, y1: height - 1 })
    deployZones.push({ x0: width - 1 - z, y0: height - 1 - z, x1: width - 1, y1: height - 1 })
    const corners: Array<[number, number, number]> = [
      [4, 4, 0],
      [width - 5, 4, 1],
      [4, height - 5, 2],
      [width - 5, height - 5, 3],
    ]
    for (const [x, y, owner] of corners) {
      addBuilding('hq', x, y, owner)
      addBuilding('barracks', x - 2, y, owner)
      addBuilding('barracks', x, y - 2, owner)
    }
    addBuilding('village', cx, cy, null)
    addBuilding('village', clamp(cx - 5, 0, width - 1), cy, null)
    addBuilding('village', clamp(cx + 5, 0, width - 1), cy, null)
    addBuilding('village', cx, clamp(cy - 5, 0, height - 1), null)
    addBuilding('village', cx, clamp(cy + 5, 0, height - 1), null)
  }

  const map: MapDef = {
    id: options.id,
    name: options.name,
    width,
    height,
    terrain,
    buildings,
    deployZones,
  }
  // 据点格的地形统一补成「据点」，与内置地图一致
  for (const b of map.buildings) {
    const idx = b.y * map.width + b.x
    if (idx >= 0 && idx < map.terrain.length) map.terrain[idx] = 'building'
  }
  return map
}

/**
 * 改变尺寸：**保住交叠区域**已画的格子/据点，越界的内容丢弃（返回被丢弃的数量供提示）。
 * 部署区按边缘重新吸附：贴边的区跟着边移动，其它区夹回界内。
 */
export function resizeMap(
  map: MapDef,
  width: number,
  height: number,
): { map: MapDef; droppedBuildings: number } {
  const w = Math.max(12, Math.floor(width))
  const h = Math.max(12, Math.floor(height))
  const terrain = new Array<string>(w * h).fill('plain')

  const copyW = Math.min(w, map.width)
  const copyH = Math.min(h, map.height)
  for (let y = 0; y < copyH; y += 1) {
    for (let x = 0; x < copyW; x += 1) {
      terrain[y * w + x] = map.terrain[y * map.width + x]
    }
  }

  const buildings = map.buildings.filter((b) => b.x < w && b.y < h)
  const droppedBuildings = map.buildings.length - buildings.length

  const zones = map.deployZones.map((zone) => {
    const wasTop = zone.y0 < map.height / 2
    const wasLeft = zone.x0 < map.width / 2
    const zoneW = Math.min(zone.x1 - zone.x0, w - 1)
    const zoneH = Math.min(zone.y1 - zone.y0, h - 1)
    // 贴左/上的区保持贴边，其余按新尺寸靠另一边
    const x0 = wasLeft ? 0 : Math.max(0, w - 1 - zoneW)
    const y0 = wasTop ? 0 : Math.max(0, h - 1 - zoneH)
    return { x0, y0, x1: Math.min(w - 1, x0 + zoneW), y1: Math.min(h - 1, y0 + zoneH) }
  })

  return { map: { ...map, width: w, height: h, terrain, buildings, deployZones: zones }, droppedBuildings }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
