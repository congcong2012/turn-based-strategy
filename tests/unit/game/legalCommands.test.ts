/** legalCommands：核心不变量 —— 枚举出的每一条指令都必须被 applyCommand 接受 */

import { describe, expect, it } from 'vitest'
import { applyCommand } from '../../../src/game/commands'
import { deployCommandsFor, legalCommandsFor, playCommandsFor } from '../../../src/game/legalCommands'
import { attackableTargets, reachableDestinations } from '../../../src/game/movement'
import { inDeployZone, unitsOf } from '../../../src/game/board'
import { moveCost } from '../../../src/game/data'
import type { Command, GameState, PlayerId } from '../../../src/game/types'
import { P1, P2, P3, P4, addUnit, must, newGame, run, startPlaying, startPlaying4, testData, testData4 } from './fixtures'

/** 逐条断言：枚举结果全部合法 */
function expectAllLegal(state: GameState, player: PlayerId, data: ReturnType<typeof testData>): void {
  const cmds = legalCommandsFor(state, player, data)
  for (const cmd of cmds) {
    const r = applyCommand(state, player, cmd, data)
    expect(r.ok, '应合法却被拒绝: ' + JSON.stringify(cmd) + ' → ' + (r.ok ? '' : r.code)).toBe(true)
  }
}

describe('legalCommands · 通用', () => {
  it('非本局玩家返回空数组', () => {
    const data = testData()
    let s = newGame(data)
    expect(legalCommandsFor(s, 'NOT_A_PLAYER', data)).toEqual([])
    s = startPlaying(s, data)
    expect(legalCommandsFor(s, 'NOT_A_PLAYER', data)).toEqual([])
  })

  it('对局结束返回空数组', () => {
    const data = testData()
    const s = { ...startPlaying(newGame(data), data), phase: 'GAME_OVER' as const }
    expect(legalCommandsFor(s, P1, data)).toEqual([])
  })

  it('永远不枚举 resign（AI 不投降）', () => {
    const data = testData()
    const s = startPlaying(newGame(data), data)
    expect(legalCommandsFor(s, P1, data).some((c) => c.type === 'resign')).toBe(false)
  })
})

describe('legalCommands · 部署阶段', () => {
  it('全部合法（含 deployDone）', () => {
    const data = testData()
    const s = newGame(data)
    expectAllLegal(s, P1, data)
  })

  it('未放置任何单位时不给 deployDone（内核会返回 NOTHING_TO_DO）', () => {
    const data = testData()
    const s = newGame(data)
    expect(deployCommandsFor(s, P1, data).some((c) => c.type === 'deployDone')).toBe(false)
  })

  it('放置 1 个单位后出现 deployDone', () => {
    const data = testData()
    const s = must(run(newGame(data), P1, { type: 'deploy', unitType: 'sword', x: 2, y: 7 }, data))
    expect(deployCommandsFor(s, P1, data).some((c) => c.type === 'deployDone')).toBe(true)
  })

  it('部署格必须在己方部署区、该兵种可通行、且无人占据', () => {
    const data = testData()
    const s = newGame(data)
    const map = data.maps.test
    const commands = deployCommandsFor(s, P1, data).filter((c): c is Extract<Command, { type: 'deploy' }> => c.type === 'deploy')

    expect(commands.length).toBeGreaterThan(0)
    for (const cmd of commands) {
      expect(inDeployZone(map, 0, cmd.x, cmd.y), '不在 A 的部署区: ' + cmd.x + ',' + cmd.y).toBe(true)
      const type = data.units[cmd.unitType]
      expect(moveCost(map, cmd.x, cmd.y, type.moveType, data)).not.toBeNull()
      expect(s.units.some((u) => u.x === cmd.x && u.y === cmd.y)).toBe(false)
      expect(type.cost).toBeLessThanOrEqual(data.rules.deployBudget)
    }
  })

  it('确认部署后不再给出任何部署指令', () => {
    const data = testData()
    const s = startPlaying(newGame(data), data)
    expect(deployCommandsFor(s, P1, data)).toEqual([])
  })

  it('买不起的兵种不出现在候选里', () => {
    const data = testData()
    const s = newGame(data)
    // 重骑 4000 > 部署预算 3000
    expect(deployCommandsFor(s, P1, data).some((c) => c.type === 'deploy' && c.unitType === 'heavyCav')).toBe(false)
  })
})

describe('legalCommands · 行动阶段', () => {
  it('全部合法，且恒含 endTurn', () => {
    const data = testData()
    const s = startPlaying(newGame(data), data)
    const cmds = legalCommandsFor(s, P1, data)
    expect(cmds.some((c) => c.type === 'endTurn')).toBe(true)
    expectAllLegal(s, P1, data)
  })

  it('非当前玩家返回空数组', () => {
    const data = testData()
    const s = startPlaying(newGame(data), data)
    // startPlaying 后先手是 A
    expect(playCommandsFor(s, P2, data)).toEqual([])
    expect(playCommandsFor(s, P1, data).length).toBeGreaterThan(0)
  })

  it('move 候选与 reachableDestinations 一致，attack 候选与 attackableTargets 一致', () => {
    const data = testData()
    // 把 B 的刀盾兵放到 A 单位旁边，制造可攻击目标
    let s = startPlaying(newGame(data), data)
    s = addUnit(s, data, 'sword', P2, 3, 6)

    const unit = unitsOf(s, P1)[0]
    const cmds = playCommandsFor(s, P1, data)
    const moves = cmds.filter((c): c is Extract<Command, { type: 'move' }> => c.type === 'move')
    const attacks = cmds.filter((c): c is Extract<Command, { type: 'attack' }> => c.type === 'attack')

    const expectedMoves = reachableDestinations(s, unit, data).map((d) => d.x + ',' + d.y).sort()
    expect(moves.map((m) => m.x + ',' + m.y).sort()).toEqual(expectedMoves)

    const expectedTargets = attackableTargets(s, unit, data).map((u) => u.id).sort()
    expect(attacks.map((a) => a.targetId).sort()).toEqual(expectedTargets)
    expect(attacks.length).toBeGreaterThan(0)
  })

  it('站在可占领的中立据点上时给出 capture', () => {
    const data = testData()
    // (4,0) 是中立村落 v-mid
    const s = addUnit(startPlaying(newGame(data), data), data, 'sword', P1, 4, 0)
    const onVillage = unitsOf(s, P1).find((u) => u.x === 4 && u.y === 0)
    expect(onVillage).toBeDefined()
    const cmds = playCommandsFor(s, P1, data)
    expect(cmds.some((c) => c.type === 'capture' && c.unitId === onVillage?.id)).toBe(true)
  })

  it('站在自己的据点上不给 capture（内核会返回 NOTHING_TO_DO）', () => {
    const data = testData()
    // (2,7) 是 A 自己的王城
    const s = startPlaying(newGame(data), data)
    const own = unitsOf(s, P1).find((u) => u.x === 2 && u.y === 7)
    expect(own).toBeDefined()
    expect(playCommandsFor(s, P1, data).some((c) => c.type === 'capture')).toBe(false)
  })

  it('弓兵不可占领：站在中立村落上不给 capture', () => {
    const data = testData()
    const s = addUnit(startPlaying(newGame(data), data), data, 'bow', P1, 4, 0)
    expect(playCommandsFor(s, P1, data).some((c) => c.type === 'capture')).toBe(false)
  })

  it('每个未行动单位都有 wait 兜底', () => {
    const data = testData()
    const s = startPlaying(newGame(data), data)
    const cmds = playCommandsFor(s, P1, data)
    for (const unit of unitsOf(s, P1)) {
      expect(cmds.some((c) => c.type === 'wait' && c.unitId === unit.id)).toBe(true)
    }
  })

  it('有己方兵营且资金充足时给出 produce', () => {
    const data = testData()
    const s = startPlaying(newGame(data), data)
    const cmds = playCommandsFor(s, P1, data)
    expect(cmds.some((c) => c.type === 'produce' && c.buildingId === 'bk-A')).toBe(true)
  })

  it('资金不足时不给出任何 produce', () => {
    const data = testData()
    const base = startPlaying(newGame(data), data)
    const s: GameState = { ...base, funds: { ...base.funds, [P1]: 0 } }
    expect(playCommandsFor(s, P1, data).some((c) => c.type === 'produce')).toBe(false)
  })

  it('已行动的单位不再出现在候选中', () => {
    const data = testData()
    const base = startPlaying(newGame(data), data)
    const unit = unitsOf(base, P1)[0]
    const s: GameState = {
      ...base,
      units: base.units.map((u) => (u.id === unit.id ? { ...u, acted: true } : u)),
    }
    const cmds = playCommandsFor(s, P1, data)
    expect(cmds.some((c) => 'unitId' in c && c.unitId === unit.id)).toBe(false)
  })
})

describe('legalCommands · 多人图与连续应用', () => {
  it('4 人图每个人的枚举全部合法', () => {
    const data = testData4()
    const s = startPlaying4(data)
    for (const p of [P1, P2, P3, P4]) expectAllLegal(s, p, data)
  })

  it('连续把候选喂回去，仍然条条合法（模拟 AI 逐步行动）', () => {
    const data = testData()
    let s = startPlaying(newGame(data), data)
    // 把 B 的单位放到 A 旁边，制造攻击机会
    s = addUnit(s, data, 'sword', P2, 3, 6)

    const startRound = s.round
    let steps = 0
    for (; steps < 120 && s.phase === 'PLAYING'; steps += 1) {
      const player = s.players[s.turnIndex]
      const cmds = legalCommandsFor(s, player, data)
      expect(cmds.length).toBeGreaterThan(0)
      // 取第一条非 endTurn 的指令推进（没有就结束回合）
      const pick = cmds.find((c) => c.type !== 'endTurn') ?? cmds[cmds.length - 1]
      const r = applyCommand(s, player, pick, data)
      expect(r.ok, '步骤 ' + steps + ' 被拒绝: ' + JSON.stringify(pick)).toBe(true)
      if (!r.ok) break
      s = r.state
    }

    expect(steps).toBeGreaterThan(0)
    // 至少要真的推进过回合（而不是原地踏步）
    expect(s.round).toBeGreaterThan(startRound)
  })

  it('候选规模有上界（防止退化成 O(n²) 爆炸）', () => {
    const data = testData()
    const deployCount = legalCommandsFor(newGame(data), P1, data).length
    const playCount = legalCommandsFor(startPlaying(newGame(data), data), P1, data).length
    expect(deployCount).toBeLessThan(600)
    expect(playCount).toBeLessThan(200)
  })
})
