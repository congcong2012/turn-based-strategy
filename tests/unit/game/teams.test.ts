/**
 * 2v2 队伍规则（`src/game/teams.ts` + 内核改动）。
 *
 * 守三件事：
 *  1. **混战行为不变** —— 不设 `teams` 时，所有判定必须与旧逻辑等价；
 *  2. **队友不是敌人** —— 不能攻击、不能抢队友据点（AI 也靠这条才不会打队友）；
 *  3. **胜负按队伍算** —— 只剩一支队伍就结束，哪怕那队还有两个人活着。
 */

import { describe, expect, it } from 'vitest'
import { addUnit, P1, P2, P3, P4, run, startPlaying4, testData4 } from './fixtures'
import { resolveTurn } from '../../../src/game/state'
import { withTeams } from '../../../src/game/state'
import { areAllies, diagonalTeams, teamOf, teamMembers } from '../../../src/game/teams'
import { attackableTargets } from '../../../src/game/movement'
import type { GameState } from '../../../src/game/types'

const data = testData4()

/** 四人局 + 对角分队：A/D 一队（0），B/C 一队（1） */
function teamGame(): GameState {
  return withTeams(startPlaying4(data), diagonalTeams(4))
}

describe('队伍建模', () => {
  it('对角分队：0&3 一队、1&2 一队', () => {
    expect(diagonalTeams(4)).toEqual([0, 1, 1, 0])
  })

  it('★ 非 4 席不产生队伍（避免 2 人局被误判成"同队"）', () => {
    expect(diagonalTeams(2)).toEqual([])
    expect(diagonalTeams(3)).toEqual([])
  })

  it('withTeams 遇到非法长度原样返回（当混战处理）', () => {
    const ffa = startPlaying4(data)
    expect(withTeams(ffa, []).teams).toBeUndefined()
    expect(withTeams(ffa, [0, 1]).teams).toBeUndefined()
    expect(withTeams(ffa, [0, 1, 1, 0]).teams).toEqual([0, 1, 1, 0])
  })

  it('teamOf / teamMembers 按座位取值', () => {
    const s = teamGame()
    expect(teamOf(s, P1)).toBe(0)
    expect(teamOf(s, P4)).toBe(0)
    expect(teamOf(s, P2)).toBe(1)
    expect(teamMembers(s, 0).sort()).toEqual([P1, P4].sort())
  })
})

describe('★ 混战不受影响（未设 teams 时必须与旧逻辑等价）', () => {
  it('areAllies：只有自己算友军', () => {
    const ffa = startPlaying4(data)
    expect(areAllies(ffa, P1, P1)).toBe(true)
    expect(areAllies(ffa, P1, P2)).toBe(false)
    expect(teamOf(ffa, P1)).toBeNull()
  })
})

describe('友军判定', () => {
  it('2v2：同队为友军，跨队为敌军', () => {
    const s = teamGame()
    expect(areAllies(s, P1, P4)).toBe(true)
    expect(areAllies(s, P2, P3)).toBe(true)
    expect(areAllies(s, P1, P2)).toBe(false)
  })
})

describe('★ 队友不能打', () => {
  it('attackableTargets 里不含队友，只含敌人', () => {
    let s = teamGame()
    // A 在 (3,3)；D（队友）在 (3,4)；B（敌人）在 (2,3)
    s = addUnit(s, data, 'sword', P1, 3, 3)
    s = addUnit(s, data, 'sword', P4, 3, 4)
    s = addUnit(s, data, 'sword', P2, 2, 3)
    const mine = s.units.find((u) => u.owner === P1 && u.x === 3 && u.y === 3)!
    const targets = attackableTargets(s, mine, data)
    expect(targets.some((t) => t.owner === P4)).toBe(false)
    expect(targets.some((t) => t.owner === P2)).toBe(true)
  })

  it('直接对队友下攻击令 → TARGET_INVALID', () => {
    let s = teamGame()
    s = addUnit(s, data, 'sword', P1, 3, 3)
    s = addUnit(s, data, 'sword', P4, 3, 4)
    const attacker = s.units.find((u) => u.owner === P1 && u.x === 3 && u.y === 3)!
    const mate = s.units.find((u) => u.owner === P4 && u.x === 3 && u.y === 4)!
    const result = run(s, P1, { type: 'attack', unitId: attacker.id, targetId: mate.id }, data)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('TARGET_INVALID')
  })
})

describe('★ 队友的据点不能抢', () => {
  it('站到队友兵营上点占领 → NOTHING_TO_DO', () => {
    let s = teamGame()
    // D 的兵营在 (5,6)；A 与 D 同队，且 A 先手（capture 只有当前玩家能下）
    s = addUnit(s, data, 'sword', P1, 5, 6)
    const unit = s.units.find((u) => u.owner === P1 && u.x === 5 && u.y === 6)!
    const result = run(s, P1, { type: 'capture', unitId: unit.id }, data)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('NOTHING_TO_DO')
  })
})

describe('★ 胜负按队伍算', () => {
  it('打光 B、C（同一队）→ 对局结束，甲队获胜', () => {
    const s = teamGame()
    const wiped = { ...s, units: s.units.filter((u) => u.owner !== P2 && u.owner !== P3) }
    const { state } = resolveTurn(wiped, data)
    expect(state.phase).toBe('GAME_OVER')
    expect(state.winnerTeam).toBe(0)
    // winner 填该队的存活代表（A 或 D）
    expect([P1, P4]).toContain(state.winner)
  })

  it('对照：混战里打光两个人不会结束（还剩两个）', () => {
    const ffa = startPlaying4(data)
    const wiped = { ...ffa, units: ffa.units.filter((u) => u.owner !== P2 && u.owner !== P3) }
    const { state } = resolveTurn(wiped, data)
    expect(state.phase).not.toBe('GAME_OVER')
  })

  it('只打光一个队的一半（B 死、C 活）→ 对局继续', () => {
    const s = teamGame()
    const partial = { ...s, units: s.units.filter((u) => u.owner !== P2) }
    const { state } = resolveTurn(partial, data)
    expect(state.phase).not.toBe('GAME_OVER')
    expect(state.eliminated).toContain(P2)
  })
})
