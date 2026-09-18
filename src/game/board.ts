/** 棋盘查询辅助（不修改状态） */

import { DATA, getMap, moveCost, terrainAt } from './data'
import type { GameData, MapDef } from './data'
import type { BuildingState, GameState, PlayerId, Unit } from './types'

export function mapOf(state: GameState, data: GameData = DATA): MapDef {
  return getMap(state.mapId, data)
}

export function tileKey(x: number, y: number): string {
  return x + ',' + y
}

export function unitAt(state: GameState, x: number, y: number): Unit | undefined {
  return state.units.find((u) => u.x === x && u.y === y)
}

export function buildingAt(state: GameState, x: number, y: number): BuildingState | undefined {
  return state.buildings.find((b) => b.x === x && b.y === y)
}

export function unitById(state: GameState, id: string): Unit | undefined {
  return state.units.find((u) => u.id === id)
}

export function buildingById(state: GameState, id: string): BuildingState | undefined {
  return state.buildings.find((b) => b.id === id)
}

export function isPassable(state: GameState, x: number, y: number, moveType: Unit['type'] extends never ? never : 'foot' | 'horse' | 'siege', data: GameData = DATA): boolean {
  return moveCost(mapOf(state, data), x, y, moveType, data) !== null
}

export function defenseOf(state: GameState, x: number, y: number, data: GameData = DATA): number {
  return terrainAt(mapOf(state, data), x, y, data).defense
}

export function unitsOf(state: GameState, playerId: PlayerId): Unit[] {
  return state.units.filter((u) => u.owner === playerId)
}

export function buildingsOf(state: GameState, playerId: PlayerId): BuildingState[] {
  return state.buildings.filter((b) => b.owner === playerId)
}

export function inDeployZone(map: MapDef, playerIndex: number, x: number, y: number): boolean {
  const zone = map.deployZones[playerIndex]
  if (!zone) return false
  return x >= zone.x0 && x <= zone.x1 && y >= zone.y0 && y <= zone.y1
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
