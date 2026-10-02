/**
 * 局面评估（纯函数，无随机、无状态修改）。
 *
 * 返回**从 playerId 视角**的分数（越大越好）。AI 用它给候选指令排序，
 * 也用于"普通"难度的一步前瞻。
 *
 * 注意：不要在这里调用 applyCommand —— 那会深克隆整个状态。本函数必须是纯读。
 */

import { DATA, buildingType, unitType } from '../game/data'
import type { GameData } from '../game/data'
import { defenseOf } from '../game/board'
import { chebyshevDistance } from '../game/movement'
import type { GameState, PlayerId } from '../game/types'

/** 据点权重：王城 ≫ 兵营 > 村落 */
const BUILDING_WEIGHT: Record<string, number> = { hq: 6, barracks: 3, village: 1.5 }

const WIN_SCORE = 1_000_000

/**
 * 可选评分权重。**默认全为 0**，因此不传权重时评分与"加困难档之前"逐字一致
 * （普通/简单难度与既有单测都不受影响）；只有困难档会传进来。
 */
export interface EvaluateWeights {
  /** 抱团权重：己方单位离"己方重心"越远扣越多分 */
  cohesion?: number
}

export function evaluate(
  state: GameState,
  playerId: PlayerId,
  data: GameData = DATA,
  weights: EvaluateWeights = {},
): number {
  // 终局直接给极值，避免"已胜却还在算小分"
  if (state.winner === playerId) return WIN_SCORE
  if (state.eliminated.includes(playerId)) return -WIN_SCORE

  let score = 0

  // 1) 材料：按造价 × 剩余血量比例
  for (const unit of state.units) {
    const type = unitType(unit.type, data)
    const worth = type.cost * (unit.hp / type.hp)
    score += unit.owner === playerId ? worth : -worth
  }

  // 2) 据点与经济
  for (const building of state.buildings) {
    const type = buildingType(building.type, data)
    const value = (BUILDING_WEIGHT[building.type] ?? 1) * 100 + type.income * 0.5
    if (building.owner === playerId) score += value
    else if (building.owner !== null) score -= value

    // 正在被我方占领：进度本身有价值（差值法下，"占领中"优于"没开始"）
    if (building.capture && building.capture.playerId === playerId) score += building.capture.points * 25
  }

  // 3) 王城攻防与地形
  const myHq = state.buildings.find((b) => b.owner === playerId && b.type === 'hq')
  const enemyHqs = state.buildings.filter((b) => b.type === 'hq' && b.owner !== playerId)

  // 抱团（仅困难档）：以己方单位的重心为锚，离得越远扣越多
  const cohesion = weights.cohesion ?? 0
  const myUnits = cohesion > 0 ? state.units.filter((u) => u.owner === playerId) : []
  const center =
    myUnits.length > 0
      ? {
          x: myUnits.reduce((sum, u) => sum + u.x, 0) / myUnits.length,
          y: myUnits.reduce((sum, u) => sum + u.y, 0) / myUnits.length,
        }
      : null

  for (const unit of state.units) {
    if (unit.owner === playerId) {
      for (const hq of enemyHqs) {
        // 越靠近敌方王城越好（12 格以内线性计分）
        score += Math.max(0, 12 - chebyshevDistance(unit, hq)) * 8
      }
      // 站在高防御地形上更安全
      score += defenseOf(state, unit.x, unit.y, data) * 60
      if (center) score -= chebyshevDistance(unit, center) * cohesion
    } else if (myHq) {
      // 敌人逼近我方王城要扣分（扣得比加分更狠：先保命）
      score -= Math.max(0, 12 - chebyshevDistance(unit, myHq)) * 10
    }
  }

  // 4) 资金
  score += (state.funds[playerId] ?? 0) * 0.05
  for (const other of state.players) {
    if (other !== playerId) score -= (state.funds[other] ?? 0) * 0.05
  }

  return score
}
