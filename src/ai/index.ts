/**
 * 本地 AI 对手（纯函数决策：给定状态，产出下一条指令）。
 *
 * 设计要点：
 *  1. 候选用 `legalCommandsFor` 产出，因此**返回的指令一定合法**（内核语义与它一一对应）；
 *  2. 候选打分用**免克隆的启发式**（computeDamage / chebyshevDistance 直接估算）；
 *     只有最终选中的那一条、以及"普通"难度 top-k 的一步前瞻才调用 applyCommand ——
 *     因为 `applyCommand` 每次都 JSON 深克隆整个 state，深搜会迅速变慢；
 *  3. 三档难度由一张策略表（PROFILES）描述：
 *     easy（带噪随机、会漏操作、部署随意）/ normal（贪心 + 一步前瞻）/
 *     hard（同样的单步前瞻，但候选放宽到 12 个，并偏好集火残血与紧凑阵型）；
 *  4. **永不 resign**；
 *  5. 随机取自传入的 rng（或按状态散列出的确定性 rng），内核保持零随机、同种子可复现。
 */

import { DATA, buildingType, unitType } from '../game/data'
import type { GameData } from '../game/data'
import { buildingAt, defenseOf, unitById } from '../game/board'
import { canCounter, computeDamage } from '../game/combat'
import { chebyshevDistance } from '../game/movement'
import { currentPlayer } from '../game/state'
import { deployCommandsFor, playCommandsFor } from '../game/legalCommands'
import { applyCommand } from '../game/commands'
import { evaluate } from './evaluate'
import { hashSeed, mulberry32 } from './rng'
import type { Command, GameState, PlayerId } from '../game/types'

export type Difficulty = 'easy' | 'normal' | 'hard'

/** 每回合 AI 最多执行的指令数：任何意外情况下都保证终止 */
export const MAX_AI_STEPS = 40

/** 部署计划：3 个兵刚好用满 3000 预算 */
const DEPLOY_PLAN = ['sword', 'spear', 'sword']

/**
 * 难度档位的策略参数。
 *
 * 关键：`easy` / `normal` 的取值**刻意与"加困难档之前"逐字一致** ——
 * 把散落的 `difficulty === 'easy' ? ... : ...` 收敛成这张表时，不改变既有行为。
 *
 * 困难档靠什么变强？实测（普通 vs 困难，8 seed × 双方互换）：
 *  - **把前瞻候选从 5 放宽到 12 是决定性因素**，单这一项就能全胜普通（8/8）；
 *  - `focusFire` / `cohesion` 不影响胜负，只改变"选了哪一步"的风格（更爱补刀、阵型更紧）；
 *  - 曾试过"第二步：扣掉对手回手威胁"，反而退回 50% —— 过度保守，已放弃。
 */
interface AiProfile {
  /** 弱档：决策带噪（随机挑、偶尔漏操作、部署随意） */
  noisy: boolean
  /** 集火权重：乘在"残血目标价值"上（越大越执着于补刀） */
  focusFire: number
  /** 抱团权重：向己方单位重心靠拢才有的分（0 = 不抱团） */
  cohesion: number
  /** 精确比较（每个候选深克隆一次状态）的候选数上限 */
  lookaheadK: number
  /** 部署计划；空数组表示"随机部署" */
  deployPlan: string[]
}

const PROFILES: Record<Difficulty, AiProfile> = {
  easy: { noisy: true, focusFire: 0.15, cohesion: 0, lookaheadK: 0, deployPlan: [] },
  normal: {
    noisy: false,
    focusFire: 0.15,
    cohesion: 0,
    lookaheadK: 5,
    deployPlan: DEPLOY_PLAN,
  },
  hard: {
    noisy: false,
    focusFire: 0.6,
    cohesion: 3,
    lookaheadK: 12,
    deployPlan: DEPLOY_PLAN,
  },
}

/** 困难档：相邻友军能凑够伤害把目标打掉时，额外重奖（集火） */
const FOCUS_FINISH_BONUS = 80

/** 困难档部署时的"抱团"加成：每贴近已放置友军 1 格加多少分 */
const DEPLOY_COHESION_BONUS = 40

/**
 * 产出 AI 的下一条指令。
 * 调用方（pveSession）反复调用直到它返回 `endTurn`（或达到步数上限）。
 */
export function nextCommand(
  state: GameState,
  playerId: PlayerId,
  difficulty: Difficulty,
  data: GameData = DATA,
  rng?: () => number,
): Command {
  // 默认用"状态 + 身份 + 难度"散列出的种子：同局面必然同决策，便于复现与测试
  const random = rng ?? mulberry32(hashSeed(state.rev, state.turnSeq, state.turnIndex, playerId, difficulty))

  if (!state.players.includes(playerId)) return { type: 'endTurn' }
  if (state.phase === 'GAME_OVER') return { type: 'endTurn' }
  const profile = PROFILES[difficulty]
  if (state.phase === 'DEPLOY') return pickDeploy(state, playerId, data, random, profile)
  return pickPlay(state, playerId, data, random, profile)
}

// ------------------------------------------------------------------ 部署阶段

function pickDeploy(
  state: GameState,
  playerId: PlayerId,
  data: GameData,
  random: () => number,
  profile: AiProfile,
): Command {
  const done: Command = { type: 'deployDone' }
  const entry = state.deploy[playerId]
  if (!entry) return done

  const deploys = deployCommandsFor(state, playerId, data).filter(
    (c): c is Extract<Command, { type: 'deploy' }> => c.type === 'deploy',
  )
  if (deploys.length === 0) return done

  // 达到计划数量就确认（避免把预算花光导致阵容畸形）
  const target = profile.noisy ? 1 + Math.floor(random() * 3) : profile.deployPlan.length
  if (entry.placed >= target) return done

  if (profile.noisy) {
    // 弱：兵种与落点都随机
    return deploys[Math.floor(random() * deploys.length)] ?? done
  }

  // 普通 / 困难：优先按计划兵种，落点选"最靠前"（离敌方王城最近）
  const wanted = profile.deployPlan[entry.placed] ?? 'sword'
  const enemyHqs = state.buildings.filter((b) => b.type === 'hq' && b.owner !== playerId)
  const mine = profile.cohesion > 0 ? state.units.filter((u) => u.owner === playerId) : []

  let best = deploys[0]
  let bestScore = -Infinity
  for (const cmd of deploys) {
    const typeBonus = cmd.unitType === wanted ? 1000 : 0
    let forward = 0
    for (const hq of enemyHqs) {
      forward = Math.max(forward, 24 - chebyshevDistance(cmd, hq))
    }
    // 困难档：落点尽量贴着已放置的友军 —— 开局就成阵，不散成一盘沙
    let cohesion = 0
    if (mine.length > 0) {
      let nearest = Infinity
      for (const unit of mine) nearest = Math.min(nearest, chebyshevDistance(cmd, unit))
      if (nearest < Infinity) cohesion = Math.max(0, 4 - nearest) * DEPLOY_COHESION_BONUS
    }
    const value = typeBonus + forward + cohesion
    if (value > bestScore) {
      bestScore = value
      best = cmd
    }
  }
  return best
}

// ------------------------------------------------------------------ 行动阶段

function pickPlay(
  state: GameState,
  playerId: PlayerId,
  data: GameData,
  random: () => number,
  profile: AiProfile,
): Command {
  const endTurnCmd: Command = { type: 'endTurn' }
  if (currentPlayer(state) !== playerId) return endTurnCmd

  const cmds = playCommandsFor(state, playerId, data)
  if (cmds.length === 0) return endTurnCmd

  const scored = cmds.map((cmd) => ({ cmd, score: scorePlay(state, playerId, cmd, data, profile) }))
  const actions = scored.filter((s) => s.cmd.type !== 'endTurn')

  if (profile.noisy) {
    const positive = actions.filter((s) => s.score > 0)
    if (positive.length === 0) return endTurnCmd
    if (random() < 0.25) return endTurnCmd // 偶尔直接过一手（给玩家留机会）
    positive.sort((a, b) => b.score - a.score)
    const top = positive.slice(0, 3)
    return top[Math.floor(random() * top.length)].cmd
  }

  // 普通 / 困难：先取启发式最优，若无正收益就结束回合
  let bestHeuristic = actions[0]
  for (const item of actions) {
    if (bestHeuristic === undefined || item.score > bestHeuristic.score) bestHeuristic = item
  }
  if (bestHeuristic === undefined || bestHeuristic.score <= 0) return endTurnCmd

  // 前瞻：对启发式前 K 名做精确比较（每个候选深克隆一次，K 很小）
  actions.sort((a, b) => b.score - a.score)
  const base = evaluate(state, playerId, data, { cohesion: profile.cohesion })
  let best = bestHeuristic.cmd
  let bestDelta = -Infinity

  for (const candidate of actions.slice(0, profile.lookaheadK)) {
    const result = applyCommand(state, playerId, candidate.cmd, data)
    if (!result.ok) continue
    const delta = evaluate(result.state, playerId, data, { cohesion: profile.cohesion }) - base
    if (delta > bestDelta) {
      bestDelta = delta
      best = candidate.cmd
    }
  }
  return best
}

/** 单条行动指令的启发式估值（不克隆状态） */
function scorePlay(
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
      }
      return score
    }

    case 'move':
      return scoreMove(state, playerId, cmd.unitId, cmd.x, cmd.y, data, profile)

    case 'produce': {
      const type = data.units[cmd.unitType]
      if (!type) return -Infinity
      // 把钱变成兵：有价值，但不能压过"直接开打"
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

  // 直接踩上可占领的据点：下一步就能占领
  const here = buildingAt(state, dest.x, dest.y)
  if (here && here.owner !== playerId && unitType(unit.type, data).capture) score += 60

  // 高防御地形更安全
  score += defenseOf(state, dest.x, dest.y, data) * 30

  // 抱团（仅困难档）：向己方单位重心靠拢才加分，避免单枪匹马送人头
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

  // 目的地的敌方威胁（简化：2 格内敌方单位数）
  let threats = 0
  for (const other of state.units) {
    if (other.owner === playerId) continue
    if (chebyshevDistance(dest, other) <= 2) threats += 1
  }
  score -= threats * 25

  return score
}
