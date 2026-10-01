/** 局面评估：方向性正确（优势更高、劣势更低、终局取极值） */

import { describe, expect, it } from 'vitest'
import { evaluate } from '../../../src/ai/evaluate'
import { unitsOf } from '../../../src/game/board'
import { createGame } from '../../../src/game/state'
import { P1, P2, addUnit, newGame, startPlaying, testData } from '../game/fixtures'

const data = testData()

describe('evaluate', () => {
  it('交换双方视角后分数互换（评估函数对"双方对称"）', () => {
    // 直接构造一个"交换红蓝"的局面：单位归属、据点归属、资金、部署预算全部对调。
    // 若评估函数是对称的，那么 evaluate(s, P1) 必须等于 evaluate(swapped, P2)。
    const s = startPlaying(newGame(data), data)
    const swapOwner = (o: string | null) => (o === P1 ? P2 : o === P2 ? P1 : null)
    const swapped = {
      ...s,
      players: [P2, P1],
      units: s.units.map((u) => ({ ...u, owner: swapOwner(u.owner) as string })),
      buildings: s.buildings.map((b) => ({ ...b, owner: swapOwner(b.owner) })),
      funds: { [P1]: s.funds[P2] ?? 0, [P2]: s.funds[P1] ?? 0 },
    }

    expect(evaluate(swapped, P2, data)).toBeCloseTo(evaluate(s, P1, data), 6)
    expect(evaluate(swapped, P1, data)).toBeCloseTo(evaluate(s, P2, data), 6)
  })

  it('凭空多一个单位 → 自己分数上升、对手下降', () => {
    const base = startPlaying(newGame(data), data)
    const withExtra = addUnit(base, data, 'heavyCav', P1, 3, 3)

    expect(evaluate(withExtra, P1, data)).toBeGreaterThan(evaluate(base, P1, data))
    expect(evaluate(withExtra, P2, data)).toBeLessThan(evaluate(base, P2, data))
  })

  it('单位造价越高，分数提升越大', () => {
    const base = startPlaying(newGame(data), data)
    const cheap = addUnit(base, data, 'sword', P1, 3, 3)
    const pricey = addUnit(base, data, 'heavyCav', P1, 3, 3)

    const cheapGain = evaluate(cheap, P1, data) - evaluate(base, P1, data)
    const priceyGain = evaluate(pricey, P1, data) - evaluate(base, P1, data)
    expect(priceyGain).toBeGreaterThan(cheapGain)
  })

  it('残血的单位价值低于满血单位', () => {
    const base = startPlaying(newGame(data), data)
    const hurt = addUnit(base, data, 'sword', P1, 3, 3)
    hurt.units = hurt.units.map((u) => (u.x === 3 && u.y === 3 ? { ...u, hp: 10 } : u))

    expect(evaluate(hurt, P1, data)).toBeLessThan(evaluate(addUnit(base, data, 'sword', P1, 3, 3), P1, data))
  })

  it('多占一座中立村落 → 分数上升', () => {
    const base = startPlaying(newGame(data), data)
    const owned = { ...base, buildings: base.buildings.map((b) => (b.id === 'v-mid' ? { ...b, owner: P1 } : b)) }

    expect(evaluate(owned, P1, data)).toBeGreaterThan(evaluate(base, P1, data))
    expect(evaluate(owned, P2, data)).toBeLessThan(evaluate(base, P2, data))
  })

  it('多占一座王城的价值高于村落', () => {
    const base = startPlaying(newGame(data), data)
    const gainOf = (id: string, owner: string) => {
      const next = { ...base, buildings: base.buildings.map((b) => (b.id === id ? { ...b, owner } : b)) }
      return evaluate(next, P1, data) - evaluate(base, P1, data)
    }
    // hq-B 是 B 的王城 —— 抢过来对 A 的价值应高于抢一座村落
    expect(gainOf('hq-B', P1)).toBeGreaterThan(gainOf('v-mid', P1))
  })

  it('资金更多 → 分数更高', () => {
    const base = startPlaying(newGame(data), data)
    const rich = { ...base, funds: { ...base.funds, [P1]: (base.funds[P1] ?? 0) + 10000 } }
    expect(evaluate(rich, P1, data)).toBeGreaterThan(evaluate(base, P1, data))
  })

  it('自己获胜 → 极大正值；自己被淘汰 → 极大负值', () => {
    const base = createGame('test', [P1, P2], data)
    expect(evaluate({ ...base, winner: P1 }, P1, data)).toBeGreaterThan(100_000)
    expect(evaluate({ ...base, eliminated: [P1] }, P1, data)).toBeLessThan(-100_000)
  })

  it('靠前推进（靠近敌方王城）比原地不动得分更高', () => {
    const base = startPlaying(newGame(data), data)
    const me = unitsOf(base, P1)[0]
    // B 的王城在 (5,0)；把 A 的单位从 (2,7) 挪到 (5,3) 更近
    const advanced = {
      ...base,
      units: base.units.map((u) => (u.id === me.id ? { ...u, x: 5, y: 3 } : u)),
    }
    expect(evaluate(advanced, P1, data)).toBeGreaterThan(evaluate(base, P1, data))
  })
})
