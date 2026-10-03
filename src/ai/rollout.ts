/**
 * AI 回合级 rollout（切片 4）：**换机制** —— 不再"多搜一层指令"，而是让对手把**整个回合**走完再评估。
 *
 * 为什么换：前面三次尝试都指向"手工评估项 + 浅层 beam 搜索在这款游戏里收益很低"
 * （静态威胁项 0/16、3 层搜索 51.7%、评估器 v3 四项 53.3%）。诊断早就指出根因是
 * **一个 ply = 一条指令**：`applyCommand` 一次只让一个单位动一下，所以"多搜一层"
 * 只相当于多算一个单位的动作，看不到"对手这一回合能组织出什么攻势"。
 * 回合级 rollout 直接把这一层补上：
 *
 *   value(我的一条指令 c) = evaluate( 走完我这回合 → 对手走完他这回合 )
 *
 * 即"我这样开局之后，对手整整一回合能把我打成什么样"。这是**确定性的贪心 rollout**
 * （不是 MCTS 的随机采样），因此同种子必然同决策，刷新可复现的约束不被破坏。
 *
 * 成本：每次评估要跑 (我的剩余步数 + 对手步数) 次候选枚举 —— 枚举
 *（`playCommandsFor` 的 Dijkstra）是真正的开销大头（约 1–3ms/次），所以用
 * `rolloutBudget`（枚举次数）封顶，并且根候选按 `beamWidth` 收窄。
 */

import { applyCommand } from '../game/commands'
import { playCommandsFor } from '../game/legalCommands'
import { currentPlayer } from '../game/state'
import type { Command, GameState, PlayerId } from '../game/types'
import type { GameData } from '../game/data'
import { evaluate } from './evaluate'
import { scorePlay, pickTieBreak } from './heuristics'
import { evalWeights } from './profile'
import type { AiProfile } from './profile'

export interface RolloutResult {
  cmd: Command
  /** 实际完成的候选枚举次数（供单测断言 ≤ rolloutBudget） */
  generations: number
  /** 选中指令的评估值 */
  score: number
}

/** 枚举预算耗尽：保留已算完的候选，用它们选优（无需丢弃整个深度） */
class BudgetExceeded extends Error {}

const END_TURN: Command = { type: 'endTurn' }

interface RolloutContext {
  generations: number
  budget: number
}

/**
 * 产出 AI 的下一条指令（回合级 rollout 版）。
 *
 * @param rootCandidates 根候选（**已按启发式降序**），由 `pickPlay` 传入以复用根节点卫生规则。
 */
export function rolloutCommand(
  state: GameState,
  playerId: PlayerId,
  profile: AiProfile,
  data: GameData,
  random: () => number,
  rootCandidates?: Command[],
): RolloutResult {
  if (state.phase !== 'PLAYING') return { cmd: END_TURN, generations: 0, score: 0 }

  const roots = (rootCandidates ?? defaultRoots(state, playerId, data, profile)).slice(
    0,
    Math.max(1, profile.beamWidth),
  )
  if (roots.length === 0) return { cmd: END_TURN, generations: 0, score: 0 }

  const ctx: RolloutContext = { generations: 0, budget: Math.max(1, Math.floor(profile.rolloutBudget)) }
  const weights = evalWeights(profile)
  const foe = state.players.find((p) => p !== playerId)
  const deltas: Array<{ cmd: Command; value: number }> = []
  let best = -Infinity

  try {
    for (const cmd of roots) {
      const first = applyCommand(state, playerId, cmd, data)
      if (!first.ok) continue
      charge(ctx)

      // 1) 我按启发式贪心走完这一回合（若 cmd 就是 endTurn，则这一步自然跳过）
      let s = first.state
      if (profile.rolloutMySteps > 0) {
        // 我自己的续走用启发式（便宜）；重点是下面的对手回合
        s = playOutTurn(s, playerId, profile, data, profile.rolloutMySteps, 0, ctx)
      }
      s = endTurnIfMine(s, playerId, data)

      // 2) 对手走完**整个回合** —— 本机制的核心：看见"一整个回合的攻势"。
      //    对手用与 `hard` 相同的 1 步前瞻来走（`rolloutFoeLookahead`），
      //    否则会低估威胁（贪心比 hard 弱），AI 会过于自信。
      if (foe && profile.rolloutFoeSteps > 0) {
        s = playOutTurn(s, foe, profile, data, profile.rolloutFoeSteps, profile.rolloutFoeLookahead, ctx)
      }

      const value = evaluate(s, playerId, data, weights)
      if (value > best) best = value
      deltas.push({ cmd, value })
    }
  } catch (err) {
    if (!(err instanceof BudgetExceeded)) throw err
    // 预算耗尽：已算完的候选之间仍可比较，直接用它们选优
  }

  if (deltas.length === 0) return { cmd: roots[0], generations: ctx.generations, score: 0 }
  return { cmd: pickTieBreak(deltas, best, random), generations: ctx.generations, score: best }
}

function charge(ctx: RolloutContext): void {
  // 先判额度再计数 → 保证 `generations ≤ budget` 恒成立（单测据此断言）
  if (ctx.generations >= ctx.budget) throw new BudgetExceeded()
  ctx.generations += 1
}

/**
 * 让 `player` 走完自己的回合（最多 `maxSteps` 条指令）。
 *
 * `lookaheadK > 0` 时每一步用**与 `hard` 相同的 1 步前瞻**挑指令（更接近真实对手）；
 * `lookaheadK = 0` 时只用启发式贪心（便宜，用于"我自己的续走"）。
 * 语义与 `pickPlay` 的 v2 档一致：候选里剔除 `wait`、有动作就做；不打 `endTurn`（由调用方补）。
 */
function playOutTurn(
  state: GameState,
  player: PlayerId,
  profile: AiProfile,
  data: GameData,
  maxSteps: number,
  lookaheadK: number,
  ctx: RolloutContext,
): GameState {
  let s = state

  for (let step = 0; step < maxSteps; step += 1) {
    if (s.phase !== 'PLAYING') return s
    if (currentPlayer(s) !== player) return s

    charge(ctx)
    const cmd = pickPlayoutCommand(s, player, profile, data, lookaheadK)
    if (!cmd) return s

    const applied = applyCommand(s, player, cmd, data)
    if (!applied.ok) return s
    s = applied.state
  }

  return s
}

/** 回合内单步决策：`lookaheadK > 0` 用 1 步前瞻，否则用启发式最优 */
function pickPlayoutCommand(
  state: GameState,
  player: PlayerId,
  profile: AiProfile,
  data: GameData,
  lookaheadK: number,
): Command | null {
  const cmds = playCommandsFor(state, player, data)
  const actions = cmds.filter((c) => c.type !== 'endTurn' && !(profile.v2 && c.type === 'wait'))
  if (actions.length === 0) return null

  const scored = actions.map((cmd) => ({ cmd, score: scorePlay(state, player, cmd, data, profile) }))
  scored.sort((x, y) => y.score - x.score)
  // v1 档"最优分为负就过手"；v2 档"有动作就做"（与 pickPlay 一致）
  const actThreshold = profile.v2 ? -Infinity : 0
  if (scored[0].score <= actThreshold) return null
  if (lookaheadK <= 0) return scored[0].cmd

  const weights = evalWeights(profile)
  const base = evaluate(state, player, data, weights)
  let bestCmd = scored[0].cmd
  let bestDelta = -Infinity
  for (const { cmd } of scored.slice(0, lookaheadK)) {
    const applied = applyCommand(state, player, cmd, data)
    if (!applied.ok) continue
    const delta = evaluate(applied.state, player, data, weights) - base
    if (delta > bestDelta) {
      bestDelta = delta
      bestCmd = cmd
    }
  }
  return bestCmd
}

/** 若还轮到 `player`，替他收尾（结束回合），好让对手开始行动 */
function endTurnIfMine(state: GameState, player: PlayerId, data: GameData): GameState {
  if (state.phase !== 'PLAYING') return state
  if (currentPlayer(state) !== player) return state
  const applied = applyCommand(state, player, END_TURN, data)
  return applied.ok ? applied.state : state
}

/** 未传入根候选时的兜底：沿用 `pickPlay` 的根节点卫生规则 */
function defaultRoots(state: GameState, playerId: PlayerId, data: GameData, profile: AiProfile): Command[] {
  const all = playCommandsFor(state, playerId, data)
  const actions = all.filter((cmd) => cmd.type !== 'endTurn')
  const withoutWait = profile.v2 ? actions.filter((cmd) => cmd.type !== 'wait') : actions
  const pool = withoutWait.length > 0 ? withoutWait : actions
  const scored = pool.map((cmd) => ({ cmd, score: scorePlay(state, playerId, cmd, data, profile) }))
  scored.sort((x, y) => y.score - x.score)
  return scored.map((s) => s.cmd)
}
