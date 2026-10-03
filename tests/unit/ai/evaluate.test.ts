/** 局面评估：方向性正确（优势更高、劣势更低、终局取极值） */

import { describe, expect, it } from 'vitest'
import { evaluate } from '../../../src/ai/evaluate'
import { unitsOf } from '../../../src/game/board'
import { baseDamage } from '../../../src/game/combat'
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

/** v2 开关的权重打包（困难档实际使用的那一套） */
const V2 = { economy: 3, threat: 3, defend: 6, repair: 8, scoreAware: true }

/** 切片 3：评估器 v3 的全部开关（master 档使用的那一套） */
const V3 = { pendingMaterial: 0.8, counterValue: 2, rangedSafety: 0.2, exposure: 0.5 }

describe('evaluate · v2 开关', () => {
  it('打开全部开关后仍然对称（交换双方视角后分数互换）', () => {
    const s = startPlaying(newGame(data), data)
    const swapOwner = (o: string | null) => (o === P1 ? P2 : o === P1 ? P2 : o === P2 ? P1 : null)
    const swapped = {
      ...s,
      players: [P2, P1],
      units: s.units.map((u) => ({ ...u, owner: swapOwner(u.owner) as string })),
      buildings: s.buildings.map((b) => ({
        ...b,
        owner: swapOwner(b.owner),
        capture: b.capture ? { ...b.capture, playerId: swapOwner(b.capture.playerId) as string } : null,
      })),
      funds: { [P1]: s.funds[P2] ?? 0, [P2]: s.funds[P1] ?? 0 },
    }

    expect(evaluate(swapped, P2, data, V2)).toBeCloseTo(evaluate(s, P1, data, V2), 6)
    expect(evaluate(swapped, P1, data, V2)).toBeCloseTo(evaluate(s, P2, data, V2), 6)
  })

  it('威胁项严格零和：双方分数之和与 v1 相同', () => {
    const base = startPlaying(newGame(data), data)
    const withFoes = addUnit(addUnit(base, data, 'heavyCav', P2, 3, 4), data, 'bow', P2, 4, 3)

    const v1Sum = evaluate(withFoes, P1, data) + evaluate(withFoes, P2, data)
    const threatSum = evaluate(withFoes, P1, data, { threat: 3 }) + evaluate(withFoes, P2, data, { threat: 3 })
    expect(threatSum).toBeCloseTo(v1Sum, 6)
  })

  it('威胁项让"被强敌贴脸"明显更亏（相对 v1 的粗糙惩罚）', () => {
    const base = startPlaying(newGame(data), data)
    const mine = addUnit(base, data, 'catapult', P1, 3, 3)
    // 两台重骑兵贴上来：投石车对贴身目标既不能攻击也不能反击
    const exposed = addUnit(addUnit(mine, data, 'heavyCav', P2, 3, 4), data, 'heavyCav', P2, 4, 3)

    const v1Delta = evaluate(exposed, P1, data) - evaluate(mine, P1, data)
    const threatDelta = evaluate(exposed, P1, data, { threat: 3 }) - evaluate(mine, P1, data, { threat: 3 })
    expect(threatDelta).toBeLessThan(v1Delta - 200)
  })

  it('经济项：占下一座村落的价值大幅提升（按收入折算，而不是固定 150 分）', () => {
    const base = startPlaying(newGame(data), data)
    const owned = { ...base, buildings: base.buildings.map((b) => (b.id === 'v-mid' ? { ...b, owner: P1 } : b)) }

    const v1Gain = evaluate(owned, P1, data) - evaluate(base, P1, data)
    const v2Gain = evaluate(owned, P1, data, { economy: 3 }) - evaluate(base, P1, data, { economy: 3 })
    // 村落收入 400 → 额外 400 × 3 = 1200 分
    expect(v2Gain - v1Gain).toBeCloseTo(400 * 3, 6)
  })

  it('守土项：敌方正在占领我方据点 → 扣分；占领中立据点也扣（权重较低）', () => {
    const base = startPlaying(newGame(data), data)
    const enemyOnMine = {
      ...base,
      buildings: base.buildings.map((b) =>
        b.id === 'v-south' ? { ...b, owner: P1, capture: { playerId: P2, points: 10, unitId: 'u9' } } : b,
      ),
    }
    const owned = { ...enemyOnMine, buildings: enemyOnMine.buildings.map((b) => (b.id === 'v-south' ? { ...b, capture: null } : b)) }

    const mineLoss = evaluate(enemyOnMine, P1, data, { defend: 6 }) - evaluate(owned, P1, data, { defend: 6 })
    expect(mineLoss).toBeLessThan(0)
    // 有主据点（×1.5）比中立据点扣得更多
    const neutral = { ...base, buildings: base.buildings.map((b) => (b.id === 'v-south' ? { ...b, owner: null, capture: { playerId: P2, points: 10, unitId: 'u9' } } : b)) }
    const neutralLoss = evaluate(neutral, P1, data, { defend: 6 }) - evaluate({ ...neutral, buildings: neutral.buildings.map((b) => (b.id === 'v-south' ? { ...b, capture: null } : b)) }, P1, data, { defend: 6 })
    expect(mineLoss).toBeLessThan(neutralLoss)
  })

  it('王城警报：敌方正在占我方王城 → 分数暴跌（斩首 = 立即淘汰）', () => {
    const base = startPlaying(newGame(data), data)
    const hqUnderAttack = {
      ...base,
      buildings: base.buildings.map((b) =>
        b.id === 'hq-A' ? { ...b, capture: { playerId: P2, points: 10, unitId: 'u9' } } : b,
      ),
    }
    const drop = evaluate(base, P1, data, V2) - evaluate(hqUnderAttack, P1, data, V2)
    expect(drop).toBeGreaterThan(10_000)
  })

  it('补给项：残血单位站在己方据点上加分，满血单位不加', () => {
    const base = startPlaying(newGame(data), data)
    // (1,7) 是 A 的兵营：先放一个单位上去
    const hurt = addUnit(base, data, 'sword', P1, 1, 7)
    hurt.units = hurt.units.map((u) => (u.x === 1 && u.y === 7 ? { ...u, hp: 40 } : u))
    const healthy = addUnit(base, data, 'sword', P1, 1, 7)

    const hurtGain = evaluate(hurt, P1, data, { repair: 8 }) - evaluate(hurt, P1, data)
    const healthyGain = evaluate(healthy, P1, data, { repair: 8 }) - evaluate(healthy, P1, data)
    // 可回血量 min(20, 100-40) = 20 → 20 × 8 = 160
    expect(hurtGain).toBeCloseTo(20 * 8, 6)
    expect(healthyGain).toBe(0)
  })

  it('比分意识：临近回合上限才按 GDD 9.2 计分放大分差', () => {
    const base = startPlaying(newGame(data), data)
    const rich = { ...base, funds: { ...base.funds, [P1]: (base.funds[P1] ?? 0) + 5000 } }

    // 早盘：开关不生效
    expect(evaluate(rich, P1, data, { scoreAware: true })).toBeCloseTo(evaluate(rich, P1, data), 6)
    // 终盘（round ≥ 上限 - 4）：兵力/军费分差被 SCORE_FACTOR(150) 放大
    // 多 5000 军费 → 计分 +floor(5000/1000)=5 分 → 额外 5 × 150 = 750 评估分
    const late = { ...rich, round: data.rules.roundLimit - 2 }
    const lateBase = { ...base, round: data.rules.roundLimit - 2 }
    const gapWith = evaluate(late, P1, data, { scoreAware: true }) - evaluate(lateBase, P1, data, { scoreAware: true })
    const gapWithout = evaluate(late, P1, data) - evaluate(lateBase, P1, data)
    expect(gapWith - gapWithout).toBeCloseTo(5 * 150, 6)
    expect(gapWith).toBeGreaterThan(gapWithout)
  })
})

/** 把双方归属整体对调（含 pending），用于对称性断言 */
function swapSides(s: ReturnType<typeof startPlaying>) {
  const swapOwner = (o: string | null) => (o === P1 ? P2 : o === P2 ? P1 : null)
  return {
    ...s,
    players: [P2, P1],
    units: s.units.map((u) => ({ ...u, owner: swapOwner(u.owner) as string })),
    buildings: s.buildings.map((b) => ({
      ...b,
      owner: swapOwner(b.owner),
      capture: b.capture ? { ...b.capture, playerId: swapOwner(b.capture.playerId) as string } : null,
    })),
    funds: { [P1]: s.funds[P2] ?? 0, [P2]: s.funds[P1] ?? 0 },
    pending: s.pending.map((p) => ({ ...p, owner: swapOwner(p.owner) as string })),
  }
}

/** 造一个"有单位、有订单"的局面，供 v3 各项使用 */
function withPending(base: ReturnType<typeof startPlaying>, owner: string, type: string, buildingId: string) {
  return {
    ...base,
    pending: [
      ...base.pending,
      { id: 'po-' + type, type, owner: owner as string, buildingId, turnSeq: base.turnSeq },
    ],
  }
}

describe('evaluate · v3 开关（切片 3）', () => {
  it('四个开关默认全关时，与不传权重逐字一致（行为零变化）', () => {
    const s = withPending(startPlaying(newGame(data), data), P1, 'sword', 'bk-A')
    const explicitZero = { pendingMaterial: 0, counterValue: 0, rangedSafety: 0, exposure: 0 }
    expect(evaluate(s, P1, data, explicitZero)).toBe(evaluate(s, P1, data))
    expect(evaluate(s, P2, data, explicitZero)).toBe(evaluate(s, P2, data))
  })

  it('打开全部 v3 开关后仍然对称（交换双方视角后分数互换，含 pending）', () => {
    const s = withPending(
      addUnit(startPlaying(newGame(data), data), data, 'bow', P1, 3, 3),
      P1,
      'sword',
      'bk-A',
    )
    const st = swapSides(s)
    expect(evaluate(st, P2, data, V3)).toBeCloseTo(evaluate(s, P1, data, V3), 6)
    expect(evaluate(st, P1, data, V3)).toBeCloseTo(evaluate(s, P2, data, V3), 6)
  })

  it('E1：`pending` 计入材料 —— 己方订单加分、对手订单减分（按造价 × 0.8）', () => {
    const base = startPlaying(newGame(data), data)
    const cost = data.units.sword.cost
    const mine = withPending(base, P1, 'sword', 'bk-A')
    const theirs = withPending(base, P2, 'sword', 'bk-B')

    // 空 pending 时开关不产生任何分数
    expect(evaluate(base, P1, data, { pendingMaterial: 0.8 })).toBeCloseTo(evaluate(base, P1, data), 6)

    const mineGain = evaluate(mine, P1, data, { pendingMaterial: 0.8 }) - evaluate(base, P1, data, { pendingMaterial: 0.8 })
    const theirGain = evaluate(theirs, P1, data, { pendingMaterial: 0.8 }) - evaluate(base, P1, data, { pendingMaterial: 0.8 })
    expect(mineGain).toBeCloseTo(cost * 0.8, 6)
    expect(theirGain).toBeCloseTo(-cost * 0.8, 6)
  })

  it('E2：兵种克制的价值 = 各"对敌阵平均伤害"按系数折算（零和）', () => {
    // 让 B 出一队重骑兵，A 出一个长枪（克制）——
    // 断言"打开 E2 与关闭 E2 的差值"精确等于公式值，且双方互为相反数。
    const base = addUnit(addUnit(startPlaying(newGame(data), data), data, 'heavyCav', P2, 3, 3), data, 'spear', P1, 3, 5)
    const expected = () => {
      let sum = 0
      for (const u of base.units) {
        const foes = base.units.filter((x) => x.owner !== u.owner)
        if (foes.length === 0) continue
        let avg = 0
        for (const f of foes) avg += baseDamage(u.type, f.type, data)
        sum += (u.owner === P1 ? 1 : -1) * (avg / foes.length) * 2
      }
      return sum
    }

    const deltaP1 = evaluate(base, P1, data, { counterValue: 2 }) - evaluate(base, P1, data)
    const deltaP2 = evaluate(base, P2, data, { counterValue: 2 }) - evaluate(base, P2, data)
    expect(deltaP1).toBeCloseTo(expected(), 6)
    expect(deltaP1 + deltaP2).toBeCloseTo(0, 6)
  })

  it('E3：远程单位"能打到敌、而敌打不到我"才加分（贴身则没有）', () => {
    const base = startPlaying(newGame(data), data)
    const bowCost = data.units.bow.cost
    // 弓（射程 2）与敌方刀盾兵（射程 1）相距 2 格 → 我能打它、它打不到我
    const kiting = addUnit(addUnit(base, data, 'bow', P1, 0, 3), data, 'sword', P2, 0, 5)
    const gainKiting = evaluate(kiting, P1, data, { rangedSafety: 0.2 }) - evaluate(kiting, P1, data)
    expect(gainKiting).toBeCloseTo(bowCost * 0.2, 6)

    // 贴脸（距离 1）→ 双方都能打到 → 不加分
    const melee = addUnit(addUnit(base, data, 'bow', P1, 0, 3), data, 'sword', P2, 0, 4)
    const gainMelee = evaluate(melee, P1, data, { rangedSafety: 0.2 }) - evaluate(melee, P1, data)
    expect(gainMelee).toBeCloseTo(0, 6)
  })

  it('E4：暴露面只在"会被打死"时扣分（安全位不扣）', () => {
    const base = startPlaying(newGame(data), data)
    const bowCost = data.units.bow.cost
    // 两台重骑兵贴住一个弓 —— 预计承受伤害 ≥ 弓的血量 → 会被打死
    const doomed = addUnit(addUnit(addUnit(base, data, 'bow', P1, 3, 3), data, 'heavyCav', P2, 3, 4), data, 'heavyCav', P2, 4, 3)
    const gainDoomed = evaluate(doomed, P1, data, { exposure: 0.5 }) - evaluate(doomed, P1, data)
    expect(gainDoomed).toBeLessThanOrEqual(-bowCost * 0.5 + 1e-6)

    // 孤立的弓、附近无敌军 → 不扣分
    const safe = addUnit(base, data, 'bow', P1, 3, 3)
    const gainSafe = evaluate(safe, P1, data, { exposure: 0.5 }) - evaluate(safe, P1, data)
    expect(gainSafe).toBeCloseTo(0, 6)
  })
})
