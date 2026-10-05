import { describe, expect, it } from 'vitest'
import {
  REPORT_LOG_LINES,
  battleReportText,
  reportTextFromState,
  resultText,
  summarizeBattle,
} from '../../../src/game/battleReport'
import { scoreOf } from '../../../src/game/state'
import type { GameState, PlayerId } from '../../../src/game/types'
import { P1, P2, addUnit, must, newGame, run, startPlaying, testData } from './fixtures'

const data = testData()

const nameOf = (playerId: PlayerId) => (playerId === P1 ? '甲将军' : playerId === P2 ? '乙将军' : playerId)

function playing(): GameState {
  return startPlaying(newGame(data), data)
}

describe('结算战绩 · 计分拆解', () => {
  it('拆解之和等于 scoreOf（两处口径必须一致）', () => {
    let s = playing()
    s = addUnit(s, data, 'sword', P1, 0, 0)
    s = addUnit(s, data, 'sword', P1, 1, 0)
    s = addUnit(s, data, 'heavyCav', P2, 1, 1)

    const summary = summarizeBattle(s, nameOf, data)
    for (const tally of summary.players) {
      const direct = scoreOf(s, tally.playerId, data)
      expect(tally.score.total).toBe(direct)
      expect(tally.score.buildings + tally.score.units + tally.score.funds).toBe(direct)
    }
  })

  it('据点分：王城 5 / 兵营 3 / 村落 1', () => {
    const s = playing()
    // 夹具里 A 持有 hq-A(王城) 与 bk-A(兵营)
    const a = summarizeBattle(s, nameOf, data).players.find((p) => p.playerId === P1)!
    expect(a.score.buildings).toBe(5 + 3)
    expect(a.buildingsByType).toEqual([
      { id: 'hq', name: '王城', count: 1 },
      { id: 'barracks', name: '兵营', count: 1 },
    ])
    expect(a.holdsHq).toBe(true)
  })

  it('展示顺序：胜者置顶，即使它得分更低（靠攻陷王城获胜的常见情形）', () => {
    let s = playing()
    // 给 B 加一个重骑兵：B 的兵力分变高、总分反超 A
    s = addUnit(s, data, 'heavyCav', P2, 3, 0)
    s = { ...s, winner: P1, winReason: 'hq_captured' }

    const summary = summarizeBattle(s, nameOf, data)
    const a = summary.players.find((p) => p.playerId === P1)!
    const b = summary.players.find((p) => p.playerId === P2)!
    expect(b.score.total).toBeGreaterThan(a.score.total) // 前提：败者分更高
    expect(summary.players[0].playerId).toBe(P1) // 但胜者排首行
    expect(summary.players[0].isWinner).toBe(true)
  })

  it('部队明细按数量降序，兵力价值按造价累加', () => {
    // 用未部署的初始局面，避免 startPlaying 已经放下的那个兵干扰计数
    let s = newGame(data)
    s = addUnit(s, data, 'sword', P1, 0, 0)
    s = addUnit(s, data, 'sword', P1, 1, 0)
    s = addUnit(s, data, 'bow', P1, 2, 0)

    const a = summarizeBattle(s, nameOf, data).players.find((p) => p.playerId === P1)!
    expect(a.unitCount).toBe(3)
    expect(a.unitsByType[0]).toEqual({ id: 'sword', name: '刀盾兵', count: 2 })
    expect(a.unitsByType[1]).toEqual({ id: 'bow', name: '弓兵', count: 1 })
    const expectValue = data.units.sword.cost * 2 + data.units.bow.cost
    expect(a.unitValue).toBe(expectValue)
  })
})

describe('结算战绩 · 投入与损失', () => {
  it('恒等式：投入 = 场上 + 队列中 + 损失', () => {
    const s = playing()
    const t = summarizeBattle(s, nameOf, data).totals
    expect(t.raised).toBe(t.onBoard + t.queued + t.lost)
  })

  it('歼灭一个单位后，损失数 +1、场上 −1，总数不变', () => {
    let s = playing()
    s = addUnit(s, data, 'sword', P1, 0, 0)
    s = addUnit(s, data, 'sword', P2, 1, 0)

    const before = summarizeBattle(s, nameOf, data).totals

    // 注意：startPlaying 已经给双方各部署了一个单位，必须按坐标取到刚加的那两个
    const attacker = s.units.find((u) => u.owner === P1 && u.x === 0 && u.y === 0)!
    const defender = s.units.find((u) => u.owner === P2 && u.x === 1 && u.y === 0)!
    defender.hp = 10 // 一刀必杀（同级刀盾平原伤害 55）
    s = must(run(s, P1, { type: 'attack', unitId: attacker.id, targetId: defender.id }, data))

    const after = summarizeBattle(s, nameOf, data).totals
    expect(after.lost).toBe(before.lost + 1)
    expect(after.onBoard).toBe(before.onBoard - 1)
    expect(after.raised).toBe(before.raised)
  })

  it('损失不会因"未出场"而重复计数（生产队列中的部队仍算投入）', () => {
    const s = playing()
    const t = summarizeBattle(s, nameOf, data).totals
    // 生产需要资金与兵营；夹具默认状态下 A 有兵营，直接下单一个最便宜的兵
    const s2 = must(run(s, P1, { type: 'produce', buildingId: 'bk-A', unitType: 'sword' }, data))
    const t2 = summarizeBattle(s2, nameOf, data).totals
    expect(t2.raised).toBe(t.raised + 1)
    expect(t2.queued).toBe(t.queued + 1)
    expect(t2.lost).toBe(t.lost)
  })
})

describe('结算战绩 · 文案', () => {
  it('resultText 覆盖胜/和/淘汰三种口吻', () => {
    const s = playing()
    const summary = summarizeBattle(s, nameOf, data)
    expect(resultText({ ...summary, winner: P1, winReason: 'hq_captured' }, nameOf)).toBe('甲将军 获胜（攻陷王城）')
    expect(resultText({ ...summary, winner: null, winReason: 'score' }, nameOf)).toBe('双方同分，和局')
    expect(resultText({ ...summary, winner: null, winReason: null }, nameOf)).toBe('和局')
  })

  it('战报文本含结果、战绩与损失统计', () => {
    const s = playing()
    const text = battleReportText(summarizeBattle(s, nameOf, data), nameOf, {
      mapLabel: '测试地图 8×8',
      selfId: P1,
    })
    expect(text).toContain('【古代战棋】对局战报')
    expect(text).toContain('测试地图 8×8')
    expect(text).toContain('甲将军（我方）')
    expect(text).toContain('乙将军')
    expect(text).toContain('王城1')
    expect(text).toMatch(/本局投入 \d+ 个部队/)
  })

  it('观战者（无 selfId）不出现「我方」标记', () => {
    const s = playing()
    const text = battleReportText(summarizeBattle(s, nameOf, data), nameOf, { selfId: null })
    expect(text).not.toContain('我方')
  })

  it('战报只附末尾若干条日志，且不会因超长日志爆掉', () => {
    const s = playing()
    const log = Array.from({ length: 30 }, (_, i) => '第 ' + (i + 1) + ' 行')
    const text = battleReportText(summarizeBattle(s, nameOf, data), nameOf, { log })
    expect(text).toContain('—— 最近战报 ——')
    expect(text).toContain('第 30 行')
    expect(text).not.toContain('第 ' + (30 - REPORT_LOG_LINES) + ' 行')
    expect(text.split('\n').filter((l) => l.startsWith('第 ')).length).toBe(REPORT_LOG_LINES)
  })

  it('reportTextFromState 自带地图标签（从 mapId 取）', () => {
    const s = playing()
    const text = reportTextFromState(s, nameOf, { data })
    expect(text).toContain('测试地图 8×8')
  })
})
