/**
 * 局面评估（纯函数，无随机、无状态修改）。
 *
 * 返回**从 playerId 视角**的分数（越大越好）。AI 用它给候选指令排序，
 * 也用于各难度的候选前瞻差分。
 *
 * 结构约定：**基础项（v1）+ v2 开关项**。
 *  - 基础项与"加 v2 之前"逐字一致，且不传权重时金额完全不变 —— 因此简单 / 普通
 *    两档（以及全部既有单测）行为不受影响；
 *  - v2 开关项由调用方按难度打开：经济（收入时间价值）、威胁（预计承受伤害）、
 *    守土（占领博弈 + 王城警报）、补给（据点回血）、比分（临近回合上限按 GDD 9.2 计分）。
 *
 * **对称性约束**：每个开关项都必须是"零和"的 —— 交换双方归属后，
 * evaluate(swap(s), P2) 必须等于 evaluate(s, P1)。tests/unit/ai/evaluate.test.ts
 * 有一条专门的对称性断言（含打开全部开关的用例），新增项若破坏它就会红。
 *
 * 注意：不要在这里调用 applyCommand —— 那会深克隆整个状态。本函数必须是纯读。
 */

import { DATA, buildingType, unitType } from '../game/data'
import type { GameData } from '../game/data'
import { buildingAt, defenseOf } from '../game/board'
import { computeDamage } from '../game/combat'
import { chebyshevDistance } from '../game/movement'
import { scoreOf } from '../game/state'
import type { GameState, PlayerId } from '../game/types'

/** 据点权重：王城 ≫ 兵营 > 村落 */
const BUILDING_WEIGHT: Record<string, number> = { hq: 6, barracks: 3, village: 1.5 }

const WIN_SCORE = 1_000_000

/**
 * 王城正在被敌方占领的警报分。
 * 斩首 = 立即淘汰，所以它必须压过任何"材料得失"（最强单位重骑兵也只值 4000）：
 * 只要还有一个候选能解围，评估分就会把 AI 拽过去；若解不了，各候选的警报相同 → 自动抵消。
 */
const HQ_ALARM = 20_000

/** 终局计分（GDD 9.2）在评估中的放大系数：一个据点分 ≈ 150 评估分 */
const SCORE_FACTOR = 150

/**
 * 可选评分权重。**默认全为 0 / false**，因此不传权重时评分与 v1 逐字一致
 * （简单/普通难度与既有单测都不受影响）；只有困难档会打开这些开关。
 */
export interface EvaluateWeights {
  /** 抱团权重：己方单位离"己方重心"越远扣越多分 */
  cohesion?: number
  /** 经济：每 1 点据点收入折算的分数（收入的"时间价值"，v1 只有 income × 0.5） */
  economy?: number
  /** 威胁：每 1 点"预计承受伤害"扣的分数（同时按零和折算敌军受我威胁） */
  threat?: number
  /** 守土：每 1 点敌方占领进度扣的分数（有主据点 ×1.5）；并启用王城警报 */
  defend?: number
  /** 补给：残血单位驻守己方据点的"可回血量"每点折算的分数 */
  repair?: number
  /** 比分意识：临近回合上限时按 GDD 9.2 计分表叠加分差 */
  scoreAware?: boolean
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

  const economy = weights.economy ?? 0
  const threat = weights.threat ?? 0
  const defend = weights.defend ?? 0
  const repair = weights.repair ?? 0
  const cohesion = weights.cohesion ?? 0

  let score = 0

  // 1) 材料：按造价 × 剩余血量比例
  for (const unit of state.units) {
    const type = unitType(unit.type, data)
    const worth = type.cost * (unit.hp / type.hp)
    score += unit.owner === playerId ? worth : -worth
  }

  // 2) 据点与经济 / 占领博弈
  for (const building of state.buildings) {
    const type = buildingType(building.type, data)
    const value = (BUILDING_WEIGHT[building.type] ?? 1) * 100 + type.income * 0.5
    const mine = building.owner === playerId
    if (mine) score += value
    else if (building.owner !== null) score -= value

    // v2 经济：收入的时间价值（一座村落 400/回合，远不止 v1 的 200 分）
    if (economy > 0 && building.owner !== null) score += (mine ? 1 : -1) * type.income * economy

    if (building.capture) {
      const iAmCapturing = building.capture.playerId === playerId

      // 正在被我方占领：进度本身有价值（v1 已有）
      if (iAmCapturing) score += building.capture.points * 25

      // v2 守土：正在被敌方占领 → 按进度扣分（有主据点更重要）；王城另有警报
      if (defend > 0) {
        const importance = building.owner === null ? 1 : 1.5
        score += (iAmCapturing ? 1 : -1) * building.capture.points * defend * importance
        if (building.type === 'hq') score += (iAmCapturing ? 1 : -1) * HQ_ALARM
      }
    }
  }

  // 3) 王城攻防与地形 / 威胁 / 补给
  const myHq = state.buildings.find((b) => b.owner === playerId && b.type === 'hq')
  const enemyHqs = state.buildings.filter((b) => b.type === 'hq' && b.owner !== playerId)
  const myUnits =
    cohesion > 0 || threat > 0 || repair > 0 ? state.units.filter((u) => u.owner === playerId) : []
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

  // v2 威胁（零和）：谁能在下一手打到我 / 我能打到谁。
  // 己方单位"可能承受的伤害"扣分，敌方单位承受的伤害同额度加分 ——
  // 同一公式从两侧看互为相反数，因此不破坏对称性。
  if (threat > 0) {
    const enemyUnits = state.units.filter((u) => u.owner !== playerId)
    const friends = state.units.filter((u) => u.owner === playerId)
    let net = 0
    for (const unit of state.units) {
      const foes = unit.owner === playerId ? enemyUnits : friends
      let incoming = 0
      for (const foe of foes) {
        const foeType = unitType(foe.type, data)
        // 乐观可达判据：忽略地形与阻挡，只保证"够得到"
        if (chebyshevDistance(foe, unit) > foeType.move + foeType.rangeMax) continue
        incoming += computeDamage(state, foe, unit, data)
      }
      net += unit.owner === playerId ? -incoming : incoming
    }
    score += net * threat
  }

  // v2 补给：残血单位站在己方据点上（下一 START 自动回血 rules.repairPerTurn）
  if (repair > 0) {
    for (const unit of myUnits) {
      const type = unitType(unit.type, data)
      if (unit.hp >= type.hp) continue
      const here = buildingAt(state, unit.x, unit.y)
      if (!here || here.owner !== playerId) continue
      score += Math.min(data.rules.repairPerTurn, type.hp - unit.hp) * repair
    }
  }

  // 4) 资金
  score += (state.funds[playerId] ?? 0) * 0.05
  for (const other of state.players) {
    if (other !== playerId) score -= (state.funds[other] ?? 0) * 0.05
  }

  // v2 比分意识：临近回合上限（GDD 9.2 兜底计分）时，领先就该保、落后就该拼
  if (weights.scoreAware && state.round >= data.rules.roundLimit - 4) {
    const mine = scoreOf(state, playerId, data)
    let best = -Infinity
    for (const other of state.players) {
      if (other === playerId || state.eliminated.includes(other)) continue
      best = Math.max(best, scoreOf(state, other, data))
    }
    if (best > -Infinity) score += (mine - best) * SCORE_FACTOR
  }

  return score
}
