import { describe, expect, it } from 'vitest'
import { incomeOf, scoreOf, startTurn } from '../../../src/game/state'
import { buildingType, unitType } from '../../../src/game/data'
import type { GameData } from '../../../src/game/data'
import type { GameState } from '../../../src/game/types'
import { P1, P2, addUnit, must, newGame, run, startPlaying, testData } from './fixtures'

const data = testData()

function playing(): GameState {
  return startPlaying(newGame(data), data)
}

function expectCode(result: ReturnType<typeof run>, code: string) {
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.code).toBe(code)
}

describe('部署阶段', () => {
  it('预算上限：3000 预算买不起 4000 的重骑兵', () => {
    const s = newGame(data)
    expect(s.deploy[P1].budget).toBe(3000)
    expectCode(run(s, P1, { type: 'deploy', unitType: 'heavyCav', x: 2, y: 7 }, data), 'DEPLOY_BUDGET_EXCEEDED')
  })

  it('数量上限：预算充足时最多部署 4 个单位', () => {
    const richData: GameData = { ...data, rules: { ...data.rules, deployBudget: 12000 } }
    let s = newGame(richData)
    s = must(run(s, P1, { type: 'deploy', unitType: 'sword', x: 2, y: 7 }, richData))
    s = must(run(s, P1, { type: 'deploy', unitType: 'sword', x: 3, y: 7 }, richData))
    s = must(run(s, P1, { type: 'deploy', unitType: 'sword', x: 2, y: 6 }, richData))
    s = must(run(s, P1, { type: 'deploy', unitType: 'sword', x: 3, y: 6 }, richData))
    expect(s.deploy[P1].placed).toBe(4)
    expectCode(run(s, P1, { type: 'deploy', unitType: 'sword', x: 4, y: 6 }, richData), 'DEPLOY_MAX_UNITS')
  })

  it('越界、占用与状态校验', () => {
    let s = newGame(data)
    expectCode(run(s, P1, { type: 'deploy', unitType: 'sword', x: 2, y: 3 }, data), 'DEPLOY_ZONE_INVALID')
    expectCode(run(s, P1, { type: 'deploy', unitType: 'sword', x: 3, y: 1 }, data), 'DEPLOY_ZONE_INVALID')
    expectCode(run(s, P1, { type: 'deployDone' }, data), 'NOTHING_TO_DO')
    s = must(run(s, P1, { type: 'deploy', unitType: 'sword', x: 2, y: 7 }, data))
    expectCode(run(s, P1, { type: 'deploy', unitType: 'spear', x: 2, y: 7 }, data), 'TILE_OCCUPIED')
    s = must(run(s, P1, { type: 'deployDone' }, data))
    expectCode(run(s, P1, { type: 'deployDone' }, data), 'ALREADY_DONE')
    expect(s.phase).toBe('DEPLOY')
  })

  it('双方完成后进入 PLAYING，并执行先手方的 START（收入 + 行动复位）', () => {
    const s = playing()
    expect(s.phase).toBe('PLAYING')
    expect(s.turnIndex).toBe(0)
    expect(s.round).toBe(1)
    // 起始资金 4000 + 首回合收入（王城 2000 + 兵营 500）= 6500
    expect(s.funds[P1]).toBe(4000 + incomeOf(s, P1, data))
    expect(incomeOf(s, P1, data)).toBe(2500)
    expect(s.units.filter((u) => u.owner === P1).every((u) => !u.acted)).toBe(true)
  })
})

describe('行动经济与校验', () => {
  it('每单位每回合只能移动一次；攻击后不能再移动', () => {
    let s = playing()
    const unit = s.units.find((u) => u.owner === P1)!
    s = must(run(s, P1, { type: 'move', unitId: unit.id, x: 2, y: 6 }, data))
    expectCode(run(s, P1, { type: 'move', unitId: unit.id, x: 3, y: 6 }, data), 'UNIT_ALREADY_MOVED')

    let s2 = playing()
    s2 = addUnit(s2, data, 'sword', P2, 3, 7)
    const attacker = s2.units.find((u) => u.owner === P1)!
    const target = s2.units.find((u) => u.owner === P2 && u.x === 3 && u.y === 7)!
    s2 = must(run(s2, P1, { type: 'attack', unitId: attacker.id, targetId: target.id }, data))
    expectCode(run(s2, P1, { type: 'move', unitId: attacker.id, x: 3, y: 7 }, data), 'UNIT_ALREADY_ACTED')
  })

  it('回合归属：非当前玩家一律拒绝', () => {
    const s = playing()
    const enemy = s.units.find((u) => u.owner === P2)!
    expectCode(run(s, P1, { type: 'move', unitId: enemy.id, x: 4, y: 0 }, data), 'UNIT_NOT_YOURS')
    expectCode(run(s, P2, { type: 'endTurn' }, data), 'NOT_YOUR_TURN')
    expectCode(run(s, P2, { type: 'move', unitId: enemy.id, x: 4, y: 0 }, data), 'NOT_YOUR_TURN')
  })

  it('间接单位（投石车）移动后不能攻击', () => {
    let s = playing()
    s = addUnit(s, data, 'catapult', P1, 0, 7)
    s = addUnit(s, data, 'sword', P2, 2, 7)
    const cat = s.units.find((u) => u.type === 'catapult')!
    const target = s.units.find((u) => u.owner === P2 && u.x === 2)!
    s = must(run(s, P1, { type: 'move', unitId: cat.id, x: 0, y: 6 }, data))
    expectCode(run(s, P1, { type: 'attack', unitId: cat.id, targetId: target.id }, data), 'INDIRECT_MOVED')
  })

  it('待机让单位结束行动', () => {
    let s = playing()
    const unit = s.units.find((u) => u.owner === P1)!
    s = must(run(s, P1, { type: 'wait', unitId: unit.id }, data))
    expect(s.units.find((u) => u.id === unit.id)?.acted).toBe(true)
  })
})

describe('占领与经济', () => {
  it('不在据点上不能占领；骑兵不能占领', () => {
    let s = playing()
    const unit = s.units.find((u) => u.owner === P1)!
    // 部署在自家王城上 → 自己的据点不触发占领
    expectCode(run(s, P1, { type: 'capture', unitId: unit.id }, data), 'NOTHING_TO_DO')
    // 移动后仍可占领，但目标格不是据点 → NOT_A_BUILDING
    s = must(run(s, P1, { type: 'move', unitId: unit.id, x: 3, y: 6 }, data))
    expectCode(run(s, P1, { type: 'capture', unitId: unit.id }, data), 'NOT_A_BUILDING')

    let s2 = playing()
    s2.units = s2.units.filter((u) => u.owner !== P1)
    s2 = addUnit(s2, data, 'lightCav', P1, 4, 3)
    const cav = s2.units.find((u) => u.owner === P1)!
    expectCode(run(s2, P1, { type: 'capture', unitId: cav.id }, data), 'CANNOT_CAPTURE')
  })

  it('占领进度累加、移动清零、结算时易主', () => {
    let s = playing()
    // 直接把 A 的步兵放到中立村落 (4,3) 上
    s.units = s.units.filter((u) => u.owner !== P1)
    s = addUnit(s, data, 'sword', P1, 4, 3)
    const unit = s.units.find((u) => u.owner === P1)!

    s = must(run(s, P1, { type: 'capture', unitId: unit.id }, data))
    expect(s.buildings.find((b) => b.id === 'v-south')?.capture?.points).toBe(10)

    // 换到 B 的回合再换回来
    s = must(run(s, P1, { type: 'endTurn' }, data))
    s = must(run(s, P2, { type: 'endTurn' }, data))
    const again = s.units.find((u) => u.owner === P1 && u.x === 4 && u.y === 3)!
    s = must(run(s, P1, { type: 'capture', unitId: again.id }, data))
    expect(s.buildings.find((b) => b.id === 'v-south')?.capture?.points).toBe(20)
    expect(s.buildings.find((b) => b.id === 'v-south')?.owner).toBeNull()

    s = must(run(s, P1, { type: 'endTurn' }, data))
    const village = s.buildings.find((b) => b.id === 'v-south')!
    expect(village.owner).toBe(P1)
    expect(village.capture).toBeNull()
    expect(incomeOf(s, P1, data)).toBe(2500 + buildingType('village', data).income)
  })

  it('移动会打断占领进度', () => {
    let s = playing()
    s.units = s.units.filter((u) => u.owner !== P1)
    s = addUnit(s, data, 'sword', P1, 4, 3)
    const unit = s.units.find((u) => u.owner === P1)!
    s = must(run(s, P1, { type: 'capture', unitId: unit.id }, data))
    s = must(run(s, P1, { type: 'endTurn' }, data))
    s = must(run(s, P2, { type: 'endTurn' }, data))
    const u2 = s.units.find((u) => u.owner === P1)!
    s = must(run(s, P1, { type: 'move', unitId: u2.id, x: 5, y: 3 }, data))
    expect(s.units.find((u) => u.id === u2.id)?.capture).toBeNull()
  })

  it('生产：扣费 → 下一回合在兵营出场；出兵格被占则顺延', () => {
    let s = playing()
    const fundsBefore = s.funds[P1]
    s = must(run(s, P1, { type: 'produce', buildingId: 'bk-A', unitType: 'spear' }, data))
    expect(s.funds[P1]).toBe(fundsBefore - unitType('spear', data).cost)
    expect(s.pending).toHaveLength(1)
    expectCode(run(s, P1, { type: 'produce', buildingId: 'bk-A', unitType: 'spear' }, data), 'ALREADY_DONE')

    s = must(run(s, P1, { type: 'endTurn' }, data))
    s = must(run(s, P2, { type: 'endTurn' }, data))
    const spawned = s.units.find((u) => u.owner === P1 && u.x === 1 && u.y === 7)
    expect(spawned?.type).toBe('spear')
    expect(s.pending).toHaveLength(0)

    // 出兵格被占 → 顺延
    let s2 = playing()
    s2 = addUnit(s2, data, 'sword', P1, 1, 7)
    s2 = must(run(s2, P1, { type: 'produce', buildingId: 'bk-A', unitType: 'sword' }, data))
    s2 = must(run(s2, P1, { type: 'endTurn' }, data))
    s2 = must(run(s2, P2, { type: 'endTurn' }, data))
    expect(s2.pending).toHaveLength(1)
  })

  it('经济与资金不足校验', () => {
    let s = playing()
    s.funds[P1] = 100
    expectCode(run(s, P1, { type: 'produce', buildingId: 'bk-A', unitType: 'sword' }, data), 'INSUFFICIENT_FUNDS')
    expectCode(run(s, P1, { type: 'produce', buildingId: 'bk-B', unitType: 'sword' }, data), 'BUILDING_NOT_OWNED')
    expectCode(run(s, P1, { type: 'produce', buildingId: 'v-south', unitType: 'sword' }, data), 'NOT_A_BUILDING')
  })

  it('据点维修：己方据点上的单位回血', () => {
    let s = playing()
    s = addUnit(s, data, 'sword', P1, 1, 7) // A 的兵营
    const hurt = s.units.find((u) => u.x === 1 && u.y === 7)!
    hurt.hp = 50
    s = must(run(s, P1, { type: 'endTurn' }, data))
    s = must(run(s, P2, { type: 'endTurn' }, data))
    expect(s.units.find((u) => u.x === 1 && u.y === 7)?.hp).toBe(70)
  })
})

describe('胜负条件（GDD 9）', () => {
  it('斩首：占领对方王城即胜', () => {
    let s = playing()
    s.units = s.units.filter((u) => u.owner !== P1)
    s = addUnit(s, data, 'sword', P1, 5, 0)
    const unit = s.units.find((u) => u.owner === P1)!
    s = must(run(s, P1, { type: 'capture', unitId: unit.id }, data))
    s = must(run(s, P1, { type: 'endTurn' }, data))
    s = must(run(s, P2, { type: 'endTurn' }, data))
    const u2 = s.units.find((u) => u.owner === P1)!
    s = must(run(s, P1, { type: 'capture', unitId: u2.id }, data))
    s = must(run(s, P1, { type: 'endTurn' }, data))
    expect(s.phase).toBe('GAME_OVER')
    expect(s.winner).toBe(P1)
    expect(s.winReason).toBe('hq_captured')
  })

  it('歼灭：对方场上单位归零即胜', () => {
    let s = playing()
    s.units = s.units.filter((u) => u.owner !== P2)
    s = must(run(s, P1, { type: 'endTurn' }, data))
    expect(s.phase).toBe('GAME_OVER')
    expect(s.winner).toBe(P1)
    expect(s.winReason).toBe('annihilation')
  })

  it('投降', () => {
    const s = playing()
    const r = run(s, P2, { type: 'resign' }, data)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.state.winner).toBe(P1)
      expect(r.state.winReason).toBe('resign')
    }
  })

  it('回合上限：按计分判定', () => {
    const shortData: GameData = { ...data, rules: { ...data.rules, roundLimit: 2 } }
    let s = startPlaying(newGame(shortData), shortData)
    s = must(run(s, P1, { type: 'endTurn' }, shortData))
    s = must(run(s, P2, { type: 'endTurn' }, shortData)) // 第 1 大回合结束
    expect(s.phase).toBe('PLAYING')
    // 给 A 一点经济优势，避免与 B 完全同分
    s.funds[P1] += 5000
    s = must(run(s, P1, { type: 'endTurn' }, shortData))
    s = must(run(s, P2, { type: 'endTurn' }, shortData)) // 第 2 大回合结束 → round 3 > 2 → 计分
    expect(s.phase).toBe('GAME_OVER')
    expect(s.winReason).toBe('score')
    expect(s.winner).toBe(P1)
    expect(scoreOf(s, P1, shortData)).toBeGreaterThan(scoreOf(s, P2, shortData))
  })

  it('结束状态拒绝后续指令', () => {
    const s = playing()
    const r = run(s, P2, { type: 'resign' }, data)
    if (!r.ok) throw new Error('resign failed')
    const after = r.state
    const unit = after.units.find((u) => u.owner === P1)!
    expectCode(run(after, P1, { type: 'move', unitId: unit.id, x: 3, y: 7 }, data), 'INVALID_PHASE')
  })
})

describe('startTurn 幂等与收入', () => {
  it('收入按据点归属累计', () => {
    let s = playing()
    const before = s.funds[P1]
    const next = startTurn(s, data)
    expect(next.state.funds[P1]).toBe(before + 2500)
  })
})
