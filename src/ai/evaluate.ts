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
import { baseDamage, computeDamage } from '../game/combat'
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

  // —— 切片 3（评估器 v3）：全部默认 0，只有新档 `master` / `expert` 打开 ——

  /**
   * E1：`pending`（**已付费、未出场**）按造价的这个比例计入材料分。
   * 现状是"下单即亏分"（评估看不见订单），AI 因而不愿把军费转成兵力。
   */
  pendingMaterial?: number
  /** E2：单位"对敌方阵容的平均伤害"折算的分数系数（兵种克制的价值，v1 完全没用上 matchup 表） */
  counterValue?: number
  /** E3：远程单位处于"能打到敌、而敌打不到我"的站位时，按造价加成的系数 */
  rangedSafety?: number
  /**
   * E4：暴露面 —— 单位处于敌方可达范围、且**预计承受伤害 ≥ 其血量**（即会被打死）时，
   * 按造价扣分的系数。**只在"致命"这一档触发**：切片 1 的教训是乘性、大权重的静态威胁项
   * 会压过材料分（单项消融 0/16 胜），因此这里严格限定为加法 + 单档触发。
   */
  exposure?: number
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
  const pendingMaterial = weights.pendingMaterial ?? 0
  const counterValue = weights.counterValue ?? 0
  const rangedSafety = weights.rangedSafety ?? 0
  const exposure = weights.exposure ?? 0

  let score = 0

  // 1) 材料：按造价 × 剩余血量比例
  for (const unit of state.units) {
    const type = unitType(unit.type, data)
    const worth = type.cost * (unit.hp / type.hp)
    score += unit.owner === playerId ? worth : -worth
  }

  // 1b) E1（切片 3）：`pending`（已付费、未出场）计入材料分。
  // 评估原先完全看不见订单 → 生产会表现为"白扣军费"，AI 因而不愿把军费转成兵力。
  // 按造价打 pendingMaterial 折（未出场，不该按满值算）。零和：己方加、对手减。
  if (pendingMaterial > 0) {
    for (const order of state.pending) {
      const type = unitType(order.type, data)
      score += (order.owner === playerId ? 1 : -1) * type.cost * pendingMaterial
    }
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

  // ---- 以下是切片 3（评估器 v3）的新项。全部走权重开关、默认 0；一律加法、零和对称。----

  // E2（切片 3）：兵种克制的价值 —— 单位值多少分，应看它"对**敌方阵容**能打出多少伤害"，
  // 而不是只看造价（v1 完全没用上 matchup 伤害表：枪克骑、盾克步…全部浪费）。
  if (counterValue > 0) {
    for (const unit of state.units) {
      const foes = state.units.filter((u) => u.owner !== unit.owner)
      if (foes.length === 0) continue
      let sum = 0
      for (const foe of foes) sum += baseDamage(unit.type, foe.type, data)
      score += (unit.owner === playerId ? 1 : -1) * (sum / foes.length) * counterValue
    }
  }

  // E3（切片 3）：远程单位的安全站位 —— "我能打到你、你打不到我"（放风筝）。
  // 现状是 AI 会拿投石车/弓兵贴身去拱王城（诊断 §4 点名的问题）。
  if (rangedSafety > 0) {
    for (const unit of state.units) {
      const type = unitType(unit.type, data)
      if (type.rangeMax < 2) continue // 只对远程单位有意义
      const foes = state.units.filter((u) => u.owner !== unit.owner)
      if (foes.length === 0) continue
      let canShoot = false
      let canBeShot = false
      for (const foe of foes) {
        const foeType = unitType(foe.type, data)
        const d = chebyshevDistance(unit, foe)
        if (d >= type.rangeMin && d <= type.rangeMax) canShoot = true
        if (d <= foeType.rangeMax) canBeShot = true
      }
      if (canShoot && !canBeShot) {
        score += (unit.owner === playerId ? 1 : -1) * type.cost * rangedSafety
      }
    }
  }

  // E4（切片 3）：暴露面 —— **只在"会被打死"这一档**触发。
  // 切片 1 的静态威胁项用乘性大权重，多项相乘达 ±几千分、压过材料分，实测 0/16 胜。
  // 这里严格限定：加法、单档（预计承受伤害 ≥ 自身血量才触发）、小权重。
  if (exposure > 0) {
    for (const unit of state.units) {
      const type = unitType(unit.type, data)
      let incoming = 0
      for (const foe of state.units) {
        if (foe.owner === unit.owner) continue
        const foeType = unitType(foe.type, data)
        if (chebyshevDistance(foe, unit) > foeType.move + foeType.rangeMax) continue
        incoming += computeDamage(state, foe, unit, data)
      }
      if (incoming >= unit.hp) {
        score += (unit.owner === playerId ? -1 : 1) * type.cost * exposure
      }
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
