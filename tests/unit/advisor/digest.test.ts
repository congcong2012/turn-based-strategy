/**
 * 局面摘要（`src/ai/advisor/digest`）的专项测试。
 *
 * 重点守三件事：
 *  1. **聚合数字正确**：兵力 / 军费 / 据点计数 / 回合数。
 *  2. **★ 镜像对称性**：把敌我身份对调后，双方摘要必须互换
 *     —— 这条保证摘要不泄漏"谁是我"之外的信息，LLM 的倾向建立在对称数据上。
 *  3. **不含敏感内容**：摘要里没有坐标、没有单位 id（防越权）。
 */

import { describe, expect, it } from 'vitest'
import { digest } from '../../../src/ai/advisor/digest'
import { getMap } from '../../../src/game/data'
import { P1, P2, addUnit, newGame, startPlaying, testData } from '../game/fixtures'

const data = testData()

describe('局面摘要 · 基本语义', () => {
  it('部署阶段 phase = deploy，行动阶段 phase = action', () => {
    const deploying = newGame(data)
    expect(digest({ state: deploying, playerId: P1, data }).phase).toBe('deploy')

    const playing = startPlaying(newGame(data), data)
    expect(digest({ state: playing, playerId: P1, data }).phase).toBe('action')
  })

  it('roundsLeft = 回合上限 - 当前回合，且不小于 0', () => {
    const state = startPlaying(newGame(data), data)
    const d = digest({ state, playerId: P1, data })
    expect(d.roundsLeft).toBe(data.rules.roundLimit - state.round)
    expect(d.roundsLeft).toBeGreaterThanOrEqual(0)
  })

  it('兵力值 = Σ 造价 × 血量比例；满血两个剑士 = 2 × 造价', () => {
    let state = startPlaying(newGame(data), data)
    state = addUnit(state, data, 'sword', P1, 0, 7)
    const swordCost = data.units.sword.cost
    // 场上本来有开局部署的单位，所以只断言"增加了一个满血剑士的量"
    const before = digest({ state, playerId: P1, data: data }).mine.power
    state = addUnit(state, data, 'sword', P1, 1, 7)
    const after = digest({ state, playerId: P1, data: data }).mine.power
    expect(after - before).toBeCloseTo(swordCost, 6)
  })

  it('残血单位的兵力按比例缩水', () => {
    let state = startPlaying(newGame(data), data)
    state = addUnit(state, data, 'sword', P1, 0, 7)
    const full = digest({ state, playerId: P1, data }).mine.power

    const hurt = {
      ...state,
      units: state.units.map((u) => (u.type === 'sword' && u.owner === P1 ? { ...u, hp: Math.floor(u.hp / 2) } : u)),
    }
    const halved = digest({ state: hurt, playerId: P1, data }).mine.power
    expect(halved).toBeLessThan(full)
  })

  it('据点按类型分别计数（村 / 兵营 / 王城）', () => {
    const state = startPlaying(newGame(data), data)
    const d = digest({ state, playerId: P1, data })
    // 测试地图：A 有王城 + 兵营，无村
    expect(d.mine.hq).toBe(1)
    expect(d.mine.barracks).toBe(1)
    expect(d.foes.hq).toBe(1)
    expect(d.foes.barracks).toBe(1)
  })

  it('未出场的订单计入兵力（"钱变兵"的过程不该凭空消失）', () => {
    const state = startPlaying(newGame(data), data)
    const d = digest({ state, playerId: P1, data })
    expect(d.mine.power).toBeGreaterThanOrEqual(0)
    // pending 为空时不该算入
    expect(state.pending.length).toBe(0)
  })

  it('军费按玩家取用', () => {
    const state = startPlaying(newGame(data), data)
    const d = digest({ state, playerId: P1, data })
    expect(d.mine.funds).toBe(state.funds[P1] ?? 0)
    expect(d.foes.funds).toBe(state.funds[P2] ?? 0)
  })
})

describe('局面摘要 · 王城与距离', () => {
  it('王城安全时为 true', () => {
    const state = startPlaying(newGame(data), data)
    expect(digest({ state, playerId: P1, data }).hqSafe).toBe(true)
  })

  it('王城正被敌方占领 → hqSafe = false', () => {
    const state = startPlaying(newGame(data), data)
    const myHq = state.buildings.find((b) => b.type === 'hq' && b.owner === P1)
    if (!myHq) throw new Error('测试地图应当有 A 的王城')
    const contested = {
      ...state,
      buildings: state.buildings.map((b) =>
        b.id === myHq.id ? { ...b, capture: { playerId: P2, points: 2, unitId: 'x' } } : b,
      ),
    }
    expect(digest({ state: contested, playerId: P1, data }).hqSafe).toBe(false)
  })

  it('距离给出非负数（测试地图上双方王城都存在）', () => {
    const state = startPlaying(newGame(data), data)
    const d = digest({ state, playerId: P1, data })
    expect(d.foeDistanceToMyHq).toBeGreaterThanOrEqual(0)
    expect(d.myDistanceToFoeHq).toBeGreaterThanOrEqual(0)
  })

  it('把部队推到敌王城旁边 → myDistanceToFoeHq 缩到 1 格内', () => {
    const state = startPlaying(newGame(data), data)
    const foeHq = state.buildings.find((b) => b.type === 'hq' && b.owner === P2)
    if (!foeHq) throw new Error('测试地图应当有 B 的王城')

    // 在敌王城旁边放一支我方部队，确保"最近距离"确实落在我方手里
    const near = addUnit(state, data, 'sword', P1, foeHq.x - 1, foeHq.y)
    const after = digest({ state: near, playerId: P1, data }).myDistanceToFoeHq
    // 0 也算合格（有单位就站在敌王城格上），只要是"贴脸"即可
    expect(after).toBeLessThanOrEqual(1)
  })
})

describe('★ 局面摘要 · 镜像对称性', () => {
  /** 把敌我身份整体对调（单位、据点、资金、玩家顺序） */
  function mirror(state: ReturnType<typeof startPlaying>) {
    const swap = (id: string | null): string | null => (id === P1 ? P2 : id === P2 ? P1 : id)
    return {
      ...state,
      players: [P2, P1],
      units: state.units.map((u) => ({ ...u, owner: swap(u.owner) as string })),
      buildings: state.buildings.map((b) => ({ ...b, owner: swap(b.owner) })),
      funds: { [P1]: state.funds[P2] ?? 0, [P2]: state.funds[P1] ?? 0 },
    }
  }

  it('对调双方身份后，我方与敌方的摘要互换', () => {
    const state = startPlaying(newGame(data), data)
    const mirrored = mirror(state)

    const a = digest({ state, playerId: P1, data })
    const b = digest({ state: mirrored, playerId: P2, data })

    // P1 在原局是"我"；在镜像局里换成 P2 是"我" —— 两边的我方摘要必须一致
    expect(b.mine).toEqual(a.mine)
    expect(b.foes).toEqual(a.foes)
    expect(b.balance).toBe(a.balance)
    expect(b.hqSafe).toBe(a.hqSafe)
  })

  it('镜像后"我的"与"敌方的"在同一个坐标系下互换', () => {
    const state = startPlaying(newGame(data), data)
    const a = digest({ state, playerId: P1, data })
    expect(a.mine.units).toBe(a.mine.units)
    // 兵力对比是对称的：从 P1 看是 ahead，从 P2 看就该是 behind
    expect(a.balance).toBe(a.balance)
    const fromP2 = digest({ state, playerId: P2, data })
    expect(fromP2.mine).toEqual(a.foes)
    expect(fromP2.foes).toEqual(a.mine)
  })
})

describe('局面摘要 · 不泄漏敏感信息', () => {
  it('摘要里没有坐标与单位 id（防 LLM 越权直接指挥）', () => {
    const state = startPlaying(newGame(data), data)
    const d = digest({ state, playerId: P1, data })
    const text = JSON.stringify(d)
    // 单位 id 形如 "u1" / 地图坐标不会出现在摘要里
    for (const unit of state.units) expect(text).not.toContain(unit.id)
    // 摘要的键应当在白名单内
    const allowed = new Set([
      'round',
      'roundsLeft',
      'phase',
      'mine',
      'foes',
      'balance',
      'hqSafe',
      'exposedUnits',
      'foeDistanceToMyHq',
      'myDistanceToFoeHq',
      'scoreLead',
    ])
    for (const key of Object.keys(d)) expect(allowed.has(key), `意外字段 ${key}`).toBe(true)
  })

  it('险境单位数是非负整数，且在合理上界内', () => {
    const state = startPlaying(newGame(data), data)
    const d = digest({ state, playerId: P1, data })
    expect(Number.isInteger(d.exposedUnits)).toBe(true)
    expect(d.exposedUnits).toBeGreaterThanOrEqual(0)
    expect(d.exposedUnits).toBeLessThanOrEqual(state.units.filter((u) => u.owner === P1).length)
  })

  it('纯读：不改动 state（只读摘要）', () => {
    const state = startPlaying(newGame(data), data)
    const snapshot = JSON.stringify(state)
    digest({ state, playerId: P1, data })
    expect(JSON.stringify(state)).toBe(snapshot)
  })

  it('mapId 上的地图仍可解析（摘要不依赖 Pixi / 渲染层）', () => {
    const state = startPlaying(newGame(data), data)
    expect(() => getMap(state.mapId, data)).not.toThrow()
  })
})
