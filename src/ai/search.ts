/**
 * AI 搜索层（切片 2）：候选排序 + beam 极小极大 + α-β + 迭代加深。
 *
 * 背景（见 `docs/ai-slice2-plan.md`）：
 *  切片 1 用实测证明"把对手威胁写成静态评估项是有害的"（单项消融 0/16 胜，AI 变成
 *  择地躲避）。风险的判断必须交给**真搜索** —— 搜索天然看得到"我走这里 → 对手回手 →
 *  我的局面变差"，不需要拍脑袋的惩罚系数。
 *
 * 三个必须守住的性质：
 *  1. **纯函数、零随机（除平局打破）**：决策只是 `(state, playerId, profile, random)` 的
 *     函数，因此"刷新页面后同局面必然同决策"这条既有的可复现性不被破坏。
 *  2. **确定性预算**：用 `nodeBudget`（节点计数）而非墙钟封顶。墙钟会让同一局面在不同
 *     负载/机器上搜到不同深度 → 复现失效。延迟靠"节点预算换算 + 评估台实测 p95"保证。
 *  3. **合法性**：候选一律来自 `playCommandsFor`（与内核校验一一对应），因此搜索产出的
 *     指令必然能被 `applyCommand` 接受。
 *
 * 层（ply）的定义：**一个 ply = 一条指令**（本作没有"移动并攻击"的复合指令）。
 * 因此一条搜索线可能是"我连续几步"，也可能包含"我结束回合 → 对手行动"。
 * 每个节点按 `currentPlayer(state)` 判定是 max 层（自己）还是 min 层（对手）。
 *
 * 适用范围：**仅两人局**。3–4 人是非零和，"对手 = 另一人"的极小极大语义不成立，
 * 调用方（`index.ts` 的 `pickPlay`）会在人数 ≠ 2 时回退到 1 步前瞻。
 */

import { applyCommand } from '../game/commands'
import { playCommandsFor } from '../game/legalCommands'
import { currentPlayer } from '../game/state'
import type { Command, GameState, PlayerId } from '../game/types'
import type { GameData } from '../game/data'
import { evaluate } from './evaluate'
import type { EvaluateWeights } from './evaluate'
import { scorePlay, pickTieBreak } from './heuristics'
import { evalWeights } from './profile'
import type { AiProfile } from './profile'

export interface SearchResult {
  /** 选中的指令 */
  cmd: Command
  /** 实际完成的搜索深度（ply 数）；0 表示退回到启发式最优 */
  depth: number
  /** 实际访问的叶子节点数（供单测断言 ≤ nodeBudget） */
  nodes: number
  /** 实际的候选枚举次数（供单测断言 ≤ expansionBudget） */
  expansions: number
  /** 选中指令的评估值（越大越好；depth 0 时为 0） */
  score: number
}

/** 节点预算耗尽时抛出，用于**丢弃当前深度**、返回上一层已完成的结果 */
class BudgetExceeded extends Error {}

const END_TURN: Command = { type: 'endTurn' }

interface SearchContext {
  playerId: PlayerId
  data: GameData
  profile: AiProfile
  weights: EvaluateWeights
  budget: number
  /** 候选枚举次数：真正的耗时大头，单独封顶（见 AiProfile.expansionBudget） */
  expansionBudget: number
  nodes: number
  expansions: number
}

/**
 * 产出 AI 的下一条指令（搜索版）。
 *
 * @param rootCandidates 根节点的候选（**已按启发式降序**）。由 `pickPlay` 传入，
 *   这样"剔除 wait / 有动作就做"等根节点卫生规则只在一处维护；不传则内部自行生成。
 */
export function searchCommand(
  state: GameState,
  playerId: PlayerId,
  profile: AiProfile,
  data: GameData,
  random: () => number,
  rootCandidates?: Command[],
): SearchResult {
  if (state.phase !== 'PLAYING') return { cmd: END_TURN, depth: 0, nodes: 0, expansions: 0, score: 0 }

  // 根节点同样受 beam 限制：否则在"候选 300+ 条"的中盘，光是根层就会吃光预算，
  // 迭代加深永远完不成第 3 层，只好退回第 2 层 —— 而第 3 层才是"看到对手回手"的那层。
  const roots = (rootCandidates ?? defaultRoots(state, playerId, data, profile)).slice(
    0,
    Math.max(1, profile.beamWidth),
  )
  if (roots.length === 0) return { cmd: END_TURN, depth: 0, nodes: 0, expansions: 0, score: 0 }

  const ctx: SearchContext = {
    playerId,
    data,
    profile,
    weights: evalWeights(profile),
    budget: Math.max(1, Math.floor(profile.nodeBudget)),
    expansionBudget: Math.max(1, Math.floor(profile.expansionBudget)),
    nodes: 0,
    expansions: 0,
  }

  let chosen = roots[0]
  let chosenDepth = 0
  let chosenScore = 0

  // 迭代加深：深度 1（= 单步前瞻）→ 2 → … 直到 searchDepth。
  // 任一层超预算就丢弃该层、保留上一层已完成的结果 —— 因此结果是"某完整深度"的结果，
  // 绝不会是搜了一半的残局。
  for (let depth = 1; depth <= profile.searchDepth; depth += 1) {
    let best = -Infinity
    const deltas: Array<{ cmd: Command; value: number }> = []
    let aborted = false

    try {
      for (const cmd of roots) {
        const applied = applyCommand(state, playerId, cmd, data)
        if (!applied.ok) continue
        if (ctx.nodes >= ctx.budget) throw new BudgetExceeded()
        ctx.nodes += 1

        // 根层用**全窗口**（不跨子节点传 alpha）：根候选只有 beamWidth 条，省这点剪枝不值得
        // —— 换来的是每个根候选的 value 都是**精确值**，平局打破（ε 比较）才不会被
        // fail-soft 的边界值污染。深层的 α-β 照常生效。
        const value = minimax(ctx, applied.state, depth - 1, -Infinity, Infinity)
        if (value > best) best = value
        deltas.push({ cmd, value })
      }
    } catch (err) {
      if (err instanceof BudgetExceeded) aborted = true
      else throw err
    }

    if (aborted || deltas.length === 0) break

    // 平局打破：与 index.ts 的 1 步前瞻同机制（ε 内并列者用种子化 rng 任选）
    chosen = pickTieBreak(deltas, best, random)
    chosenDepth = depth
    chosenScore = best
  }

  return { cmd: chosen, depth: chosenDepth, nodes: ctx.nodes, expansions: ctx.expansions, score: chosenScore }
}

/**
 * 极小极大 + α-β。返回值恒为**根玩家视角**（越大对根玩家越好）。
 * max 层 = 根玩家，min 层 = 对手（仅两人局调用）。
 */
function minimax(
  ctx: SearchContext,
  state: GameState,
  depth: number,
  alpha: number,
  beta: number,
): number {
  if (depth <= 0 || state.phase === 'GAME_OVER') {
    return evaluate(state, ctx.playerId, ctx.data, ctx.weights)
  }

  const mover = currentPlayer(state)
  if (!mover) return evaluate(state, ctx.playerId, ctx.data, ctx.weights)

  const isMax = mover === ctx.playerId
  // 候选枚举前先占额度：枚举是真正的耗时大头，必须在**做之前**判额度，
  // 否则"枚举一次就超时"仍会发生。
  if (ctx.expansions >= ctx.expansionBudget) throw new BudgetExceeded()
  ctx.expansions += 1
  const cmds = candidatesFor(ctx, state, mover)
  if (cmds.length === 0) return evaluate(state, ctx.playerId, ctx.data, ctx.weights)

  let best = isMax ? -Infinity : Infinity
  let a = alpha
  let b = beta

  for (const cmd of cmds) {
    const applied = applyCommand(state, mover, cmd, ctx.data)
    if (!applied.ok) continue
    if (ctx.nodes >= ctx.budget) throw new BudgetExceeded()
    ctx.nodes += 1

    const value = minimax(ctx, applied.state, depth - 1, a, b)
    if (isMax) {
      if (value > best) best = value
      if (best > a) a = best
    } else {
      if (value < best) best = value
      if (best < b) b = best
    }
    // α-β 剪枝：先访问排序最优的子节点（见 candidatesFor 的降序），剪枝才有效
    if (b <= a) break
  }

  return best
}

/**
 * 某节点上"当前行动方"的候选：按**行动方自己的**启发式降序取前 `innerBeamWidth` 条。
 * 先排最优者，α-β 才能尽早剪枝。**根层不经过这里** —— 根候选由调用方按 `beamWidth` 截好。
 *
 * **强制纳入 `endTurn`**：否则"结束回合"会被高分的走位挤出 beam，
 * 搜索就永远看不到"我收手 → 对手回手"这条线，退化成纯自我规划。
 * 纳入后，对手建模才真正发生（`endTurn` 只是多一个候选，成本可忽略）。
 */
function candidatesFor(ctx: SearchContext, state: GameState, mover: PlayerId): Command[] {
  const all = playCommandsFor(state, mover, ctx.data)
  if (all.length === 0) return []
  const scored = all.map((cmd) => ({ cmd, score: scorePlay(state, mover, cmd, ctx.data, ctx.profile) }))
  // 稳定排序 → 同分保留生成顺序，与 1 步前瞻的口径一致
  scored.sort((x, y) => y.score - x.score)
  const picked = scored.slice(0, Math.max(1, ctx.profile.innerBeamWidth)).map((s) => s.cmd)
  if (!picked.some((c) => c.type === 'endTurn')) picked.push(END_TURN)
  return picked
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
