/**
 * 自定义地图的**合法性校验**与工厂函数（纯函数，不碰存储与 DOM）。
 *
 * 为什么单独成模块：地图是"数据驱动"的核心输入，一旦结构不对，
 * 表现会是"对手无法部署""AI 卡死""渲染抛越界"这类**很难定位**的问题。
 * 因此编辑器在保存前、以及从 localStorage 读回时，都走同一份校验。
 *
 * 校验分两档：
 *  - `errors`：**不合法**，不能保存、不能入档、不能开局（会导致游戏跑不起来）；
 *  - `warnings`：合法但"大概不是你想要的"（比如某个玩家没有兵营、地图上没有中立村落），
 *    编辑器只提示、不拦。
 */

import { DATA } from './data'
import type { MapDef } from './data'
import type { GameData } from './data'

export type MapIssueLevel = 'error' | 'warning'

export interface MapIssue {
  level: MapIssueLevel
  /** 机器可读的短码，便于单测断言与将来做 i18n */
  code: string
  message: string
}

export interface MapValidationResult {
  errors: MapIssue[]
  warnings: MapIssue[]
  ok: boolean
}

/** 编辑器允许的尺寸范围（太大在手机上没法操作，太小放不下部署区） */
export const MIN_MAP_SIZE = 12
export const MAX_MAP_SIZE = 40
export const MIN_MAP_PLAYERS = 2
export const MAX_MAP_PLAYERS = 4

function issue(level: MapIssueLevel, code: string, message: string): MapIssue {
  return { level, code, message }
}

/** 坐标是否在地图内 */
export function inBounds(map: MapDef, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height
}

/** 取某格地形 id（不抛错，越界返回 null） */
export function terrainIdAt(map: MapDef, x: number, y: number): string | null {
  if (!inBounds(map, x, y)) return null
  return map.terrain[y * map.width + x] ?? null
}

/**
 * 校验一张地图。
 *
 * @param raw 待校验的未知值（可能是从 localStorage / 剪贴板读来的 JSON）
 * @param data 数据集（默认内置；单测可注入）
 */
export function validateMap(raw: unknown, data: GameData = DATA): MapValidationResult {
  const errors: MapIssue[] = []
  const warnings: MapIssue[] = []

  if (!raw || typeof raw !== 'object') {
    return { errors: [issue('error', 'shape', '地图不是一个对象')], warnings, ok: false }
  }
  const map = raw as Partial<MapDef>

  // ---------------------------------------------------------------- 元信息
  if (typeof map.id !== 'string' || map.id.trim() === '') {
    errors.push(issue('error', 'id', '缺少地图 id'))
  }
  if (typeof map.name !== 'string' || map.name.trim() === '') {
    errors.push(issue('error', 'name', '缺少地图名称'))
  } else if (map.name.trim().length > 24) {
    warnings.push(issue('warning', 'name-long', '地图名称偏长，大厅/设置页里可能会被截断'))
  }

  const width = map.width
  const height = map.height
  if (!Number.isInteger(width) || !Number.isInteger(height) || width === undefined || height === undefined) {
    errors.push(issue('error', 'size', '宽高必须是整数'))
    return { errors, warnings, ok: false }
  }
  if ((width as number) < MIN_MAP_SIZE || (width as number) > MAX_MAP_SIZE) {
    errors.push(issue('error', 'width', `宽度需在 ${MIN_MAP_SIZE}–${MAX_MAP_SIZE} 之间`))
  }
  if ((height as number) < MIN_MAP_SIZE || (height as number) > MAX_MAP_SIZE) {
    errors.push(issue('error', 'height', `高度需在 ${MIN_MAP_SIZE}–${MAX_MAP_SIZE} 之间`))
  }
  if (errors.length > 0) return { errors, warnings, ok: false }

  const w = width as number
  const h = height as number

  // ---------------------------------------------------------------- 地形
  if (!Array.isArray(map.terrain) || map.terrain.length !== w * h) {
    errors.push(
      issue('error', 'terrain-size', `地形数组长度应为 ${w * h}（宽 × 高），当前 ${Array.isArray(map.terrain) ? map.terrain.length : '不是数组'}`),
    )
    return { errors, warnings, ok: false }
  }
  const unknownTerrain = new Set<string>()
  // 纯水/纯山不是错误，但**没有一处能走的地形**会让所有人都动不了
  let passableCells = 0
  for (const id of map.terrain) {
    const terrain = data.terrain[id as string]
    if (!terrain) {
      unknownTerrain.add(String(id))
      continue
    }
    if (terrain.moveCost.foot !== null) passableCells += 1
  }
  if (unknownTerrain.size > 0) {
    errors.push(issue('error', 'terrain-unknown', `存在未知地形：${[...unknownTerrain].join('、')}`))
  }
  if (passableCells === 0) {
    errors.push(issue('error', 'no-passable', '整张地图没有步兵可通行的格子，开局后谁都动不了'))
  }

  // ---------------------------------------------------------------- 部署区
  const zones = map.deployZones
  if (!Array.isArray(zones) || zones.length < MIN_MAP_PLAYERS || zones.length > MAX_MAP_PLAYERS) {
    errors.push(
      issue('error', 'zones-count', `部署区数量需在 ${MIN_MAP_PLAYERS}–${MAX_MAP_PLAYERS} 之间（一个部署区 = 一个玩家席位）`),
    )
  } else {
    zones.forEach((zone, i) => {
      const bad =
        !zone ||
        !Number.isInteger(zone.x0) ||
        !Number.isInteger(zone.y0) ||
        !Number.isInteger(zone.x1) ||
        !Number.isInteger(zone.y1)
      if (bad) {
        errors.push(issue('error', 'zone-shape', `第 ${i + 1} 个部署区不是合法矩形`))
        return
      }
      if (zone.x0 < 0 || zone.y0 < 0 || zone.x1 >= w || zone.y1 >= h || zone.x0 > zone.x1 || zone.y0 > zone.y1) {
        errors.push(issue('error', 'zone-bounds', `第 ${i + 1} 个部署区超出地图范围或起止点颠倒`))
        return
      }
      let usable = 0
      for (let y = zone.y0; y <= zone.y1; y += 1) {
        for (let x = zone.x0; x <= zone.x1; x += 1) {
          const id = map.terrain![y * w + x]
          const terrain = data.terrain[id as string]
          if (terrain && terrain.moveCost.foot !== null) usable += 1
        }
      }
      if (usable === 0) {
        errors.push(issue('error', 'zone-unusable', `第 ${i + 1} 个部署区里没有可站立的格子，该玩家部署不了单位`))
      } else if (usable < (data.rules.deployMaxUnits ?? 4)) {
        warnings.push(
          issue('warning', 'zone-small', `第 ${i + 1} 个部署区只有 ${usable} 个可站立格，少于部署上限 ${data.rules.deployMaxUnits} 个单位`),
        )
      }
    })
  }

  const players = Array.isArray(zones) ? zones.length : 0

  // ---------------------------------------------------------------- 据点
  const buildings = map.buildings
  if (!Array.isArray(buildings)) {
    errors.push(issue('error', 'buildings', '缺少据点列表'))
    return { errors, warnings, ok: false }
  }

  const seenIds = new Set<string>()
  const seenCells = new Set<string>()
  const hqByOwner = new Map<number, number>()
  const barracksByOwner = new Map<number, number>()
  let neutralVillages = 0

  buildings.forEach((b, i) => {
    const label = `第 ${i + 1} 个据点`
    if (!b || typeof b !== 'object') {
      errors.push(issue('error', 'building-shape', `${label}不是合法对象`))
      return
    }
    if (typeof b.id !== 'string' || b.id.trim() === '') {
      errors.push(issue('error', 'building-id', `${label}缺少 id`))
    } else if (seenIds.has(b.id)) {
      errors.push(issue('error', 'building-id-dup', `据点 id 重复：${b.id}`))
    } else {
      seenIds.add(b.id)
    }
    if (!data.buildings[b.type]) {
      errors.push(issue('error', 'building-type', `${label}的类型未知：${b.type}`))
    }
    if (!Number.isInteger(b.x) || !Number.isInteger(b.y) || !inBounds(map as MapDef, b.x, b.y)) {
      errors.push(issue('error', 'building-bounds', `${label}坐标越界：(${b.x}, ${b.y})`))
      return
    }
    const cell = b.x + ',' + b.y
    if (seenCells.has(cell)) {
      errors.push(issue('error', 'building-cell-dup', `同一格上有多个据点：(${b.x}, ${b.y})`))
    } else {
      seenCells.add(cell)
    }

    const terrain = data.terrain[(map.terrain as string[])[b.y * w + b.x]]
    if (terrain && terrain.moveCost.foot === null) {
      errors.push(issue('error', 'building-terrain', `${label}压在不可通行的地形（${terrain.name}）上`))
    }
    if (terrain && terrain.id !== 'building') {
      warnings.push(
        issue('warning', 'building-terrain-mismatch', `${label}所在格的地形不是「据点」，保存时会自动补上（不影响开局）`),
      )
    }

    if (b.owner === null) {
      if (b.type === 'village') neutralVillages += 1
      return
    }
    if (!Number.isInteger(b.owner) || (b.owner as number) < 0 || (b.owner as number) >= players) {
      errors.push(issue('error', 'building-owner', `${label}的归属玩家序号 ${b.owner} 超出范围（0–${players - 1}）`))
      return
    }
    const owner = b.owner as number
    if (b.type === 'hq') hqByOwner.set(owner, (hqByOwner.get(owner) ?? 0) + 1)
    if (b.type === 'barracks') barracksByOwner.set(owner, (barracksByOwner.get(owner) ?? 0) + 1)
  })

  // 每个玩家必须有且只有一个王城（胜负判定依赖它）
  for (let p = 0; p < players; p += 1) {
    const hqCount = hqByOwner.get(p) ?? 0
    if (hqCount === 0) errors.push(issue('error', 'hq-missing', `玩家 ${p + 1} 没有王城：无法判定斩首胜负`))
    else if (hqCount > 1) errors.push(issue('error', 'hq-dup', `玩家 ${p + 1} 有 ${hqCount} 个王城，只能有一个`))
    const barracks = barracksByOwner.get(p) ?? 0
    if (barracks === 0) {
      warnings.push(issue('warning', 'barracks-missing', `玩家 ${p + 1} 没有兵营，整局都无法生产新单位`))
    }
  }
  if (neutralVillages === 0) {
    warnings.push(issue('warning', 'no-village', '地图上没有中立村落，双方都没有可抢的收入点，节奏会很慢'))
  }
  if (buildings.length === 0) {
    warnings.push(issue('warning', 'no-buildings', '地图上还没有任何据点'))
  }

  // 王城是否落在自己的部署区里（内置地图都满足；不满足时开局也能跑，但体验奇怪）
  if (Array.isArray(zones)) {
    buildings.forEach((b) => {
      if (!b || b.type !== 'hq' || b.owner === null) return
      const zone = zones[b.owner as number]
      if (!zone) return
      const inside = b.x >= zone.x0 && b.x <= zone.x1 && b.y >= zone.y0 && b.y <= zone.y1
      if (!inside) {
        warnings.push(
          issue('warning', 'hq-outside-zone', `玩家 ${(b.owner as number) + 1} 的王城 (${b.x}, ${b.y}) 不在自己的部署区内`),
        )
      }
    })
  }

  return { errors, warnings, ok: errors.length === 0 }
}

/** 校验结果转成人话（编辑器面板用） */
export function describeValidation(result: MapValidationResult): string {
  if (result.ok && result.warnings.length === 0) return '校验通过，可以保存'
  if (result.ok) return `校验通过（${result.warnings.length} 条提示）`
  return `发现 ${result.errors.length} 处问题，需修正后才能保存`
}
