/** 数据驱动：所有数值来自 src/data/*.json（打包进产物，运行时零请求、可离线） */

import unitsJson from '../data/units.json'
import terrainJson from '../data/terrain.json'
import buildingsJson from '../data/buildings.json'
import matchupJson from '../data/matchup.json'
import rulesJson from '../data/rules.json'
import ancient01 from '../data/maps/ancient_01.json'
import type { BuildingState, BuildingType, MoveType, TerrainType, UnitType } from './types'

export type MapDef = {
  id: string
  name: string
  width: number
  height: number
  terrain: string[]
  buildings: Array<{ id: string; type: string; x: number; y: number; owner: number | null }>
  deployZones: Array<{ x0: number; y0: number; x1: number; y1: number }>
}

export type Rules = {
  maxPlayers: number
  roundLimit: number
  startFunds: number
  deployBudget: number
  deployMaxUnits: number
  unitCap: number
  minDamage: number
  repairPerTurn: number
  capturePoints: number
}

export type GameData = {
  units: Record<string, UnitType>
  unitList: UnitType[]
  terrain: Record<string, TerrainType>
  buildings: Record<string, BuildingType>
  /** matchup[attackerType][defenderType] = 对满血目标的基础伤害 */
  matchup: Record<string, Record<string, number>>
  capturePoints: number
  rules: Rules
  maps: Record<string, MapDef>
}

function indexById<T extends { id: string }>(list: T[]): Record<string, T> {
  const out: Record<string, T> = {}
  for (const item of list) out[item.id] = item
  return out
}

function buildMatchup(): Record<string, Record<string, number>> {
  const order = matchupJson.order as string[]
  const table = matchupJson.damage as number[][]
  const out: Record<string, Record<string, number>> = {}
  order.forEach((attacker, i) => {
    out[attacker] = {}
    order.forEach((defender, j) => {
      out[attacker][defender] = table[i][j]
    })
  })
  return out
}

export const DATA: GameData = {
  units: indexById(unitsJson.units as UnitType[]),
  unitList: unitsJson.units as UnitType[],
  terrain: indexById(terrainJson.terrains as TerrainType[]),
  buildings: indexById(buildingsJson.buildings as BuildingType[]),
  matchup: buildMatchup(),
  capturePoints: buildingsJson.capturePoints,
  rules: rulesJson as Rules,
  maps: { ancient_01: ancient01 as MapDef },
}

export function unitType(id: string, data: GameData = DATA): UnitType {
  const t = data.units[id]
  if (!t) throw new Error('未知兵种: ' + id)
  return t
}

export function terrainAt(map: MapDef, x: number, y: number, data: GameData = DATA): TerrainType {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) throw new Error('越界: ' + x + ',' + y)
  const id = map.terrain[y * map.width + x]
  const t = data.terrain[id]
  if (!t) throw new Error('未知地形: ' + id)
  return t
}

export function moveCost(map: MapDef, x: number, y: number, moveType: MoveType, data: GameData = DATA): number | null {
  const t = terrainAt(map, x, y, data)
  return t.moveCost[moveType] ?? null
}

export function defenseAt(map: MapDef, x: number, y: number, data: GameData = DATA): number {
  return terrainAt(map, x, y, data).defense
}

export function getMap(mapId: string, data: GameData = DATA): MapDef {
  const map = data.maps[mapId]
  if (!map) throw new Error('未知地图: ' + mapId)
  return map
}

export function buildingType(id: string, data: GameData = DATA): BuildingType {
  const t = data.buildings[id]
  if (!t) throw new Error('未知据点: ' + id)
  return t
}

/** 由地图定义构造初始据点状态（owner 用玩家序号） */
export function initialBuildings(map: MapDef, players: string[]): BuildingState[] {
  return map.buildings.map((b) => ({
    id: b.id,
    type: b.type,
    x: b.x,
    y: b.y,
    owner: b.owner === null ? null : (players[b.owner] ?? null),
    capture: null,
  }))
}
