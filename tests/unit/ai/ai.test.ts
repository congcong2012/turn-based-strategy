/** AI 对手：合法性、终止性、确定性、可跑完整局 */

import { describe, expect, it } from 'vitest'
import { applyCommand } from '../../../src/game/commands'
import { MAX_AI_STEPS, nextCommand } from '../../../src/ai'
import type { Difficulty } from '../../../src/ai'
import { mulberry32 } from '../../../src/ai/rng'
import { createGame, currentPlayer } from '../../../src/game/state'
import { unitsOf } from '../../../src/game/board'
import type { Command, GameState, PlayerId } from '../../../src/game/types'
import { P1, P2, addUnit, must, newGame, run, startPlaying, testData } from '../game/fixtures'

const data = testData()
const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard']

/** 让某位玩家把当前回合（或部署）走完，逐步断言"每一步都合法" */
function playUntilTurnEnds(
  start: GameState,
  player: PlayerId,
  difficulty: Difficulty,
  seed: number,
): { state: GameState; commands: Command[] } {
  const rng = mulberry32(seed)
  const commands: Command[] = []
  let s = start

  for (let step = 0; step < MAX_AI_STEPS; step += 1) {
    const cmd = nextCommand(s, player, difficulty, data, rng)
    const result = applyCommand(s, player, cmd, data)
    expect(result.ok, '非法指令: ' + JSON.stringify(cmd) + ' → ' + (result.ok ? '' : result.code)).toBe(true)
    if (!result.ok) break

    commands.push(cmd)
    s = result.state
    if (cmd.type === 'endTurn' || cmd.type === 'deployDone') return { state: s, commands }
    if (s.phase === 'GAME_OVER') return { state: s, commands }
  }
  return { state: s, commands }
}

/** 双方都用 AI 打完整一局，返回终局状态 */
function playFullGame(difficulty: Record<string, Difficulty>, seed: number, maxSteps = 3000) {
  const rng = mulberry32(seed)
  let s = createGame('test', [P1, P2], data)
  let steps = 0

  while (s.phase !== 'GAME_OVER' && steps < maxSteps) {
    steps += 1
    const player = s.phase === 'DEPLOY' ? s.players.find((p) => !s.deploy[p].done) : currentPlayer(s)
    if (!player) break

    const cmd = nextCommand(s, player, difficulty[player] ?? 'normal', data, rng)
    const result = applyCommand(s, player, cmd, data)
    expect(result.ok, '步 ' + steps + ' 非法: ' + JSON.stringify(cmd) + ' → ' + (result.ok ? '' : result.code)).toBe(true)
    if (!result.ok) break

    s = result.state
    // 部署阶段：所有人都确认后才会进入 PLAYING，continue 即可
    if (s.phase === 'DEPLOY' && cmd.type === 'endTurn') break
  }
  return { state: s, steps }
}

describe('AI · 合法性', () => {
  it.each(DIFFICULTIES)('部署阶段产出的指令全部合法（%s）', (difficulty) => {
    const { commands } = playUntilTurnEnds(newGame(data), P1, difficulty, 7)
    expect(commands.length).toBeGreaterThan(0)
    expect(commands[commands.length - 1].type).toBe('deployDone')
  })

  it.each(DIFFICULTIES)('行动阶段产出的指令全部合法，并以 endTurn 收尾（%s）', (difficulty) => {
    const { commands } = playUntilTurnEnds(startPlaying(newGame(data), data), P1, difficulty, 11)
    expect(commands.length).toBeGreaterThan(0)
    expect(commands[commands.length - 1].type).toBe('endTurn')
  })

  it('部署阶段一定会先放至少 1 个单位再确认（否则内核拒绝 deployDone）', () => {
    for (const difficulty of DIFFICULTIES) {
      const { commands } = playUntilTurnEnds(newGame(data), P1, difficulty, 3)
      const placed = commands.filter((c) => c.type === 'deploy')
      expect(placed.length).toBeGreaterThanOrEqual(1)
      expect(commands[commands.length - 1].type).toBe('deployDone')
    }
  })

  it('"普通"难度会按计划放满 3 个单位（3000 预算用尽）', () => {
    const { state } = playUntilTurnEnds(newGame(data), P1, 'normal', 5)
    expect(unitsOf(state, P1).length).toBe(3)
  })
})

describe('AI · 终止性', () => {
  it.each(DIFFICULTIES)('有限步内必然结束回合（%s）', (difficulty) => {
    const { commands } = playUntilTurnEnds(startPlaying(newGame(data), data), P1, difficulty, 42)
    expect(commands.length).toBeLessThanOrEqual(MAX_AI_STEPS)
    expect(commands[commands.length - 1].type).toBe('endTurn')
  })

  it('有兵营和资金时会生产单位', () => {
    const played = playUntilTurnEnds(startPlaying(newGame(data), data), P1, 'normal', 9)
    expect(played.commands.some((c) => c.type === 'produce')).toBe(true)
  })
})

describe('AI · 确定性', () => {
  it('相同种子 + 相同状态 → 完全相同的指令序列', () => {
    const start = startPlaying(newGame(data), data)
    const a = playUntilTurnEnds(start, P1, 'normal', 2024)
    const b = playUntilTurnEnds(start, P1, 'normal', 2024)
    expect(a.commands).toEqual(b.commands)

    const c = playUntilTurnEnds(start, P1, 'easy', 2024)
    const d = playUntilTurnEnds(start, P1, 'easy', 2024)
    expect(c.commands).toEqual(d.commands)
  })

  it('不需要外部 rng 时也能复现（按状态散列出种子）', () => {
    const start = startPlaying(newGame(data), data)
    const first = nextCommand(start, P1, 'easy', data)
    const second = nextCommand(start, P1, 'easy', data)
    expect(first).toEqual(second)
  })
})

describe('AI · 自对弈打完整局', () => {
  it('普通 vs 普通：能一路打到 GAME_OVER', () => {
    const { state, steps } = playFullGame({ [P1]: 'normal', [P2]: 'normal' }, 1001)
    expect(state.phase).toBe('GAME_OVER')
    expect(steps).toBeLessThan(3000)
    expect(state.winner !== undefined).toBe(true)
  })

  it('简单 vs 普通：同样能打完（弱者不一定赢，但必须能收局）', () => {
    const { state } = playFullGame({ [P1]: 'easy', [P2]: 'normal' }, 2002)
    expect(state.phase).toBe('GAME_OVER')
  })

  it('简单 vs 简单：也能打完', () => {
    const { state } = playFullGame({ [P1]: 'easy', [P2]: 'easy' }, 3003)
    expect(state.phase).toBe('GAME_OVER')
  })

  it('对局中 AI 从不投降', () => {
    const { commands } = playUntilTurnEnds(startPlaying(newGame(data), data), P1, 'normal', 77)
    expect(commands.some((c) => c.type === 'resign')).toBe(false)
  })

  it('对手单位在射程内时会发起攻击', () => {
    // 把 B 的刀盾兵放在 A 单位旁边，AI 应该选择攻击而不是无视
    const withEnemy = addUnit(startPlaying(newGame(data), data), data, 'sword', P2, 3, 6)
    const { commands } = playUntilTurnEnds(withEnemy, P1, 'normal', 13)
    expect(commands.some((c) => c.type === 'attack')).toBe(true)
  })

  it('能站上中立村落并完成占领', () => {
    // (4,0) 是中立村落，把 A 的刀盾兵直接放上去
    let s = addUnit(startPlaying(newGame(data), data), data, 'sword', P1, 4, 0)
    s = must(run(s, P1, { type: 'endTurn' }, data))
    s = must(run(s, P2, { type: 'endTurn' }, data))
    // 回到 A：此时应能占领
    const { commands } = playUntilTurnEnds(s, P1, 'normal', 17)
    expect(commands.some((c) => c.type === 'capture')).toBe(true)
  })
})

describe('AI · 困难档', () => {
  /**
   * 困难 vs 普通：4 个种子 × 双方互换 = 8 局。
   * 普通与困难都**不消耗随机数**，所以结果是确定的 —— 这条不会 flaky。
   */
  it('困难档确实比普通档强（8 局至少赢 6 局）', () => {
    let hardWins = 0
    for (const seed of [900, 901, 902, 903]) {
      if (playFullGame({ [P1]: 'hard', [P2]: 'normal' }, seed).state.winner === P1) hardWins += 1
      if (playFullGame({ [P1]: 'normal', [P2]: 'hard' }, seed).state.winner === P2) hardWins += 1
    }
    expect(hardWins).toBeGreaterThanOrEqual(6)
  }, 60_000)

  it('困难 vs 困难：同档自对弈也能收局', () => {
    const { state } = playFullGame({ [P1]: 'hard', [P2]: 'hard' }, 4004)
    expect(state.phase).toBe('GAME_OVER')
  })

  it('困难档会按计划放满 3 个单位', () => {
    const { state } = playUntilTurnEnds(newGame(data), P1, 'hard', 5)
    expect(unitsOf(state, P1).length).toBe(3)
  })

  it('单步决策耗时可控：中盘（单位不少）也要在预算内', () => {
    // 先让双方用普通难度跑到第 6 回合，拿到一个"单位已经不少"的局面
    let s = createGame('test', [P1, P2], data)
    for (let i = 0; i < 800 && s.phase !== 'GAME_OVER' && s.round <= 6; i += 1) {
      const player = s.phase === 'DEPLOY' ? s.players.find((p) => !s.deploy[p].done) : currentPlayer(s)
      if (!player) break
      const result = applyCommand(s, player, nextCommand(s, player, 'normal', data), data)
      if (!result.ok) break
      s = result.state
    }

    const actor = s.phase === 'DEPLOY' ? s.players.find((p) => !s.deploy[p].done) : currentPlayer(s)
    if (!actor) return
    const started = Date.now()
    nextCommand(s, actor, 'hard', data)
    // 上限给得很宽：真正要挡住的是"深搜把单步拖成几秒"这类退化
    expect(Date.now() - started).toBeLessThan(800)
  })
})
