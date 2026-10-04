/** 数据驱动：所有数值来自 src/data/*.json（打包进产物，运行时零请求、可离线） */

import unitsJson from '../data/units.json'
import terrainJson from '../data/terrain.json'
import buildingsJson from '../data/buildings.json'
import matchupJson from '../data/matchup.json'
import rulesJson from '../data/rules.json'
import ancient01 from '../data/maps/ancient_01.json'
import ancient04 from '../data/maps/ancient_04.json'
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
  /** 每座兵营每回合可下达的生产指令数 */
  unitsPerBarracksPerTurn: number
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

/**
 * **内置地图**（随产物打包，人人都有）。
 *
 * 与"运行时地图表" `DATA.maps` 的区别很重要：
 *  - `BUILTIN_MAPS` 只含仓库里的官方地图，**大厅选图只用它** ——
 *    因为联机的其他玩家只可能拥有内置地图（自制地图没有随包分发，对方渲染不出来）；
 *  - `DATA.maps` 是可写的运行时表，游戏逻辑（`getMap` / 存档校验 / 渲染）都读它，
 *    自制地图通过 `registerMap` 注册进来，于是**单人练习**能直接开在自己的地图上。
 */
export const BUILTIN_MAPS: Record<string, MapDef> = {
  ancient_01: ancient01 as MapDef,
  ancient_04: ancient04 as MapDef,
}

export const DATA: GameData = {
  units: indexById(unitsJson.units as UnitType[]),
  unitList: unitsJson.units as UnitType[],
  terrain: indexById(terrainJson.terrains as TerrainType[]),
  buildings: indexById(buildingsJson.buildings as BuildingType[]),
  matchup: buildMatchup(),
  capturePoints: buildingsJson.capturePoints,
  rules: rulesJson as Rules,
  maps: { ...BUILTIN_MAPS },
}

/**
 * 把一张地图注册进运行时表（自制地图入口）。
 *
 * 为什么必须注册进 `DATA.maps` 而不是另开一张表：存储层与内核都靠
 * `state.mapId in DATA.maps` 判断"这个地图存不存在"（见 `net/gameStore.isPlausibleGame`），
 * 另开一张表就会导致"能开局、刷新后存档被判非法而清档"这类隐蔽问题。
 */
export function registerMap(map: MapDef, data: GameData = DATA): void {
  data.maps[map.id] = map
}

/** 从地图表里移除（删除自制地图时调用；内置地图请勿移除） */
export function unregisterMap(mapId: string, data: GameData = DATA): void {
  delete data.maps[mapId]
}

/** 运行时是否存在这张地图 */
export function hasMap(mapId: string, data: GameData = DATA): boolean {
  return Object.prototype.hasOwnProperty.call(data.maps, mapId)
}

export function mapInfoOf(map: MapDef): MapInfo {
  return {
    id: map.id,
    name: map.name,
    width: map.width,
    height: map.height,
    players: map.deployZones.length,
  }
}

export type MapInfo = {
  id: string
  name: string
  width: number
  height: number
  /** 部署区数量 = 可容纳的玩家数 */
  players: number
}

/** 地图清单（**只有内置地图**；房主在大厅里选，未选时按人数自动挑） */
export const MAP_LIST: MapInfo[] = Object.values(BUILTIN_MAPS).map(mapInfoOf)

/** 按人数自动推荐地图 */
export function defaultMapFor(playerCount: number): string {
  const exact = MAP_LIST.find((m) => m.players === playerCount)
  if (exact) return exact.id
  const enough = MAP_LIST.filter((m) => m.players >= playerCount).sort((a, b) => a.players - b.players)[0]
  return enough?.id ?? MAP_LIST[0].id
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
