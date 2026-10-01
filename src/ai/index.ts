/**
 * 本地 AI 对手（纯函数决策：给定状态，产出下一条指令）。
 *
 * 设计要点：
 *  1. 候选用 `legalCommandsFor` 产出，因此**返回的指令一定合法**（内核语义与它一一对应）；
 *  2. 候选打分用**免克隆的启发式**（computeDamage / chebyshevDistance 直接估算）；
 *     只有最终选中的那一条、以及"普通"难度 top-k 的一步前瞻才调用 applyCommand ——
 *     因为 `applyCommand` 每次都 JSON 深克隆整个 state，深搜会迅速变慢；
 *  3. 两档难度：easy（带噪随机、会漏操作、部署随意）/ normal（贪心 + 一步前瞻）；
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

export type Difficulty = 'easy' | 'normal'

/** 每回合 AI 最多执行的指令数：任何意外情况下都保证终止 */
export const MAX_AI_STEPS = 40

/** "普通"难度的部署计划：3 个步兵刚好用满 3000 预算 */
const DEPLOY_PLAN = ['sword', 'spear', 'sword']

/** "普通"难度做一步前瞻的候选数上限（每个候选要深克隆一次状态） */
const LOOKAHEAD_K = 5

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
  if (state.phase === 'DEPLOY') return pickDeploy(state, playerId, difficulty, data, random)
  return pickPlay(state, playerId, difficulty, data, random)
}

// ------------------------------------------------------------------ 部署阶段

function pickDeploy(
  state: GameState,
  playerId: PlayerId,
  difficulty: Difficulty,
  data: GameData,
  random: () => number,
): Command {
  const done: Command = { type: 'deployDone' }
  const entry = state.deploy[playerId]
  if (!entry) return done

  const deploys = deployCommandsFor(state, playerId, data).filter(
    (c): c is Extract<Command, { type: 'deploy' }> => c.type === 'deploy',
  )
  if (deploys.length === 0) return done

  // 达到计划数量就确认（避免把预算花光导致阵容畸形）
  const target = difficulty === 'easy' ? 1 + Math.floor(random() * 3) : DEPLOY_PLAN.length
  if (entry.placed >= target) return done

  if (difficulty === 'easy') {
    // 弱：兵种与落点都随机
    return deploys[Math.floor(random() * deploys.length)] ?? done
  }

  // 普通：优先按计划兵种，落点选"最靠前"（离敌方王城最近）的位置
  const wanted = DEPLOY_PLAN[entry.placed] ?? 'sword'
  const enemyHqs = state.buildings.filter((b) => b.type === 'hq' && b.owner !== playerId)

  let best = deploys[0]
  let bestScore = -Infinity
  for (const cmd of deploys) {
    const typeBonus = cmd.unitType === wanted ? 1000 : 0
    let forward = 0
    for (const hq of enemyHqs) {
      forward = Math.max(forward, 24 - chebyshevDistance(cmd, hq))
    }
    const value = typeBonus + forward
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
  difficulty: Difficulty,
  data: GameData,
  random: () => number,
): Command {
  const endTurnCmd: Command = { type: 'endTurn' }
  if (currentPlayer(state) !== playerId) return endTurnCmd

  const cmds = playCommandsFor(state, playerId, data)
  if (cmds.length === 0) return endTurnCmd

  const scored = cmds.map((cmd) => ({ cmd, score: scorePlay(state, playerId, cmd, data) }))
  const actions = scored.filter((s) => s.cmd.type !== 'endTurn')

  if (difficulty === 'easy') {
    const positive = actions.filter((s) => s.score > 0)
    if (positive.length === 0) return endTurnCmd
    if (random() < 0.25) return endTurnCmd // 偶尔直接过一手（给玩家留机会）
    positive.sort((a, b) => b.score - a.score)
    const top = positive.slice(0, 3)
    return top[Math.floor(random() * top.length)].cmd
  }

  // 普通：先取启发式最优，若无正收益就结束回合
  let bestHeuristic = actions[0]
  for (const item of actions) {
    if (bestHeuristic === undefined || item.score > bestHeuristic.score) bestHeuristic = item
  }
  if (bestHeuristic === undefined || bestHeuristic.score <= 0) return endTurnCmd

  // 一步前瞻：对启发式前 K 名做精确比较（每个候选深克隆一次，K 很小）
  actions.sort((a, b) => b.score - a.score)
  const base = evaluate(state, playerId, data)
  let best = bestHeuristic.cmd
  let bestDelta = -Infinity

  for (const candidate of actions.slice(0, LOOKAHEAD_K)) {
    const result = applyCommand(state, playerId, candidate.cmd, data)
    if (!result.ok) continue
    const delta = evaluate(result.state, playerId, data) - base
    if (delta > bestDelta) {
      bestDelta = delta
      best = candidate.cmd
    }
  }
  return best
}

/** 单条行动指令的启发式估值（不克隆状态） */
function scorePlay(state: GameState, playerId: PlayerId, cmd: Command, data: GameData): number {
  switch (cmd.type) {
    case 'attack':
      return scoreAttack(state, cmd.unitId, cmd.targetId, data)

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
      return scoreMove(state, playerId, cmd.unitId, cmd.x, cmd.y, data)

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

function scoreAttack(state: GameState, unitId: string, targetId: string, data: GameData): number {
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
  // 优先收残血目标
  score += defenderType.cost * 0.15 * (1 - defender.hp / defenderType.hp)
  return score
}

function scoreMove(
  state: GameState,
  playerId: PlayerId,
  unitId: string,
  x: number,
  y: number,
  data: GameData,
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

  // 目的地的敌方威胁（简化：2 格内敌方单位数）
  let threats = 0
  for (const other of state.units) {
    if (other.owner === playerId) continue
    if (chebyshevDistance(dest, other) <= 2) threats += 1
  }
  score -= threats * 25

  return score
}
