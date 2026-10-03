/**
 * 候选指令的**启发式估值**（免克隆：不调用 applyCommand）。
 *
 * 从 `index.ts` 抽出（切片 2）：搜索层需要在每一层给候选排序，
 * 若 `search.ts` 反向 import `index.ts` 会形成循环依赖，故独立成模块。
 * **函数体逐字搬运**，`easy` / `normal` / `hard` 行为不变（由既有 241 条单测护航）。
 *
 * 约定：所有分值都是**从 `playerId` 视角**（越大越该做）；`-Infinity` 表示"绝不该做"。
 */

import { buildingType, unitType } from '../game/data'
import type { GameData } from '../game/data'
import { buildingAt, defenseOf, unitById } from '../game/board'
import { baseDamage, canCounter, computeDamage } from '../game/combat'
import { chebyshevDistance } from '../game/movement'
import type { AiProfile } from './profile'
import type { Command, GameState, PlayerId } from '../game/types'

/** 困难档：相邻友军能凑够伤害把目标打掉时，额外重奖（集火） */
const FOCUS_FINISH_BONUS = 80

/**
 * 平局打破的容差：并列候选（分差 < ε）视为"实战等价"，用传入的 rng 任选其一。
 *
 * 为什么需要它：normal / hard 本身不消耗随机数（纯确定性策略），
 * 同一对局配置下永远走出同一盘棋 —— 对战评估台（scripts/ai-bench.ts）会因此只剩
 * "座位互换"这一个变异源，独立样本少得可怜。引入 ε 平局打破后：
 * 同一种子仍然可复现（rng 由种子派生），但不同种子会走出不同的棋。
 * ε 相对分值量级（几十到几百）很小，不影响强度结论。
 */
export const TIE_EPSILON = 2

/** 困难档部署时的"抱团"加成：每贴近已放置友军 1 格加多少分 */
export const DEPLOY_COHESION_BONUS = 40

/**
 * 走位风险折扣：`scoreMove` 里的威胁罚按 threat × 本系数折算。
 *
 * 为什么打折：`scoreMove` 的其余项（靠近据点每格 12~90 分）量级只有几十，
 * 而"预计承受伤害"动辄 100+，同一权重下会把所有走位打成负分 —— 实测后果是
 * AI 触发"最优分为负就结束回合"的早退，站着不动（fixtures 上 0/8）。
 * 风险在**前瞻差分**（evaluate 里的威胁项）里已按全权重计入，这里只需要一个
 * 不失真的排序信号。
 */
const MOVE_RISK_FACTOR = 0.3

/** 单条行动指令的启发式估值（不克隆状态） */
export function scorePlay(
  state: GameState,
  playerId: PlayerId,
  cmd: Command,
  data: GameData,
  profile: AiProfile,
): number {
  switch (cmd.type) {
    case 'attack':
      return scoreAttack(state, cmd.unitId, cmd.targetId, data, profile)

    case 'capture': {
      const unit = unitById(state, cmd.unitId)
      if (!unit) return -Infinity
      const building = buildingAt(state, unit.x, unit.y)
      if (!building) return -Infinity
      const carried = building.capture && building.capture.playerId === playerId ? building.capture.points : 0
      const points = carried + Math.floor(unit.hp / 10)
      let score = 40 + points * 6
      if (points >= data.rules.capturePoints) {
        // 这一下就能拿下据点：收入与战略价值都很高
        score += 500 + buildingType(building.type, data).income * 1.5
        // v2：易主要等 RESOLVE 阶段才生效 —— 前瞻里看不到"收入归我"，
        // 所以必须在这里把"拿下后每回合多出来的收入"显式补上
        if (profile.economy > 0) {
          score += buildingType(building.type, data).income * profile.economy * 0.8
        }
      }
      return score
    }

    case 'move':
      return scoreMove(state, playerId, cmd.unitId, cmd.x, cmd.y, data, profile)

    case 'produce': {
      const type = data.units[cmd.unitType]
      if (!type) return -Infinity
      if (profile.smartProduce) return scoreProduce(state, playerId, cmd.unitType, data, profile)
      // v1：把钱变成兵（不能压过"直接开打"）
      let score = type.cost * 0.15
      if ((state.funds[playerId] ?? 0) > type.cost * 2) score += 25
      return score
    }

    case 'wait':
    case 'endTurn':
      return 0

    default:
      return -Infinity
  }
}

function scoreAttack(
  state: GameState,
  unitId: string,
  targetId: string,
  data: GameData,
  profile: AiProfile,
): number {
  const attacker = unitById(state, unitId)
  const defender = unitById(state, targetId)
  if (!attacker || !defender) return -Infinity

  const defenderType = unitType(defender.type, data)
  const attackerType = unitType(attacker.type, data)
  const damage = computeDamage(state, attacker, defender, data)
  const kills = damage >= defender.hp

  let score = damage * 4
  if (kills) {
    score += defenderType.cost * 1.2
  } else if (canCounter(attacker, defender, data)) {
    const counter = computeDamage(state, defender, attacker, data)
    score -= counter * 3
    if (counter >= attacker.hp) score -= attackerType.cost // 会被反杀：重罚
  }
  // 优先收残血目标（困难档权重更高：focusFire 0.15 → 0.6）
  score += defenderType.cost * profile.focusFire * (1 - defender.hp / defenderType.hp)

  // 困难档额外：把相邻友军的补刀算进来，凑得死就重奖 —— 这就是"集火"
  if (!kills && profile.focusFire > 0.15) {
    let incoming = damage
    for (const mate of state.units) {
      if (mate.owner !== attacker.owner || mate.id === attacker.id || mate.acted) continue
      if (chebyshevDistance(mate, defender) > 1) continue
      incoming += computeDamage(state, mate, defender, data)
      if (incoming >= defender.hp) break
    }
    if (incoming >= defender.hp) score += FOCUS_FINISH_BONUS
  }

  return score
}

function scoreMove(
  state: GameState,
  playerId: PlayerId,
  unitId: string,
  x: number,
  y: number,
  data: GameData,
  profile: AiProfile,
): number {
  const unit = unitById(state, unitId)
  if (!unit) return -Infinity
  const dest = { x, y }
  let score = 0

  // 靠近敌方王城
  for (const hq of state.buildings) {
    if (hq.type !== 'hq' || hq.owner === playerId) continue
    const before = chebyshevDistance(unit, hq)
    const after = chebyshevDistance(dest, hq)
    if (after < before) score = Math.max(score, (before - after) * 14)
  }

  // 靠近可占领据点（中立村落 / 敌方据点）
  for (const building of state.buildings) {
    if (building.owner === playerId) continue
    const before = chebyshevDistance(unit, building)
    const after = chebyshevDistance(dest, building)
    if (after < before) score = Math.max(score, (before - after) * 12)
  }

  // v2 经济：按"收入价值"重估靠近收益 —— 村落（收入 400）每格 30 分、王城（1200）每格 90 分，
  // 而不是 v1 对任何据点一视同仁的每格 12 分
  if (profile.economy > 0) {
    for (const building of state.buildings) {
      if (building.owner === playerId) continue
      const before = chebyshevDistance(unit, building)
      const after = chebyshevDistance(dest, building)
      if (after >= before) continue
      const pull = (buildingType(building.type, data).income * profile.economy) / 40
      score = Math.max(score, (before - after) * pull)
    }
  }

  // 直接踩上可占领的据点：下一步就能占领
  const here = buildingAt(state, dest.x, dest.y)
  if (here && here.owner !== playerId && unitType(unit.type, data).capture) score += 60

  // 高防御地形更安全
  score += defenseOf(state, dest.x, dest.y, data) * 30

  // 抱团（v1 困难档用过；v2 起不再使用 —— 它正是真实地图上阶梯倒挂的元凶之一）
  if (profile.cohesion > 0) {
    const mates = state.units.filter((u) => u.owner === playerId && u.id !== unitId)
    if (mates.length > 0) {
      let sumX = 0
      let sumY = 0
      for (const mate of mates) {
        sumX += mate.x
        sumY += mate.y
      }
      const center = { x: sumX / mates.length, y: sumY / mates.length }
      const before = chebyshevDistance(unit, center)
      const after = chebyshevDistance(dest, center)
      if (after < before) score += profile.cohesion * (before - after)
    }
  }

  // —— v2：目的地的风险评估 ——
  if (profile.threat > 0) {
    // 用"预计承受伤害"替代 v1 的"2 格内敌人数"：能打到我的单位 × 各自的伤害
    // （地形减伤取目的地所在格；这是免克隆的估算，与 evaluate 的威胁项同源思路）
    const defense = defenseOf(state, dest.x, dest.y, data)
    let incoming = 0
    for (const other of state.units) {
      if (other.owner === playerId) continue
      const otherType = unitType(other.type, data)
      if (chebyshevDistance(dest, other) > otherType.move + otherType.rangeMax) continue
      const base = baseDamage(other.type, unit.type, data)
      if (base <= 0) continue
      incoming += Math.max(
        data.rules.minDamage,
        Math.floor(base * (Math.max(0, other.hp) / otherType.hp) * (1 - defense)),
      )
    }
    score -= incoming * profile.threat * MOVE_RISK_FACTOR
  } else {
    // v1：目的地的敌方威胁（简化：2 格内敌方单位数）
    let threats = 0
    for (const other of state.units) {
      if (other.owner === playerId) continue
      if (chebyshevDistance(dest, other) <= 2) threats += 1
    }
    score -= threats * 25
  }

  // 残血单位躲进己方据点：下一 START 免费回血（补给线，独立开关）
  if (profile.repair > 0) {
    const type = unitType(unit.type, data)
    if (unit.hp < type.hp && here && here.owner === playerId) {
      score += Math.min(data.rules.repairPerTurn, type.hp - unit.hp) * profile.repair * 0.5
    }
  }

  return score
}

/**
 * v2 生产策略：按"每 1000 军费的战力"选兵，而不是 v1 的"越贵越优先"。
 *
 * v1 的 `cost × 0.15` 让重骑兵（600 分）永远排第一，同价位的刀盾兵（150 分）垫底 ——
 * 4 个刀盾兵换 1 个重骑兵是明显亏的。v2 改成：
 *   战力 ≈ 血量 + 对敌阵平均伤害 × 1.5，再除以"每千军费"；
 * 并补两个修正：占领手不足时优先可占领兵种；手头宽裕时略微偏好质优单位（别攒死钱）。
 */
function scoreProduce(
  state: GameState,
  playerId: PlayerId,
  unitTypeId: string,
  data: GameData,
  profile: AiProfile,
): number {
  const type = data.units[unitTypeId]
  if (!type) return -Infinity

  const enemies = state.units.filter((u) => u.owner !== playerId)
  let avgDamage = 50 // 无敌军时的中性值
  if (enemies.length > 0) {
    let sum = 0
    for (const enemy of enemies) sum += baseDamage(unitTypeId, enemy.type, data)
    avgDamage = sum / enemies.length
  }

  const power = type.hp + avgDamage * 1.5
  let score = (power / Math.max(1, type.cost / 1000)) * 1.2
  // 克制：对敌阵平均伤害越高越值得造（counter 档位权重）
  score += profile.counter * avgDamage
  // 占领手不足（据点 = 经济命脉）：优先补可占领兵种
  const capturers = state.units.filter((u) => u.owner === playerId && unitType(u.type, data).capture).length
  if (type.capture && capturers < 2) score += 120
  // 手头宽裕时别把军费攒成死钱
  if ((state.funds[playerId] ?? 0) > type.cost * 3) score += 30
  return score
}

/** 在"与最高分分差 < ε"的并列候选里用 rng 任选；无并列时结果就是原来的最高分（不消耗 rng） */
export function pickTieBreak<T>(
  scored: Array<{ cmd: T; value: number }>,
  bestScore: number,
  random: () => number,
): T {
  const top = scored.filter((s) => s.value >= bestScore - TIE_EPSILON)
  if (top.length <= 1) return (top[0] ?? scored[0]).cmd
  return top[Math.floor(random() * top.length)].cmd
}
