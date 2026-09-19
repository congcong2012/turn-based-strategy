import { describe, expect, it } from 'vitest'
import { endTurn, scoreOf, survivors } from '../../../src/game/state'
import { P1, P2, P3, P4, addUnit, must, run, startPlaying4, testData4 } from './fixtures'
import type { GameState } from '../../../src/game/types'

const data = testData4()

function current(state: GameState) {
  return state.players[state.turnIndex]
}

/** 让 A 站到 B 的王城上，跨两回合完成占领 */
function marchToEnemyHq(state: GameState): GameState {
  let s = state
  s.units = s.units.filter((u) => u.owner !== P1)
  s = addUnit(s, data, 'sword', P1, 6, 1) // B 的王城
  const unit = s.units.find((u) => u.owner === P1)!
  s = must(run(s, P1, { type: 'capture', unitId: unit.id }, data))
  // 走完一轮回到 A
  for (const p of [P1, P2, P3, P4]) void p
  s = must(run(s, P1, { type: 'endTurn' }, data))
  s = must(run(s, P2, { type: 'endTurn' }, data))
  s = must(run(s, P3, { type: 'endTurn' }, data))
  s = must(run(s, P4, { type: 'endTurn' }, data))
  const again = s.units.find((u) => u.owner === P1)!
  s = must(run(s, P1, { type: 'capture', unitId: again.id }, data))
  s = must(run(s, P1, { type: 'endTurn' }, data))
  return s
}

describe('四人局：回合轮转与淘汰制', () => {
  it('四人依次行动，回合数按绕回递增', () => {
    let s = startPlaying4(data)
    expect(s.players).toEqual([P1, P2, P3, P4])
    expect(s.round).toBe(1)
    expect(current(s)).toBe(P1)

    s = must(run(s, P1, { type: 'endTurn' }, data))
    expect(current(s)).toBe(P2)
    s = must(run(s, P2, { type: 'endTurn' }, data))
    expect(current(s)).toBe(P3)
    s = must(run(s, P3, { type: 'endTurn' }, data))
    expect(current(s)).toBe(P4)
    expect(s.round).toBe(1)
    s = must(run(s, P4, { type: 'endTurn' }, data))
    expect(current(s)).toBe(P1)
    expect(s.round).toBe(2)
  })

  it('占领王城 → 该玩家被淘汰，对局继续（不是立即结束）', () => {
    const s = marchToEnemyHq(startPlaying4(data))
    expect(s.eliminated).toEqual([P2])
    expect(s.phase).toBe('PLAYING') // 还有 3 人存活
    expect(survivors(s)).toEqual([P1, P3, P4])
    // 被淘汰者的部队撤离、据点归中立
    expect(s.units.some((u) => u.owner === P2)).toBe(false)
    expect(s.buildings.find((b) => b.id === 'bk-B')?.owner).toBeNull()
    // 王城归占领者
    expect(s.buildings.find((b) => b.id === 'hq-B')?.owner).toBe(P1)
    // 后续回合跳过被淘汰者
    expect(current(s)).toBe(P3)
  })

  it('全军覆没 → 淘汰；投降 → 淘汰；只剩一人即获胜', () => {
    let s = startPlaying4(data)
    // C 的部队被移出战场，结算时判定歼灭
    s.units = s.units.filter((u) => u.owner !== P3)
    s = must(run(s, P1, { type: 'endTurn' }, data))
    expect(s.eliminated).toContain(P3)

    // B、D 相继投降 → A 成为唯一存活者
    s = must(run(s, P2, { type: 'resign' }, data))
    expect(s.phase).toBe('PLAYING')
    s = must(run(s, P4, { type: 'resign' }, data))
    expect(s.phase).toBe('GAME_OVER')
    expect(s.winner).toBe(P1)
    expect(survivors(s)).toEqual([P1])
  })

  it('投降者正好是当前玩家时，回合立刻交给下一位', () => {
    let s = startPlaying4(data)
    expect(current(s)).toBe(P1)
    s = must(run(s, P1, { type: 'resign' }, data))
    expect(s.eliminated).toContain(P1)
    expect(s.phase).toBe('PLAYING')
    expect(current(s)).toBe(P2)
  })

  it('回合上限：在存活者里按分数判定', () => {
    const shortData = { ...data, rules: { ...data.rules, roundLimit: 2 } }
    let s = startPlaying4(shortData)
    // A 拿下一座村落以取得分数优势
    s.units = s.units.filter((u) => u.owner !== P1)
    s = addUnit(s, shortData, 'sword', P1, 3, 3)
    const unit = s.units.find((u) => u.owner === P1)!
    s = must(run(s, P1, { type: 'capture', unitId: unit.id }, shortData))
    s = must(run(s, P1, { type: 'endTurn' }, shortData))
    s = must(run(s, P2, { type: 'endTurn' }, shortData))
    s = must(run(s, P3, { type: 'endTurn' }, shortData))
    s = must(run(s, P4, { type: 'endTurn' }, shortData))
    s = must(run(s, P1, { type: 'capture', unitId: s.units.find((u) => u.owner === P1)!.id }, shortData))
    s = must(run(s, P1, { type: 'endTurn' }, shortData))
    s = must(run(s, P2, { type: 'endTurn' }, shortData))
    s = must(run(s, P3, { type: 'endTurn' }, shortData))
    s = must(run(s, P4, { type: 'endTurn' }, shortData))

    expect(s.phase).toBe('GAME_OVER')
    expect(s.winReason).toBe('score')
    expect(s.winner).toBe(P1)
    expect(scoreOf(s, P1, shortData)).toBeGreaterThan(scoreOf(s, P2, shortData))
  })

  it('四人图的经济与据点：每人 1 王城 + 1 兵营，中立村落可争', () => {
    let s = startPlaying4(data)
    expect(s.buildings.filter((b) => b.type === 'hq')).toHaveLength(4)
    expect(s.buildings.filter((b) => b.owner === null)).toHaveLength(2)
    s = endTurn(s, data).state
    // 每人每回合收入 = 王城 1200 + 兵营 300
    expect(s.funds[P2]).toBe(4000 + 1500)
  })
})
