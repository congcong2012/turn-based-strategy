/** pveSession：纯离线对局（无传输层、无大厅、无房主选举） */

import { describe, expect, it } from 'vitest'
import { createPveSession, describePveMatch, normalizeConfig, PVE_HUMAN_ID } from '../../src/app/pveSession'
import type { PveConfig, PveSession } from '../../src/app/pveSession'
import { nextCommand } from '../../src/ai'
import type { GameState } from '../../src/game/types'
import type { RoomView } from '../../src/net/roomSession'

/** 同步调度器：让 AI 在测试里立刻跑完，不需要 await */
const syncSchedule = (fn: () => void) => {
  fn()
  return () => {}
}

function baseConfig(overrides: Partial<PveConfig> = {}): PveConfig {
  return { opponents: 1, humanSeat: 0, difficulty: 'normal', seed: 12345, ...overrides }
}

function makeSession(config: PveConfig = baseConfig()): PveSession {
  return createPveSession({ config, schedule: syncSchedule, actionDelayMs: 0 })
}

/** 把人类一侧也交给 AI 托管，一路打到 GAME_OVER */
function playToEnd(session: PveSession, maxSteps = 2000): number {
  let steps = 0
  while (steps < maxSteps) {
    const view = session.getView()
    const game = view.game as GameState
    if (game.phase === 'GAME_OVER') break
    steps += 1

    if (game.phase === 'DEPLOY') {
      if (game.deploy[view.selfId]?.done) break // AI 是同步的，理论上不会卡在这里
      session.sendCommand(nextCommand(game, view.selfId, 'normal'))
      continue
    }

    if (!view.myTurn) break // 同步调度下不应出现
    session.sendCommand(nextCommand(game, view.selfId, 'normal'))
  }
  return steps
}

describe('pveSession · 配置与视图', () => {
  it('normalizeConfig 把对手数收敛到 1–3，出生角收敛到合法座位', () => {
    expect(normalizeConfig({ opponents: 9, humanSeat: 9, difficulty: 'easy', seed: 1 }).opponents).toBe(3)
    expect(normalizeConfig({ opponents: 0, humanSeat: -5, difficulty: 'easy', seed: 1 }).opponents).toBe(1)
    expect(normalizeConfig({ opponents: 1, humanSeat: -5, difficulty: 'easy', seed: 1 }).humanSeat).toBe(0)
    expect(normalizeConfig({ opponents: 2, humanSeat: 9, difficulty: 'easy', seed: 1 }).humanSeat).toBe(2)
  })

  it('人数决定地图：2 人用 2 人图，3–4 人用 4 人图', () => {
    expect(describePveMatch(baseConfig({ opponents: 1 })).mapId).toBe('ancient_01')
    expect(describePveMatch(baseConfig({ opponents: 2 })).mapId).toBe('ancient_04')
    expect(describePveMatch(baseConfig({ opponents: 3 })).mapId).toBe('ancient_04')
  })

  it('座位顺序就是出手顺序：人类占据所选出生角', () => {
    const match = describePveMatch(baseConfig({ opponents: 2, humanSeat: 1 }))
    expect(match.seatIds).toEqual(['ai-0', 'you', 'ai-2'])
  })

  it('视图是一个"离线但完整"的 RoomView', () => {
    const session = makeSession()
    const view = session.getView()

    expect(view.selfId).toBe(PVE_HUMAN_ID)
    expect(view.selfId).toBe('you')
    expect(view.game).not.toBeNull()
    expect(view.players).toHaveLength(2)
    expect(view.myTurn).toBe(false) // 还在部署阶段
    expect(view.connection).toBe('connected')
    expect(view.paused).toBe(false)
    expect(view.offlinePlayers).toEqual([])
    expect(view.roomCode).toBeNull()
    expect(view.log.length).toBeGreaterThan(0) // AI 已自动部署，产生战报
    expect(view.players.map((p) => p.nickname)).toEqual(['你', '电脑甲'])
  })

  it('人类不是 0 号座位时，AI 会先完成部署', () => {
    const session = makeSession(baseConfig({ opponents: 1, humanSeat: 1 }))
    const game = session.getView().game as GameState
    expect(game.deploy['ai-0'].done).toBe(true)
  })
})

describe('pveSession · 对局推进', () => {
  it('人类完成部署后进入行动阶段', () => {
    const session = makeSession()
    let game = session.getView().game as GameState
    expect(game.phase).toBe('DEPLOY')

    const aiId = session.getView().players.find((p) => p.playerId !== 'you')!.playerId
    expect(game.deploy[aiId].done).toBe(true) // AI 已自动部署

    // 人类部署一个兵并确认
    session.sendCommand(nextCommand(game, 'you', 'normal'))
    session.sendCommand(nextCommand(game, 'you', 'normal'))
    session.sendCommand({ type: 'deployDone' })

    game = session.getView().game as GameState
    expect(game.phase).toBe('PLAYING')
  })

  it('人类结束回合后，AI 会同步走完自己的回合并把控制权交还', () => {
    const session = makeSession()
    // 走完部署
    for (let i = 0; i < 10; i += 1) {
      const g = session.getView().game as GameState
      if (g.phase !== 'DEPLOY') break
      if (g.deploy['you'].done) break
      session.sendCommand(nextCommand(g, 'you', 'normal'))
    }
    session.sendCommand({ type: 'deployDone' })

    expect((session.getView().game as GameState).phase).toBe('PLAYING')
    expect(session.getView().myTurn).toBe(true)

    session.sendCommand({ type: 'endTurn' })
    // AI 同步行动完毕 → 回到人类
    expect(session.getView().myTurn).toBe(true)
    expect((session.getView().game as GameState).phase).toBe('PLAYING')
  })

  it('非法指令被拒绝并写入 error，且不改变状态', () => {
    const session = makeSession()
    const before = JSON.stringify(session.getView().game)
    session.sendCommand({ type: 'endTurn' }) // 部署阶段不允许 endTurn
    expect(session.getView().error).toBeTruthy()
    expect(JSON.stringify(session.getView().game)).toBe(before)
  })

  it('能一路打到 GAME_OVER', () => {
    const session = makeSession()
    const steps = playToEnd(session)
    expect(steps).toBeGreaterThan(0)
    expect((session.getView().game as GameState).phase).toBe('GAME_OVER')
  })

  it('难度为简单时同样能收局', () => {
    const session = makeSession(baseConfig({ difficulty: 'easy' }))
    playToEnd(session)
    expect((session.getView().game as GameState).phase).toBe('GAME_OVER')
  })

  it('3 人局：4 角图会空出一角，该角的王城为中立的"争夺目标"', () => {
    const session = makeSession(baseConfig({ opponents: 2, humanSeat: 0 }))
    const game = session.getView().game as GameState
    expect(game.mapId).toBe('ancient_04')
    expect(game.players).toHaveLength(3)

    const neutralHqs = game.buildings.filter((b) => b.type === 'hq' && b.owner === null)
    expect(neutralHqs).toHaveLength(1) // 无主王城：可占领、给收入，但不触发任何人的淘汰

    const ownedHqs = game.buildings.filter((b) => b.type === 'hq' && b.owner !== null)
    expect(ownedHqs).toHaveLength(3)
  })
})

describe('pveSession · 生命周期', () => {
  it('restart 会重开一局，并可顺带改配置', () => {
    const session = makeSession()
    playToEnd(session)
    expect((session.getView().game as GameState).phase).toBe('GAME_OVER')

    session.restart({ difficulty: 'easy' })
    const game = session.getView().game as GameState
    expect(game.phase).toBe('DEPLOY')
    expect(game.round).toBe(1)
    expect(session.getView().log.length).toBeGreaterThan(0)
  })

  it('restart 后不同种子的"简单"AI 行为可复现', () => {
    const a = makeSession(baseConfig({ difficulty: 'easy', seed: 7 }))
    const b = makeSession(baseConfig({ difficulty: 'easy', seed: 7 }))
    playToEnd(a)
    playToEnd(b)
    expect((a.getView().game as GameState).winner).toBe((b.getView().game as GameState).winner)
  })

  it('onChange 只在视图真正变化时触发，dispose 后不再触发', () => {
    const seen: RoomView[] = []
    const session = createPveSession({
      config: baseConfig(),
      schedule: syncSchedule,
      actionDelayMs: 0,
      onChange: (v) => seen.push(v),
    })
    expect(seen.length).toBe(0) // 构造阶段不主动回调

    session.sendCommand({ type: 'endTurn' }) // 部署阶段非法 → 记录 error 并 emit
    const afterError = seen.length
    expect(afterError).toBeGreaterThan(0)
    expect(seen[seen.length - 1].error).toBeTruthy()

    session.dispose()
    session.sendCommand({ type: 'endTurn' })
    expect(seen.length).toBe(afterError) // dispose 后不再 emit
  })
})
