/**
 * 战报累积器（`src/game/journal`）的专项测试。
 *
 * 重点守两件事：
 *  1. **完整战报 `fullLog` / `rounds` 不受滚动窗口影响** —— 这是 2026-10-10 新加的
 *     「完整战斗日志」的地基：`log` 只留 60 条，`fullLog` / `rounds` 必须留全。
 *  2. **回合分组正确**：`turnStart` 是回合边界，它之前的收尾事件（turnEnd 等）
 *     要落在**上一回合**组里，不能被算进新回合。
 */

import { describe, expect, it } from 'vitest'
import { LOG_LIMIT, appendJournal, emptyJournal } from '../../../src/game/journal'
import type { Journal } from '../../../src/game/journal'
import type { GameEvent, GameState, PlayerId } from '../../../src/game/types'
import { P1, P2, newGame, run, startPlaying, testData } from './fixtures'

const data = testData()
const nameOf = (id: PlayerId) => (id === P1 ? '甲' : id === P2 ? '乙' : id)

/** 空状态（战报解析名字时会回落到"某部队"，这里不关心） */
const noState = null as GameState | null

/** 把一批事件喂进累积器，返回新的 journal */
function feed(journal: Journal, events: GameEvent[], after?: GameState): Journal {
  return appendJournal(journal, events, noState, after ?? ({} as GameState), nameOf)
}

describe('战报累积器 · 基本语义', () => {
  it('空事件不产生任何变化（且返回同一个对象）', () => {
    const j = emptyJournal()
    expect(appendJournal(j, [], noState, {} as GameState, nameOf)).toBe(j)
  })

  it('seq 单调递增，每条事件一个序号', () => {
    let j = emptyJournal()
    j = feed(j, [
      { type: 'turnStart', round: 1, playerId: P1 },
      { type: 'turnEnd', playerId: P1 },
    ])
    expect(j.seq).toBe(2)
    expect(j.events.map((e) => e.seq)).toEqual([1, 2])

    j = feed(j, [{ type: 'turnStart', round: 2, playerId: P2 }])
    expect(j.seq).toBe(3)
    expect(j.events[2].seq).toBe(3)
  })

  it('同一个累积器不断追加时，seq 不重置', () => {
    let j = emptyJournal()
    for (let i = 0; i < 5; i += 1) j = feed(j, [{ type: 'turnEnd', playerId: P1 }])
    expect(j.seq).toBe(5)
    expect(j.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('★ 完整战报不受滚动窗口限制', () => {
  it(`log 截到 ${LOG_LIMIT} 条，但 fullLog 保留全部`, () => {
    let j = emptyJournal()
    const total = LOG_LIMIT + 25
    for (let i = 0; i < total; i += 1) {
      j = feed(j, [{ type: 'turnEnd', playerId: i % 2 === 0 ? P1 : P2 }])
    }
    expect(j.log.length).toBe(LOG_LIMIT)
    expect(j.fullLog.length).toBe(total)
  })

  it('fullLog 与 rounds 是同一份内容（分组不丢行、不重复）', () => {
    let j = emptyJournal()
    for (let round = 1; round <= 6; round += 1) {
      j = feed(j, [{ type: 'turnStart', round, playerId: P1 }])
      j = feed(j, [{ type: 'turnEnd', playerId: P1 }])
      j = feed(j, [{ type: 'turnStart', round, playerId: P2 }])
      j = feed(j, [{ type: 'turnEnd', playerId: P2 }])
    }
    const flattened = j.rounds.flatMap((r) => r.lines)
    expect(flattened).toEqual(j.fullLog)
  })
})

describe('★ 按回合分组', () => {
  it('turnStart 开新组；它之前的事件归上一回合', () => {
    let j = emptyJournal()
    // 第 1 回合：P1 开始 → 结束
    j = feed(j, [{ type: 'turnStart', round: 1, playerId: P1 }])
    j = feed(j, [{ type: 'turnEnd', playerId: P1 }])
    // 第 2 回合：P2 开始
    j = feed(j, [{ type: 'turnStart', round: 2, playerId: P2 }])
    j = feed(j, [{ type: 'turnEnd', playerId: P2 }])

    expect(j.rounds.length).toBe(2)
    expect(j.rounds[0].round).toBe(1)
    expect(j.rounds[0].lines.length).toBe(2) // turnStart + turnEnd
    expect(j.rounds[1].round).toBe(2)
    expect(j.rounds[1].lines.length).toBe(2)
  })

  it('同一回合的多个玩家事件合并进同一组', () => {
    let j = emptyJournal()
    j = feed(j, [{ type: 'turnStart', round: 3, playerId: P1 }])
    j = feed(j, [{ type: 'turnEnd', playerId: P1 }])
    j = feed(j, [{ type: 'turnStart', round: 3, playerId: P2 }])
    j = feed(j, [{ type: 'turnEnd', playerId: P2 }])

    expect(j.rounds.length).toBe(1)
    expect(j.rounds[0].round).toBe(3)
    expect(j.rounds[0].lines.length).toBe(4)
  })

  it('turnStart 之前的无回合事件落在第 0 组（开局部署）', () => {
    let j = emptyJournal()
    j = feed(j, [{ type: 'turnEnd', playerId: P1 }])
    expect(j.rounds.length).toBe(1)
    expect(j.rounds[0].round).toBe(0)
    j = feed(j, [{ type: 'turnStart', round: 1, playerId: P1 }])
    expect(j.rounds.length).toBe(2)
    expect(j.rounds[1].round).toBe(1)
  })

  it('分组只追加、不改写已有组（可安全地做 diff / 渲染）', () => {
    let j = emptyJournal()
    j = feed(j, [{ type: 'turnStart', round: 1, playerId: P1 }])
    const beforeRound = j.rounds[0].lines.length
    const snapshot = j.rounds.map((r) => r.round)
    j = feed(j, [{ type: 'turnEnd', playerId: P1 }])
    expect(j.rounds.map((r) => r.round)).toEqual(snapshot)
    expect(j.rounds[0].lines.length).toBe(beforeRound + 1)
  })
})

describe('★ 真实对局：完整战报能覆盖部署 + 行动', () => {
  it('打完一段真实指令流后，rounds 覆盖了部署与至少一个回合', () => {
    let state = startPlaying(newGame(data), data)
    let j = emptyJournal()

    // 走一遍真实指令：移动 + 结束回合
    const unit = state.units.find((u) => u.owner === P1)
    expect(unit).toBeTruthy()
    if (unit) {
      const moved = run(state, P1, { type: 'move', unitId: unit.id, x: unit.x, y: unit.y - 1 }, data)
      if (moved.ok) {
        j = appendJournal(j, moved.events, state, moved.state, nameOf)
        state = moved.state
      }
    }
    const ended = run(state, P1, { type: 'endTurn' }, data)
    if (!ended.ok) throw new Error('结束回合被拒绝: ' + ended.code)
    j = appendJournal(j, ended.events, state, ended.state, nameOf)

    expect(j.fullLog.length).toBeGreaterThan(0)
    expect(j.rounds.length).toBeGreaterThan(0)
    // 分组里的内容与 fullLog 完全一致
    expect(j.rounds.flatMap((r) => r.lines)).toEqual(j.fullLog)
  })

  it('战报文案是可读中文（不含 undefined / [object Object]）', () => {
    const state = startPlaying(newGame(data), data)
    const result = run(state, P1, { type: 'endTurn' }, data)
    if (!result.ok) throw new Error('指令被拒绝: ' + result.code)
    const j = appendJournal(emptyJournal(), result.events, state, result.state, nameOf)
    expect(j.fullLog.length).toBeGreaterThan(0)
    for (const line of j.fullLog) {
      expect(line).not.toContain('undefined')
      expect(line).not.toContain('[object')
      expect(line.length).toBeGreaterThan(0)
    }
  })
})
