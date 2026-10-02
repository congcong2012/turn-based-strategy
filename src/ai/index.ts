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
 *  5. 随机取自传入的 rng（或按状态散列出的确定性 rng），内核保持零随机、同种子可复现；
 *     普通 / 困难唯一的 rng 消费是 TIE_EPSILON 平局打破 —— 让不同种子走出不同的棋，
 *     是对战评估台（scripts/ai-bench.ts）能积累独立样本的前提。
 */

import { DATA, buildingType, unitType } from '../game/data'
import type { GameData } from '../game/data'
import { buildingAt, defenseOf, unitById } from '../game/board'
import { baseDamage, canCounter, computeDamage } from '../game/combat'
import { chebyshevDistance } from '../game/movement'
import { currentPlayer } from '../game/state'
import { deployCommandsFor, playCommandsFor } from '../game/legalCommands'
import { applyCommand } from '../game/commands'
import { evaluate } from './evaluate'
import type { EvaluateWeights } from './evaluate'
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
 * 关键：`easy` / `normal` 的取值**刻意与"加 v2 之前"逐字一致** ——
 * 加上 v2 开关后同样遵守这条（这两档的 v2 开关全部为 0 / false，行为零变化）。
 *
 * 困难档靠什么变强？实测（`scripts/ai-bench.ts`，真实地图，60 局/对阵）：
 *  - v1 的 hard 只把前瞻候选 5 → 12 并打开 `cohesion`，结果在真实地图上**倒挂**：
 *    hard 仅 11.7% 胜 normal（`docs/ai-baseline.md`）。根因是评估器把经济压到噪声级
 *    （村落值 200 分 < 一次攻击 220 分），而 cohesion 又惩罚分散占点。
 *  - v2 改为五类开关（经济 / 威胁 / 守土 / 补给 / 比分）+ 生产按性价比与克制选兵，
 *    `cohesion` 归零。验收门槛见 `docs/ai-diagnosis.md`（新 hard 需 ≥65% 胜 normal）。
 *
 * 曾试过"第二步：扣掉对手回手威胁"的手工惩罚项，反而退回 50% —— 过度保守，已放弃；
 * 对手建模改由 v2 的**零和威胁项**（双方同额度）承担，避免拍脑袋的单侧惩罚。
 */
export interface AiProfile {
  /** 弱档：决策带噪（随机挑、偶尔漏操作、部署随意） */
  noisy: boolean
  /** 集火权重：乘在"残血目标价值"上（越大越执着于补刀） */
  focusFire: number
  /** 抱团权重：向己方单位重心靠拢才有的分（0 = 不抱团；**v2 起困难档不再使用**） */
  cohesion: number
  /** 精确比较（每个候选深克隆一次状态）的候选数上限 */
  lookaheadK: number
  /** 部署计划；空数组表示"随机部署" */
  deployPlan: string[]
  /** v2 标记：启用 v2 的"有动作就做"语义（不再因启发式分为负而过手） */
  v2: boolean
  /** v2 生产策略：按"每千军费战力 + 克制 + 占领手缺口"选兵（关闭则沿用 v1 的"越贵越优先"） */
  smartProduce: boolean
  /** v2 经济：据点收入的时间价值权重（0 = v1 行为） */
  economy: number
  /** v2 威胁：预计承受伤害的惩罚权重（0 = v1 的粗糙"2 格内敌人数"） */
  threat: number
  /** v2 守土：敌方占领进度的紧急度（0 = 完全不管） */
  defend: number
  /** v2 补给：残血单位驻守己方据点的价值（0 = 完全不管） */
  repair: number
  /** v2 克制：出兵时按"对敌阵平均伤害"加权的强度（0 = 只按造价） */
  counter: number
  /** v2 比分：临近回合上限时按 GDD 9.2 计分表算账 */
  scoreAware: boolean
}

/** 不打开任何 v2 开关的默认值（easy / normal 逐字沿用 v1 行为） */
const V1_SWITCHES = {
  v2: false,
  smartProduce: false,
  economy: 0,
  threat: 0,
  defend: 0,
  repair: 0,
  counter: 0,
  scoreAware: false,
} as const

const PROFILES: Record<Difficulty, AiProfile> = {
  easy: { noisy: true, focusFire: 0.15, cohesion: 0, lookaheadK: 0, deployPlan: [], ...V1_SWITCHES },
  normal: {
    noisy: false,
    focusFire: 0.15,
    cohesion: 0,
    lookaheadK: 5,
    deployPlan: DEPLOY_PLAN,
    ...V1_SWITCHES,
  },
  hard: {
    noisy: false,
    focusFire: 0.6,
    cohesion: 0,
    lookaheadK: 12,
    deployPlan: DEPLOY_PLAN,
    v2: true,
    smartProduce: true,
    economy: 3,
    // 威胁项**暂不启用**：实测（v2-threat 单项消融 vs normal，16 局）0 胜率 ——
    // 多家围攻相乘后该惩罚达到 ±几千分，压过材料项，AI 变成"择地躲避"而不推进；
    // 0.5 的温和档也没有增益（62.5% vs 68.8%）。风险判断改由切片 2 的真搜索承担。
    threat: 0,
    defend: 6,
    repair: 8,
    counter: 1,
    scoreAware: true,
  },
}

/** 取某档难度的策略参数（返回副本，防止外部误改策略表；对战评估台用它构造对照档案） */
export function profileFor(difficulty: Difficulty): AiProfile {
  return { ...PROFILES[difficulty] }
}

/** 把策略参数翻译成评估权重（v2 开关与评估器的接线只在这一处） */
function evalWeights(profile: AiProfile): EvaluateWeights {
  return {
    cohesion: profile.cohesion,
    economy: profile.economy,
    threat: profile.threat,
    defend: profile.defend,
    repair: profile.repair,
    scoreAware: profile.scoreAware,
  }
}

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
const TIE_EPSILON = 2

/**
 * 困难档部署时的"抱团"加成：每贴近已放置友军 1 格加多少分
 */
const DEPLOY_COHESION_BONUS = 40

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
  return nextCommandWith(state, playerId, PROFILES[difficulty], data, random)
}

/**
 * 用**指定的策略档案**产出下一条指令。
 *
 * 与 `nextCommand` 的关系：后者只是"取难度对应的档案"再调它。暴露出来是为了让
 * 对战评估台（`scripts/ai-bench.ts`）能构造对照档案 —— 例如"把 v2 开关全关"的
 * v1 快照，用来回答"新实现是不是真的比旧实现强"。
 */
export function nextCommandWith(
  state: GameState,
  playerId: PlayerId,
  profile: AiProfile,
  data: GameData = DATA,
  random: () => number = () => 0.5,
): Command {
  if (!state.players.includes(playerId)) return { type: 'endTurn' }
  if (state.phase === 'GAME_OVER') return { type: 'endTurn' }
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

  let bestScore = -Infinity
  const scoredDeploys: Array<{ cmd: (typeof deploys)[number]; value: number }> = []
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
    if (value > bestScore) bestScore = value
    scoredDeploys.push({ cmd, value })
  }
  return pickTieBreak(scoredDeploys, bestScore, random)
}

/** 在"与最高分分差 < ε"的并列候选里用 rng 任选；无并列时结果就是原来的最高分（不消耗 rng） */
function pickTieBreak<T>(scored: Array<{ cmd: T; value: number }>, bestScore: number, random: () => number): T {
  const top = scored.filter((s) => s.value >= bestScore - TIE_EPSILON)
  if (top.length <= 1) return (top[0] ?? scored[0]).cmd
  return top[Math.floor(random() * top.length)].cmd
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

  // v2：把"原地不动"从候选竞争里剔除。`wait` 的启发式分恒为 0，一旦开启威胁项，
  // 任何有风险的走位都会被它击败，AI 会集体挂机（实测 0/16 胜）。只有完全没有
  // 别的动作时才允许用 wait 收尾。v1 档不受影响（候选池原样）。
  const withoutWait = profile.v2 ? actions.filter((s) => s.cmd.type !== 'wait') : actions
  const pool = withoutWait.length > 0 ? withoutWait : actions

  // 普通 / 困难：先取启发式最优，若无正收益就结束回合
  let bestHeuristic = pool[0]
  for (const item of pool) {
    if (bestHeuristic === undefined || item.score > bestHeuristic.score) bestHeuristic = item
  }
  // v1 档（简单/普通）沿用"最优分为负就过手"；v2 档（困难起）改成"有动作就做"：
  // 本作里"提前结束回合"没有任何收益（未行动的单位随后也不会再有机会）。
  const actThreshold = profile.v2 ? -Infinity : 0
  if (bestHeuristic === undefined || bestHeuristic.score <= actThreshold) return endTurnCmd

  // 前瞻：对启发式前 K 名做精确比较（每个候选深克隆一次，K 很小）
  pool.sort((a, b) => b.score - a.score)
  const weights = evalWeights(profile)
  const base = evaluate(state, playerId, data, weights)
  let bestDelta = -Infinity
  const deltas: Array<{ cmd: Command; value: number }> = []

  for (const candidate of pool.slice(0, profile.lookaheadK)) {
    const result = applyCommand(state, playerId, candidate.cmd, data)
    if (!result.ok) continue
    const delta = evaluate(result.state, playerId, data, weights) - base
    if (delta > bestDelta) bestDelta = delta
    deltas.push({ cmd: candidate.cmd, value: delta })
  }
  // 全部候选都意外非法时退回到启发式最优（按 legalCommands 不变量不会发生）
  if (deltas.length === 0) return bestHeuristic.cmd
  return pickTieBreak(deltas, bestDelta, random)
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
