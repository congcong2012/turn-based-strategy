/** 移动：可通行判断、Dijkstra 可达范围、路径校验（GDD 5.3） */

import { DATA, moveCost } from './data'
import type { GameData, MapDef } from './data'
import { mapOf, tileKey } from './board'
import type { GameState, Unit } from './types'

export type ReachMap = Map<string, { cost: number; from: string | null }>

/**
 * 从单位当前位置做 Dijkstra（消耗 = 进入目标格的移动力）。
 * 规则：敌方单位所在格不可进入（并阻断通行）；友方单位可通过但不可停留。
 */
export function computeReach(state: GameState, unit: Unit, data: GameData = DATA): ReachMap {
  const map = mapOf(state, data)
  const type = data.units[unit.type]
  const reach: ReachMap = new Map()
  reach.set(tileKey(unit.x, unit.y), { cost: 0, from: null })

  const occupied = new Map<string, Unit>()
  for (const u of state.units) {
    if (u.id === unit.id) continue
    occupied.set(tileKey(u.x, u.y), u)
  }

  // 棋盘很小（24×24），用简单的优先队列（数组排序取出最小）
  const queue: Array<{ key: string; cost: number }> = [{ key: tileKey(unit.x, unit.y), cost: 0 }]
  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost)
    const current = queue.shift() as { key: string; cost: number }
    const known = reach.get(current.key)
    if (!known || current.cost > known.cost) continue
    const [cx, cy] = current.key.split(',').map(Number)

    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue
      const step = moveCost(map, nx, ny, type.moveType, data)
      if (step === null) continue
      const occupant = occupied.get(tileKey(nx, ny))
      if (occupant && occupant.owner !== unit.owner) continue // 敌方阻挡
      const nextCost = current.cost + step
      if (nextCost > type.move) continue
      const key = tileKey(nx, ny)
      const prev = reach.get(key)
      if (!prev || nextCost < prev.cost) {
        reach.set(key, { cost: nextCost, from: current.key })
        queue.push({ key, cost: nextCost })
      }
    }
  }
  return reach
}

/** 可停留的目的地（排除被任何单位占据的格子） */
export function reachableDestinations(state: GameState, unit: Unit, data: GameData = DATA): Array<{ x: number; y: number; cost: number }> {
  const reach = computeReach(state, unit, data)
  const out: Array<{ x: number; y: number; cost: number }> = []
  for (const [key, node] of reach) {
    const [x, y] = key.split(',').map(Number)
    if (x === unit.x && y === unit.y) continue
    if (state.units.some((u) => u.x === x && u.y === y)) continue
    out.push({ x, y, cost: node.cost })
  }
  return out
}

export function pathTo(state: GameState, unit: Unit, x: number, y: number, data: GameData = DATA): Array<{ x: number; y: number }> | null {
  const reach = computeReach(state, unit, data)
  const key = tileKey(x, y)
  if (!reach.has(key)) return null
  const path: Array<{ x: number; y: number }> = []
  let cursor: string | null = key
  while (cursor) {
    const [cx, cy] = cursor.split(',').map(Number)
    path.unshift({ x: cx, y: cy })
    cursor = reach.get(cursor)?.from ?? null
  }
  path.shift() // 去掉起点
  return path.length > 0 ? path : null
}

export function chebyshevDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}

/** 单位射程内可攻击的敌方单位（含间接单位"移动后不可攻击"限制） */
export function attackableTargets(state: GameState, unit: Unit, data: GameData = DATA): Unit[] {
  const type = data.units[unit.type]
  if (type.attack === 'indirect' && unit.moved) return []
  return state.units.filter((u) => {
    if (u.owner === unit.owner) return false
    const d = chebyshevDistance(unit, u)
    return d >= type.rangeMin && d <= type.rangeMax
  })
}

export function mapSizeOf(map: MapDef): { width: number; height: number } {
  return { width: map.width, height: map.height }
}
