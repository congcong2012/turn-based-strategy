/**
 * 本地 AI 对手（纯函数决策：给定状态，产出下一条指令）。
 *
 * 设计要点：
 *  1. 候选用 `legalCommandsFor` 产出，因此**返回的指令一定合法**（内核语义与它一一对应）；
 *  2. 候选打分用**免克隆的启发式**（`./heuristics`，computeDamage / chebyshevDistance 直接估算）；
 *     只有最终选中的那一条、以及"普通"难度 top-k 的一步前瞻才调用 applyCommand ——
 *     因为 `applyCommand` 每次都 JSON 深克隆整个 state，深搜会迅速变慢；
 *  3. 六档难度由一张策略表（`./profile` 的 PROFILES）描述：
 *     easy（带噪随机、会漏操作、部署随意）/ normal（贪心 + 一步前瞻）/
 *     hard（单步前瞻 + 评估器 v2）/ master（切片 3：+ 评估器 v3）/
 *     expert（切片 2：beam 极小极大 + α-β，见 `./search`）/
 *     **oracle（切片 4：回合级 rollout，见 `./rollout`）**；
 *     其中 master / expert **暂不接入 UI**（不写进 `PLAYABLE_DIFFICULTIES`）；
 *     而 `hard` 与 `oracle` 在设置页是**同一个难度档「困难」的两种算法模式**
 *     （「快棋」/「深推演」，映射见 `src/ui/PveSetup.tsx`）。
 *  4. **永不 resign**；
 *  5. 随机取自传入的 rng（或按状态散列出的确定性 rng），内核保持零随机、同种子可复现；
 *     普通 / 困难 / 专家唯一的 rng 消费是 TIE_EPSILON 平局打破 —— 让不同种子走出不同的棋，
 *     是对战评估台（scripts/ai-bench.ts）能积累独立样本的前提。
 *
 * 模块拆分（切片 2）：难度档案移到 `./profile`、启发式打分移到 `./heuristics`，
 * 以免搜索层 `./search` 反向 import 本文件形成循环依赖。此处仍对外 re-export 原有名字，
 * 因此 `from '../ai'` 的既有 import 路径不变。
 */

import { DATA } from '../game/data'
import type { GameData } from '../game/data'
import { chebyshevDistance } from '../game/movement'
import { currentPlayer } from '../game/state'
import { deployCommandsFor, playCommandsFor } from '../game/legalCommands'
import { applyCommand } from '../game/commands'
import { evaluate } from './evaluate'
import { scorePlay, pickTieBreak, DEPLOY_COHESION_BONUS } from './heuristics'
import { PROFILES, evalWeights } from './profile'
import type { AiProfile, Difficulty } from './profile'
import { searchCommand } from './search'
import { rolloutCommand } from './rollout'
import { hashSeed, mulberry32 } from './rng'
import type { Command, GameState, PlayerId } from '../game/types'

// 难度档案与启发式打分已拆到独立模块；这里 re-export，保持对外 API 与 import 路径不变。
export type { Difficulty, AiProfile, PlayableDifficulty } from './profile'
export { profileFor, PLAYABLE_DIFFICULTIES, isPlayableDifficulty } from './profile'

/** 每回合 AI 最多执行的指令数：任何意外情况下都保证终止 */
export const MAX_AI_STEPS = 40

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

  // 普通 / 困难 / 专家：优先按计划兵种，落点选"最靠前"（离敌方王城最近）
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

  // 普通 / 困难 / 专家：先取启发式最优，若无正收益就结束回合
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

  // 切片 4：回合级 rollout（两人局）—— 对每个根候选，让对手把**整个回合**走完再评估。
  // 优先级高于切片 2 的浅层搜索（两者不同时开启；本档评估仍用 hard 那一套，只换机制）。
  if (profile.rolloutFoeSteps > 0 && state.players.length === 2) {
    return rolloutCommand(state, playerId, profile, data, random, pool.map((s) => s.cmd)).cmd
  }

  // 切片 2：搜索档（expert）在**两人局**走 beam 极小极大 + α-β。
  // 3–4 人是非零和，"对手 = 另一人"的语义不成立 → 保守回退到下面的 1 步前瞻。
  // 传入已排序的 pool：根节点的候选卫生（剔除 wait / 有动作就做）只在上面维护一次。
  if (profile.searchDepth > 0 && state.players.length === 2) {
    return searchCommand(state, playerId, profile, data, random, pool.map((s) => s.cmd)).cmd
  }

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
