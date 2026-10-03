/**
 * AI 搜索层（切片 2）：合法性、确定性、预算纪律、α-β 等价、深度/预算生效、适用边界。
 *
 * 强度结论（expert vs hard 胜率）**不在这里断言** —— 那要跑真实地图、样本量也大，
 * 交给 `npm run bench:ai`（见 `docs/ai-bench-slice2.md`）。单测只守"正确性与不变量"。
 */

import { describe, expect, it } from 'vitest'
import { applyCommand } from '../../../src/game/commands'
import { playCommandsFor } from '../../../src/game/legalCommands'
import { currentPlayer } from '../../../src/game/state'
import { evaluate } from '../../../src/ai/evaluate'
import { evalWeights, profileFor } from '../../../src/ai/profile'
import type { AiProfile } from '../../../src/ai/profile'
import { searchCommand } from '../../../src/ai/search'
import { MAX_AI_STEPS, nextCommand } from '../../../src/ai'
import { scorePlay } from '../../../src/ai/heuristics'
import { mulberry32 } from '../../../src/ai/rng'
import type { Command, GameState, PlayerId } from '../../../src/game/types'
import {
  P1,
  P2,
  addUnit,
  newGame,
  startPlaying,
  startPlaying4,
  testData,
  testData4,
} from '../game/fixtures'

const data = testData()

/** expert 档案 + 可覆盖的搜索参数（构造深度 / 预算的边界用例） */
function searchProfile(patch: Partial<AiProfile> = {}): AiProfile {
  return { ...profileFor('expert'), ...patch }
}

/** 沿用 `pickPlay` 的根候选口径：剔除 endTurn、v2 剔除 wait、按启发式降序 */
function rootPool(state: GameState, playerId: PlayerId, profile: AiProfile): Command[] {
  const all = playCommandsFor(state, playerId, data)
  const actions = all.filter((c) => c.type !== 'endTurn')
  const withoutWait = profile.v2 ? actions.filter((c) => c.type !== 'wait') : actions
  const pool = withoutWait.length > 0 ? withoutWait : actions
  const scored = pool.map((cmd) => ({ cmd, score: scorePlay(state, playerId, cmd, data, profile) }))
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.cmd)
}

/**
 * 朴素全宽极小极大：无 beam、无预算、无 α-β。
 * 仅用于等价性对照 —— 证明"beam + α-β"没有改变博弈语义。
 */
function naiveMinimax(state: GameState, playerId: PlayerId, profile: AiProfile, depth: number): number {
  const weights = evalWeights(profile)
  if (depth <= 0 || state.phase === 'GAME_OVER') return evaluate(state, playerId, data, weights)
  const mover = currentPlayer(state)
  if (!mover) return evaluate(state, playerId, data, weights)
  const cmds = playCommandsFor(state, mover, data)
  if (cmds.length === 0) return evaluate(state, playerId, data, weights)

  const isMax = mover === playerId
  let best = isMax ? -Infinity : Infinity
  for (const cmd of cmds) {
    const r = applyCommand(state, mover, cmd, data)
    if (!r.ok) continue
    const v = naiveMinimax(r.state, playerId, profile, depth - 1)
    if (isMax) best = Math.max(best, v)
    else best = Math.min(best, v)
  }
  return best
}

/** 根节点用与搜索相同的候选集，逐条 apply 后交给上面的朴素极小极大 */
function naiveRootValue(
  state: GameState,
  playerId: PlayerId,
  profile: AiProfile,
  depth: number,
  roots: Command[],
): number {
  let best = -Infinity
  for (const cmd of roots) {
    const r = applyCommand(state, playerId, cmd, data)
    if (!r.ok) continue
    best = Math.max(best, naiveMinimax(r.state, playerId, profile, depth - 1))
  }
  return best
}

/** "双方都有单位、已进入行动阶段"的 fixture 局面（A 先手） */
function midGame(): GameState {
  return addUnit(startPlaying(newGame(data), data), data, 'spear', P2, 3, 5)
}

describe('搜索层 · 合法性与终止性', () => {
  it('expert 整个回合产出的指令全部合法，并以 endTurn 收尾', () => {
    let s = startPlaying(newGame(data), data)
    const rng = mulberry32(7)
    const commands: Command[] = []
    for (let i = 0; i < MAX_AI_STEPS; i += 1) {
      const cmd = nextCommand(s, P1, 'expert', data, rng)
      const r = applyCommand(s, P1, cmd, data)
      expect(r.ok, '非法指令: ' + JSON.stringify(cmd) + ' → ' + (r.ok ? '' : r.code)).toBe(true)
      if (!r.ok) break
      commands.push(cmd)
      s = r.state
      if (cmd.type === 'endTurn' || s.phase === 'GAME_OVER') break
    }
    expect(commands.length).toBeGreaterThan(0)
    expect(commands[commands.length - 1].type).toBe('endTurn')
  })
})

describe('搜索层 · 确定性（刷新可复现的前提）', () => {
  it('同状态 + 同种子 → 同指令、同节点数、同深度', () => {
    const s = midGame()
    const profile = searchProfile()
    const a = searchCommand(s, P1, profile, data, mulberry32(123))
    const b = searchCommand(s, P1, profile, data, mulberry32(123))
    expect(a.cmd).toEqual(b.cmd)
    expect(a.nodes).toBe(b.nodes)
    expect(a.depth).toBe(b.depth)
  })

  it('不依赖墙钟：连续两次调用（不同真实时间）结果一致', () => {
    const s = midGame()
    const profile = searchProfile()
    const first = searchCommand(s, P1, profile, data, mulberry32(55))
    // 人为制造一段间隔，若实现里混入了 performance.now() 的截止判断就会露馅
    const until = Date.now() + 40
    while (Date.now() < until) {
      /* busy wait */
    }
    const second = searchCommand(s, P1, profile, data, mulberry32(55))
    expect(second.cmd).toEqual(first.cmd)
    expect(second.nodes).toBe(first.nodes)
  })
})

describe('搜索层 · 预算纪律', () => {
  it('节点数 / 枚举次数永不超过各自预算', () => {
    const s = midGame()
    const profile = searchProfile()
    const r = searchCommand(s, P1, profile, data, mulberry32(3))
    expect(r.nodes).toBeLessThanOrEqual(profile.nodeBudget)
    expect(r.expansions).toBeLessThanOrEqual(profile.expansionBudget)
  })

  it('预算极小时退化为启发式最优，且仍是合法指令', () => {
    const s = midGame()
    const profile = searchProfile({ nodeBudget: 1 })
    const r = searchCommand(s, P1, profile, data, mulberry32(1))
    expect(r.nodes).toBeLessThanOrEqual(1)
    expect(r.depth).toBe(0)
    expect(applyCommand(s, P1, r.cmd, data).ok).toBe(true)
  })
})

describe('搜索层 · 深度与剪枝', () => {
  it('预算充足时迭代加深能搜到设定深度', () => {
    const s = midGame()
    const profile = searchProfile()
    const r = searchCommand(s, P1, profile, data, mulberry32(5))
    expect(r.depth).toBe(profile.searchDepth)
  })

  it('预算不足时深度被截断（证明预算真的在起作用）', () => {
    const s = midGame()
    const profile = searchProfile({ nodeBudget: 2 })
    const r = searchCommand(s, P1, profile, data, mulberry32(5))
    expect(r.depth).toBeLessThan(profile.searchDepth)
    expect(r.nodes).toBeLessThanOrEqual(2)
  })

  it('大 beam + 大预算下，结果与朴素全宽极小极大一致（α-β 不改变语义）', () => {
    const s = midGame()
    const profile = searchProfile({
      searchDepth: 2,
      beamWidth: 1_000_000,
      innerBeamWidth: 1_000_000,
      expansionBudget: 1_000_000,
      nodeBudget: 100_000_000,
    })
    // 根候选里额外并入 endTurn，让搜索线走到"对手回合"（min 层）也被对照覆盖
    const roots: Command[] = [{ type: 'endTurn' }, ...rootPool(s, P1, profile)]
    const got = searchCommand(s, P1, profile, data, mulberry32(9), roots)
    const want = naiveRootValue(s, P1, profile, 2, roots)
    expect(got.score).toBeCloseTo(want, 3)
  })
})

describe('搜索层 · 归因不变式', () => {
  it('expert 与 master 的评估开关完全一致（增益只能来自搜索）', () => {
    const master = profileFor('master')
    const expert = profileFor('expert')
    const evalFields = [
      'noisy',
      'focusFire',
      'cohesion',
      'lookaheadK',
      'v2',
      'smartProduce',
      'economy',
      'threat',
      'defend',
      'repair',
      'counter',
      'scoreAware',
      'pendingMaterial',
      'counterValue',
      'rangedSafety',
      'exposure',
    ] as const
    for (const key of evalFields) expect(expert[key], key).toEqual(master[key])
    expect(expert.searchDepth).toBeGreaterThan(0)
    expect(master.searchDepth).toBe(0)
  })

  it('master/hard 的差别只在评估：master 打开了 v3 的四个开关，hard 全关', () => {
    const hard = profileFor('hard')
    const master = profileFor('master')
    expect(hard.pendingMaterial).toBe(0)
    expect(hard.counterValue).toBe(0)
    expect(hard.rangedSafety).toBe(0)
    expect(hard.exposure).toBe(0)
    expect(master.pendingMaterial).toBeGreaterThan(0)
    expect(master.exposure).toBeGreaterThan(0)
    // 评估之外完全一致
    expect(master.lookaheadK).toEqual(hard.lookaheadK)
    expect(master.economy).toEqual(hard.economy)
    expect(master.searchDepth).toBe(0)
  })
})

describe('搜索层 · 适用边界', () => {
  it('3–4 人局不走搜索：expert 回退到同评估的 1 步前瞻（= master 的决策）', () => {
    const d4 = testData4()
    const s = startPlaying4(d4)
    const expertCmd = nextCommand(s, P1, 'expert', d4, mulberry32(3))
    const masterCmd = nextCommand(s, P1, 'master', d4, mulberry32(3))
    expect(expertCmd).toEqual(masterCmd)
    expect(applyCommand(s, P1, expertCmd, d4).ok).toBe(true)
  })

  it('非行动阶段（部署）不进入搜索', () => {
    const s = newGame(data)
    const r = searchCommand(s, P1, searchProfile(), data, mulberry32(2))
    expect(r.cmd).toEqual({ type: 'endTurn' })
    expect(r.nodes).toBe(0)
  })
})
