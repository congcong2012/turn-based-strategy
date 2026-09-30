/**
 * 兵种三角与 1v1 对决：把"谁克谁"固化成断言，改数值时先在这里看结论。
 *
 *   pnpm exec vitest run tests/unit/matchup.test.ts     # 直接打印对决表
 *
 * 模型：双方满血、平原（无减伤）、相邻，轮流"攻击 → 对方反击（射程覆盖时）"。
 * 伤害用真实公式 computeDamage（含攻方 HP 比例衰减），数值来自 src/data/*.json。
 */
import { describe, expect, it } from 'vitest'
import { canCounter, computeDamage } from '../../src/game/combat'
import { addUnit, newGame, startPlaying, testData, P1, P2 } from './game/fixtures'
import type { GameState, Unit } from '../../src/game/types'
import type { GameData } from '../../src/game/data'

const data = testData()

interface DuelResult {
  winner: 'attacker' | 'defender' | 'both-dead'
  attackerLeft: number
  defenderLeft: number
  /** 攻方剩余 HP 比例 − 守方剩余 HP 比例（越大越说明攻方占优） */
  margin: number
  strikes: number
}

/** 满血 1v1：平原相邻，轮流攻击（含反击），先手是 attacker */
function duel(attackerType: string, defenderType: string, d: GameData = data): DuelResult {
  let state: GameState = startPlaying(newGame(d), d)
  state = addUnit(state, d, attackerType, P1, 0, 0)
  state = addUnit(state, d, defenderType, P2, 1, 0)

  const find = (type: string, owner: string): Unit =>
    state.units.find((u) => u.type === type && u.owner === owner)!

  let atk = find(attackerType, P1)
  let def = find(defenderType, P2)
  let strikes = 0

  for (let round = 0; round < 30; round += 1) {
    strikes += 1
    def.hp -= computeDamage(state, atk, def, d)
    if (def.hp <= 0) {
      def.hp = 0
      break
    }
    if (canCounter(atk, def, d)) {
      atk.hp -= computeDamage(state, def, atk, d)
      if (atk.hp <= 0) {
        atk.hp = 0
        break
      }
    }
    const swap = atk
    atk = def
    def = swap
  }

  const attackerUnit = find(attackerType, P1)
  const defenderUnit = find(defenderType, P2)
  const aMax = d.units[attackerType].hp
  const dMax = d.units[defenderType].hp
  const aLeft = Math.max(0, Math.round((attackerUnit.hp / aMax) * 100))
  const dLeft = Math.max(0, Math.round((defenderUnit.hp / dMax) * 100))
  let winner: DuelResult['winner'] = 'both-dead'
  if (defenderUnit.hp <= 0 && attackerUnit.hp > 0) winner = 'attacker'
  else if (attackerUnit.hp <= 0 && defenderUnit.hp > 0) winner = 'defender'
  return { winner, attackerLeft: aLeft, defenderLeft: dLeft, margin: aLeft - dLeft, strikes }
}

const NAME: Record<string, string> = {
  sword: '刀盾兵',
  spear: '长枪兵',
  bow: '弓兵',
  lightCav: '轻骑兵',
  heavyCav: '重骑兵',
  catapult: '投石车',
}

describe('兵种三角与 1v1 对决', () => {
  it('打印关键对决结果（改数值先看这张表）', () => {
    const pairs: Array<[string, string]> = [
      ['sword', 'spear'],
      ['spear', 'sword'],
      ['sword', 'bow'],
      ['bow', 'sword'],
      ['spear', 'lightCav'],
      ['lightCav', 'spear'],
      ['sword', 'lightCav'],
      ['lightCav', 'sword'],
      ['spear', 'heavyCav'],
      ['sword', 'heavyCav'],
      ['heavyCav', 'sword'],
      ['lightCav', 'bow'],
      ['bow', 'lightCav'],
    ]
    const rows = pairs.map(([a, b]) => {
      const r = duel(a, b)
      return {
        对决: NAME[a] + ' 先手 vs ' + NAME[b],
        结果: r.winner === 'attacker' ? '先手胜' : r.winner === 'defender' ? '后手胜' : '同归于尽',
        剩余: r.attackerLeft + '% vs ' + r.defenderLeft + '%',
        优劣差: r.margin,
        交手次数: r.strikes,
      }
    })
    console.table(rows)
    expect(rows.length).toBe(pairs.length)
  })

  it('刀盾兵 = 反步兵专精：压制长枪兵与弓兵', () => {
    const vsSpear = duel('sword', 'spear')
    expect(vsSpear.winner).toBe('attacker')
    expect(vsSpear.defenderLeft).toBe(0)

    const vsBow = duel('sword', 'bow')
    expect(vsBow.winner).toBe('attacker')
    expect(vsBow.defenderLeft).toBe(0)
  })

  it('长枪兵是"硬克制"骑兵：先手后手都赢，两下解决', () => {
    const spearFirst = duel('spear', 'lightCav')
    expect(spearFirst.winner).toBe('attacker')
    expect(spearFirst.attackerLeft).toBeGreaterThanOrEqual(85) // 几乎不掉血
    expect(spearFirst.strikes).toBeLessThanOrEqual(3)

    // 骑兵先手也翻不了盘 —— 这才是"克制"
    const cavFirst = duel('lightCav', 'spear')
    expect(cavFirst.winner).toBe('defender')
  })

  it('刀盾兵不该抢"反骑兵"这个活：骑兵先手时刀盾扛不住，打起来也拖沓', () => {
    const swordFirst = duel('sword', 'lightCav')
    // 先手能赢，但代价明显比长枪大得多（交手次数多、自己掉血多）
    expect(swordFirst.strikes).toBeGreaterThanOrEqual(4)
    expect(swordFirst.attackerLeft).toBeLessThanOrEqual(80)

    const spearFirst = duel('spear', 'lightCav')
    expect(swordFirst.strikes).toBeGreaterThan(spearFirst.strikes)
    expect(spearFirst.attackerLeft - swordFirst.attackerLeft).toBeGreaterThanOrEqual(10)

    // 骑兵先手 → 刀盾输；换成长枪则是长枪赢
    expect(duel('lightCav', 'sword').winner).toBe('attacker')
    expect(duel('lightCav', 'spear').winner).toBe('defender')
  })

  it('刀盾兵对重骑兵几乎无效（需要很多次才能打死）', () => {
    expect(data.matchup.sword.heavyCav).toBeLessThanOrEqual(15)
    const r = duel('sword', 'heavyCav')
    expect(r.winner).toBe('defender')
  })

  it('骑兵仍然克制弓兵与器械', () => {
    expect(duel('lightCav', 'bow').winner).toBe('attacker')
    expect(data.matchup.lightCav.catapult).toBeGreaterThanOrEqual(75)
    expect(data.matchup.heavyCav.bow).toBeGreaterThanOrEqual(85)
  })

  it('刀盾兵在同价位（1000）里靠"能占领 + 反步兵"立足，长枪兵靠反骑兵', () => {
    expect(data.units.sword.cost).toBe(data.units.spear.cost)
    expect(data.units.sword.capture).toBe(true)
    // 反步兵/反骑兵各有一条明确的高伤害线，不存在"谁全面更强"
    expect(data.matchup.sword.spear).toBeGreaterThanOrEqual(70)
    expect(data.matchup.sword.bow).toBeGreaterThanOrEqual(75)
    expect(data.matchup.spear.lightCav).toBeGreaterThanOrEqual(70)
    expect(data.matchup.spear.heavyCav).toBeGreaterThanOrEqual(50)
  })
})
