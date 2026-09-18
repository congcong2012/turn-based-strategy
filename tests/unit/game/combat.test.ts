import { describe, expect, it } from 'vitest'
import { baseDamage, canCounter, computeDamage } from '../../../src/game/combat'
import { addUnit, must, newGame, run, startPlaying, testData, P1, P2 } from './fixtures'

const data = testData()

function pair(defenderAt: { x: number; y: number }, attackerHp?: number) {
  let state = startPlaying(newGame(data), data)
  state = addUnit(state, data, 'sword', P1, 0, 0)
  state = addUnit(state, data, 'sword', P2, defenderAt.x, defenderAt.y)
  const attacker = state.units.find((u) => u.owner === P1 && u.type === 'sword' && u.x === 0)!
  const defender = state.units.find((u) => u.owner === P2 && u.type === 'sword' && u.x === defenderAt.x)!
  if (attackerHp !== undefined) attacker.hp = attackerHp
  return { state, attacker, defender }
}

describe('伤害公式（GDD 7.1）', () => {
  it('满血刀盾打满血刀盾（平原）= 55', () => {
    const { state, attacker, defender } = pair({ x: 1, y: 0 })
    expect(computeDamage(state, attacker, defender, data)).toBe(55)
  })

  it('攻方残血时伤害按 HP 比例衰减：半血 = floor(55×0.5) = 27', () => {
    const { state, attacker, defender } = pair({ x: 1, y: 0 }, 50)
    expect(computeDamage(state, attacker, defender, data)).toBe(27)
  })

  it('守方在森林（减伤 25%）= floor(55×0.75) = 41', () => {
    const { state, attacker, defender } = pair({ x: 1, y: 1 })
    expect(computeDamage(state, attacker, defender, data)).toBe(41)
  })

  it('守方在据点（减伤 30%）= floor(55×0.7) = 38', () => {
    const { state, attacker, defender } = pair({ x: 4, y: 0 })
    expect(computeDamage(state, attacker, defender, data)).toBe(38)
  })

  it('克制矩阵：长枪克重骑、刀盾对重骑几乎无效', () => {
    expect(baseDamage('spear', 'heavyCav', data)).toBe(55)
    expect(baseDamage('sword', 'heavyCav', data)).toBe(15)
    expect(baseDamage('lightCav', 'bow', data)).toBe(75)
    expect(baseDamage('bow', 'lightCav', data)).toBe(55)
  })

  it('反击条件：射程覆盖且兵种可反击（投石车不可）', () => {
    const { state, attacker, defender } = pair({ x: 1, y: 0 })
    expect(canCounter(attacker, defender, data)).toBe(true)

    const withCatapult = addUnit(state, data, 'catapult', P2, 3, 0)
    const catapult = withCatapult.units.find((u) => u.type === 'catapult')!
    expect(canCounter(attacker, catapult, data)).toBe(false) // 投石车不可反击
  })
})

describe('攻击指令结算（GDD 7.4）', () => {
  it('互攻一次：攻方 55 → 守方 45HP → 反击 24 → 攻方 76HP', () => {
    let state = startPlaying(newGame(data), data)
    state = addUnit(state, data, 'sword', P1, 0, 0)
    state = addUnit(state, data, 'sword', P2, 1, 0)
    const attacker = state.units.find((u) => u.owner === P1 && u.x === 0)!
    const defender = state.units.find((u) => u.owner === P2 && u.x === 1)!
    const next = must(run(state, P1, { type: 'attack', unitId: attacker.id, targetId: defender.id }, data))
    expect(next.units.find((u) => u.id === defender.id)?.hp).toBe(45)
    expect(next.units.find((u) => u.id === attacker.id)?.hp).toBe(76)
    expect(next.units.find((u) => u.id === attacker.id)?.acted).toBe(true)
  })

  it('守方阵亡则无反击', () => {
    let state = startPlaying(newGame(data), data)
    state = addUnit(state, data, 'heavyCav', P1, 0, 0)
    state = addUnit(state, data, 'bow', P2, 1, 0) // 90 HP，重骑对弓兵 90 伤害
    const attacker = state.units.find((u) => u.x === 0 && u.y === 0)!
    const defender = state.units.find((u) => u.x === 1 && u.y === 0)!
    const next = must(run(state, P1, { type: 'attack', unitId: attacker.id, targetId: defender.id }, data))
    expect(next.units.some((u) => u.id === defender.id)).toBe(false)
    expect(next.units.find((u) => u.id === attacker.id)?.hp).toBe(120)
  })

  it('弓兵可隔 2 格攻击，投石车可隔 2–3 格但不能贴身', () => {
    let state = startPlaying(newGame(data), data)
    state = addUnit(state, data, 'bow', P1, 0, 0)
    state = addUnit(state, data, 'sword', P2, 2, 0)
    const bow = state.units.find((u) => u.x === 0 && u.y === 0)!
    const target = state.units.find((u) => u.x === 2 && u.y === 0)!
    expect(run(state, P1, { type: 'attack', unitId: bow.id, targetId: target.id }, data).ok).toBe(true)

    let s2 = startPlaying(newGame(data), data)
    s2 = addUnit(s2, data, 'catapult', P1, 0, 0)
    s2 = addUnit(s2, data, 'sword', P2, 1, 0)
    const cat = s2.units.find((u) => u.x === 0 && u.y === 0)!
    const near = s2.units.find((u) => u.x === 1 && u.y === 0)!
    const r = run(s2, P1, { type: 'attack', unitId: cat.id, targetId: near.id }, data)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('OUT_OF_RANGE')
  })
})
