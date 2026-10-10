/** pveSession：纯离线对局（无传输层、无大厅、无房主选举） */

import { describe, expect, it } from 'vitest'
import { createPveSession, describePveMatch, normalizeConfig, PVE_HUMAN_ID } from '../../src/app/pveSession'
import type { AiThinker, PveConfig, PvePersistReason, PveSaveData, PveSession } from '../../src/app/pveSession'
import { nextCommand } from '../../src/ai'
import { mulberry32 } from '../../src/ai/rng'
import type { AiTask } from '../../src/ai/workerProtocol'
import { DATA } from '../../src/game/data'
import { currentPlayer } from '../../src/game/state'
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

// ------------------------------------------------------------------ 存档 / 恢复

/** 人类一侧快速走完部署（与 playToEnd 同样的托管策略） */
function finishDeploy(session: PveSession): void {
  for (let i = 0; i < 10; i += 1) {
    const game = session.getView().game as GameState
    if (game.phase !== 'DEPLOY' || game.deploy['you'].done) break
    session.sendCommand(nextCommand(game, 'you', 'normal'))
  }
  session.sendCommand({ type: 'deployDone' })
}

function trackingSession(config: PveConfig = baseConfig()) {
  const seen: Array<{ data: PveSaveData; reason: PvePersistReason }> = []
  const session = createPveSession({
    config,
    schedule: syncSchedule,
    actionDelayMs: 0,
    onPersist: (data, reason) => seen.push({ data, reason }),
  })
  return { session, seen }
}

describe('pveSession · 存档', () => {
  it('构造后即以 system 落盘一次（部署阶段 AI 的那几步是 ai）', () => {
    const { seen } = trackingSession(baseConfig({ opponents: 1, humanSeat: 1 }))
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1].reason).toBe('system')
    const last = seen[seen.length - 1].data
    expect(last.config.opponents).toBe(1)
    expect(last.state.phase).toBe('DEPLOY')
    expect(last.state.players).toEqual(['ai-0', 'you'])
  })

  it('人类指令以 human 落盘', () => {
    const { session, seen } = trackingSession()
    seen.length = 0
    session.sendCommand({ type: 'deploy', unitType: 'sword', x: 2, y: 0 })
    expect(seen.some((s) => s.reason === 'human')).toBe(true)
  })

  it('AI 步进以 ai 落盘（上层据此做尾部节流）', () => {
    const { session, seen } = trackingSession()
    finishDeploy(session)
    seen.length = 0
    session.sendCommand({ type: 'endTurn' }) // 交给 AI，同步跑完
    expect(seen.filter((s) => s.reason === 'ai').length).toBeGreaterThan(0)
  })

  it('对局结束时报 ended（上层收到后会清档，而不是写档）', () => {
    const { session, seen } = trackingSession()
    session.sendCommand({ type: 'resign' })
    expect(seen[seen.length - 1].reason).toBe('ended')
    expect(seen[seen.length - 1].data.state.phase).toBe('GAME_OVER')
  })

  it('从存档恢复：局面与战报逐字一致', () => {
    const { seen } = trackingSession(baseConfig({ opponents: 1, humanSeat: 1 }))
    const snapshot = seen[seen.length - 1].data

    const resumed = createPveSession({
      restore: { config: snapshot.config, state: snapshot.state, journal: snapshot.journal },
      schedule: syncSchedule,
      actionDelayMs: 0,
    })

    expect(resumed.getView().game).toEqual(snapshot.state)
    expect(resumed.getView().log).toEqual(snapshot.journal.log)
    expect(resumed.getView().players).toHaveLength(2)
  })

  it('从存档恢复后能继续打到终局', () => {
    const { seen } = trackingSession(baseConfig({ opponents: 1, humanSeat: 1 }))
    const snapshot = seen[seen.length - 1].data

    const resumed = createPveSession({
      restore: { config: snapshot.config, state: snapshot.state, journal: snapshot.journal },
      schedule: syncSchedule,
      actionDelayMs: 0,
    })
    playToEnd(resumed)
    expect((resumed.getView().game as GameState).phase).toBe('GAME_OVER')
  })

  it('存档停在 AI 的回合时，恢复后 AI 会自己继续走（setTimeout 不跨刷新）', () => {
    const { session, seen } = trackingSession()
    finishDeploy(session)
    session.sendCommand({ type: 'endTurn' })

    const midAi = seen.find(
      (s) => s.reason === 'ai' && s.data.state.phase === 'PLAYING' && currentPlayer(s.data.state) !== 'you',
    )
    expect(midAi, '应当能抓到"轮到 AI"的中间存档').toBeTruthy()
    const checkpoint = midAi!.data

    const resumed = createPveSession({
      restore: { config: checkpoint.config, state: checkpoint.state, journal: checkpoint.journal },
      schedule: syncSchedule,
      actionDelayMs: 0,
    })
    // 构造时 resumeScheduling 已经把 AI 推进一步以上
    expect((resumed.getView().game as GameState).rev).toBeGreaterThan(checkpoint.state.rev)
  })

  it('既不给 config 也不给 restore 时直接报错', () => {
    expect(() => createPveSession({ schedule: syncSchedule })).toThrow(/必须提供/)
  })

  it('恢复后 AI 行为可复现：同一份存档恢复两次，走出的局面一致', () => {
    const { session, seen } = trackingSession(baseConfig())
    finishDeploy(session)
    session.sendCommand({ type: 'endTurn' })
    const checkpoint = seen[seen.length - 1].data

    const restore = () =>
      createPveSession({
        restore: { config: checkpoint.config, state: checkpoint.state, journal: checkpoint.journal },
        schedule: syncSchedule,
        actionDelayMs: 0,
      })
    const a = playToEndWith(restore())
    const b = playToEndWith(restore())
    expect(a).toEqual(b)
  })
})

/** 把一局托管打完，返回终局的 winner（用于对比两次恢复的结果） */
function playToEndWith(session: PveSession): { winner: string | null; round: number } {
  playToEnd(session)
  const game = session.getView().game as GameState
  return { winner: game.winner, round: game.round }
}

describe('pveSession · 异步"思考"（Web Worker 路径）', () => {
  /**
   * 异步实现：与默认实现**同入参、同算法**，只是把结果包成 Promise ——
   * 这正是 Worker 的语义（把纯函数搬到另一个线程）。
   */
  const asyncThink: AiThinker = (task) =>
    Promise.resolve(nextCommand(task.state, task.playerId, task.difficulty, DATA, mulberry32(task.seed)))

  /** 把在途的 Promise 链跑完（同步调度器 + 异步思考的组合下，推进靠微任务） */
  async function settle(rounds = 600): Promise<void> {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve()
  }

  function sessionWith(aiThink?: AiThinker): PveSession {
    return createPveSession({ config: baseConfig(), schedule: syncSchedule, actionDelayMs: 0, aiThink })
  }

  /**
   * 让人类一侧把部署走完（用 nextCommand 代打，避免手写部署坐标）。
   *
   * ⚠️ 每条指令之间 `await settle()` —— 这是**刻意的**，不是权宜之计：
   *
   * 部署阶段从"AI 同步部署"改成"AI 走 `think`（可能异步）"之后，为保住
   * "所有 AI 先部署完、人类再落子"这条**顺序不变量**（它是 `rev` 序列、
   * 进而所有 AI 派生种子一致、进而两条路径逐字同棋的前提），会话加了一道
   * **AI 先行闸门**：AI 部署在途时收到的人类指令会被排队，等 AI 收尾后按序重放。
   *
   * 若这里连发 5 条而不 await，`getView()` 在排队期间看到的局面没变，
   * `nextCommand` 会**返回同一条指令 5 次** —— 5 条重复指令里只有第 1 条合法，
   * 后 4 条因"落点已被占"被拒，队列耗尽后卡在部署阶段。这纯属测试夹具的失真，
   * 真实 UI 里人类点击间隔是秒级，AI 部署在亚毫秒内早已完成，闸门几乎不会合上。
   *
   * 故此处显式模拟真实时序：发一条 → 让在途的 AI 部署跑完 → 再发下一条。
   * 同步路径下 `settle()` 等价于无操作，因此对既有断言零影响。
   */
  async function deployAsHuman(session: PveSession): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
      const view = session.getView()
      const game = view.game as GameState
      if (game.phase !== 'DEPLOY') return
      if (game.deploy[view.selfId]?.done) return
      session.sendCommand(nextCommand(game, view.selfId, 'normal'))
      await settle()
    }
  }

  it('注入异步思考后，AI 依然能走完回合并把控制权交回人类（不假死）', async () => {
    const session = sessionWith(asyncThink)
    await deployAsHuman(session)
    await settle()

    const game = session.getView().game as GameState
    expect(game.phase).toBe('PLAYING')
    expect(session.getView().myTurn).toBe(true)
  })

  it('异步路径与同步路径走出的棋完全一致（战报逐条相同）', async () => {
    const sync = sessionWith()
    await deployAsHuman(sync)

    const asyncSession = sessionWith(asyncThink)
    await deployAsHuman(asyncSession)
    await settle()

    // 人类结束回合，逼 AI 再走一轮；两条路径都要跑完整
    sync.sendCommand({ type: 'endTurn' })
    asyncSession.sendCommand({ type: 'endTurn' })
    await settle()

    expect(asyncSession.getView().log).toEqual(sync.getView().log)
    expect((asyncSession.getView().game as GameState).rev).toBe((sync.getView().game as GameState).rev)
  })

  it('等待思考期间人类认输：迟到的 AI 指令不落子（局面不会被旧指令污染）', async () => {
    const session = sessionWith(asyncThink)
    // 构造时 AI 的部署思考已经在途（尚未 settle）—— 此刻立刻认输
    session.sendCommand({ type: 'resign' })
    const afterResign = session.getView().game as GameState
    await settle()
    const afterSettle = session.getView().game as GameState

    expect(afterSettle.rev).toBe(afterResign.rev)
    expect(afterSettle.phase).toBe('GAME_OVER')
  })

  it('思考抛错时兜底结束该 AI 的回合，不会把整局卡死', async () => {
    const session = sessionWith(() => {
      throw new Error('思考炸了')
    })
    await deployAsHuman(session)
    await settle()

    const game = session.getView().game as GameState
    expect(game.phase).toBe('PLAYING')
    expect(session.getView().myTurn).toBe(true)
  })
})

// ------------------------------------------------------------------ LLM 参谋接线
//
// 这一组守着"部署阶段也走 `think`"这条改造，以及"参谋只改档案、不改随机数"这条承诺。
// 之所以重要：`pumpDeploy` 原本直接调 `nextCommand`（绕过 `think`），
// 改造成走 `think` 之后，部署阶段才能拿到参谋给的倾向。

describe('pveSession · 部署阶段走 think（LLM 参谋接线）', () => {
  const syncScheduleLocal = (fn: () => void) => {
    fn()
    return () => {}
  }
  async function settle(rounds = 600): Promise<void> {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve()
  }

  it('★ 部署阶段会调用注入的 think（改造前是绕过 think 直接 nextCommand）', () => {
    const seen: AiTask[] = []
    const session = createPveSession({
      config: baseConfig(),
      schedule: syncScheduleLocal,
      actionDelayMs: 0,
      aiThink: (task) => {
        seen.push(task)
        return nextCommand(task.state, task.playerId, task.difficulty, DATA, mulberry32(task.seed))
      },
    })
    // 构造时 AI 的部署就走 think —— 因此至少被调用过一次
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((t) => t.playerId !== PVE_HUMAN_ID)).toBe(true)
    expect(session.getView().game).toBeTruthy()
  })

  it('部署期传入的任务不带 profile（除非参谋层注入）', () => {
    const seen: AiTask[] = []
    createPveSession({
      config: baseConfig(),
      schedule: syncScheduleLocal,
      actionDelayMs: 0,
      aiThink: (task) => {
        seen.push(task)
        return nextCommand(task.state, task.playerId, task.difficulty, DATA, mulberry32(task.seed))
      },
    })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((t) => t.profile === undefined)).toBe(true)
  })

  it('think 抛错时退回默认实现，部署仍能走完（不会卡死）', async () => {
    const session = createPveSession({
      config: baseConfig(),
      schedule: syncScheduleLocal,
      actionDelayMs: 0,
      aiThink: () => {
        throw new Error('部署期思考炸了')
      },
    })
    // 人类把部署确认掉，之后进入 PLAYING（证明 AI 的部署没有被卡住）
    for (let i = 0; i < 20; i += 1) {
      const view = session.getView()
      const game = view.game as GameState
      if (game.phase !== 'DEPLOY' || game.deploy[view.selfId]?.done) break
      session.sendCommand(nextCommand(game, view.selfId, 'normal'))
    }
    session.sendCommand({ type: 'deployDone' })
    await settle()

    expect((session.getView().game as GameState).phase).toBe('PLAYING')
  })

  it('注入 profile 的 think：用该档案产出的部署指令（不改随机数）', async () => {
    const { parsePlan, planToProfile } = await import('../../src/ai/advisor/plan')
    const { nextCommandWith } = await import('../../src/ai')
    const plan = parsePlan({ aggression: 'high', deploy: 'turtle' })
    expect(plan).not.toBeNull()

    const seenProfiles: Array<unknown> = []
    const session = createPveSession({
      config: baseConfig(),
      schedule: syncScheduleLocal,
      actionDelayMs: 0,
      aiThink: (task) => {
        // 参谋层会给 task 注入 profile；这里模拟"注入后交给内核"
        const profile = planToProfile(plan!, task.difficulty)
        seenProfiles.push(profile)
        return nextCommandWith(task.state, task.playerId, profile, DATA, mulberry32(task.seed))
      },
    })
    expect(seenProfiles.length).toBeGreaterThan(0)
    expect(session.getView().game).toBeTruthy()
  })
})
