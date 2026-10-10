/**
 * `withAdvisor` 的守门测试。
 *
 * 最重要的一条是**不变量 1**：未启用时包装器的输出必须与 `inner` **逐字相同**。
 * 这条不成立，"默认行为零变化"这个承诺就是空的 —— 因此放在最前面，且用最严格的断言
 * （不只是 `toEqual`，而是"同一个对象引用"，证明**根本没被加工过**）。
 */

import { describe, expect, it, vi } from 'vitest'
import { withAdvisor } from '../../../src/ai/advisor'
import type { AdvisorStatus } from '../../../src/ai/advisor'
import type { AdvisorClient } from '../../../src/ai/advisor/client'
import type { AdvisorPlan } from '../../../src/ai/advisor/plan'
import type { AdvisorSettings } from '../../../src/ai/advisor/settings'
import type { AiTask } from '../../../src/ai/workerProtocol'
import type { AiProfile, Difficulty } from '../../../src/ai/profile'
import { profileFor } from '../../../src/ai/profile'
import type { Command, GameState, PlayerId } from '../../../src/game/types'

// ---------------------------------------------------------------- 测试夹具

const MOCK_KEY = 'test-key'

function settings(patch: Partial<AdvisorSettings> = {}): AdvisorSettings {
  return {
    enabled: true,
    apiKey: MOCK_KEY,
    baseUrl: 'https://example.test',
    model: 'test-model',
    timeoutMs: 3_000,
    ...patch,
  }
}

const PLAN: AdvisorPlan = {
  aggression: 'high',
  economy: 'low',
  defense: 'medium',
  focusFire: 'high',
  counterPick: 'medium',
  risk: 'low',
  deploy: 'turtle',
  note: '先稳后攻',
}

/** 一个最小的、能骗过 digest 的假 state（digest 只做只读统计） */
function fakeState(): GameState {
  return {
    mapId: 'm',
    players: ['ai-0', 'you'] as PlayerId[],
    round: 3,
    turnSeq: 7,
    turnIndex: 0,
    phase: 'PLAYING',
    rev: 42,
    units: [],
    buildings: [],
    pending: [],
    funds: { 'ai-0': 100, you: 100 },
    eliminated: [],
  } as unknown as GameState
}

function makeTask(state: GameState = fakeState()): AiTask {
  return {
    state,
    playerId: 'ai-0',
    difficulty: 'normal',
    seed: 12345,
    map: { id: 'm' } as unknown as AiTask['map'],
  }
}

/** 假 inner：记录收到的 task，返回一条可辨识的指令 */
function makeInner() {
  const calls: AiTask[] = []
  const inner = (task: AiTask): Command => {
    calls.push(task)
    return { type: 'endTurn' }
  }
  return { inner, calls }
}

/** 假客户端：按脚本依次返回 */
function makeClient(results: Array<AdvisorPlan | null | Error>) {
  let index = 0
  const calls: Array<{ system: string; user: string }> = []
  const client: AdvisorClient = {
    requestPlan: async (system, user) => {
      calls.push({ system, user })
      const next = results[Math.min(index, results.length - 1)]
      index += 1
      if (next instanceof Error) throw next
      return next
    },
  }
  return { client, calls, count: () => index }
}

// ---------------------------------------------------------------- 不变量 1

describe('withAdvisor · 不变量 1：未启用 ⇒ 逐字相同', () => {
  it('enabled=false 时：inner 收到**同一个 task 对象**（证明零加工）', () => {
    const { inner, calls } = makeInner()
    const { client, count } = makeClient([PLAN])
    const wrapped = withAdvisor(inner, { settings: settings({ enabled: false }), client })

    const task = makeTask()
    const out = wrapped(task)

    expect(out).toEqual({ type: 'endTurn' })
    expect(calls).toHaveLength(1)
    // 关键：同一个引用 —— 若包装器克隆过 task，这里会失败
    expect(calls[0]).toBe(task)
    expect(count()).toBe(0) // 一个请求都没发
  })

  it('没配 key 时：同样原样透传（key 为空即视为未启用）', () => {
    const { inner, calls } = makeInner()
    const wrapped = withAdvisor(inner, { settings: settings({ apiKey: '' }) })

    const task = makeTask()
    wrapped(task)

    expect(calls[0]).toBe(task)
  })

  it('未启用时 task 上不会被塞 profile 字段', () => {
    const { inner, calls } = makeInner()
    const wrapped = withAdvisor(inner, { settings: settings({ enabled: false }) })

    wrapped(makeTask())

    expect('profile' in calls[0]).toBe(false)
  })

  it('未启用时同步返回（不变成 Promise）', () => {
    const { inner } = makeInner()
    const wrapped = withAdvisor(inner, { settings: settings({ enabled: false }) })

    const out = wrapped(makeTask())

    expect(out).not.toBeInstanceOf(Promise)
  })

  it('未启用时状态回调报 used:false / result:none', () => {
    const { inner } = makeInner()
    const seen: AdvisorStatus[] = []
    const wrapped = withAdvisor(inner, {
      settings: settings({ enabled: false }),
      onStatus: (s) => seen.push(s),
    })

    wrapped(makeTask())

    expect(seen).toEqual([{ used: false, result: 'none' }])
  })

  it('★ 未启用 ⇒ 与不带参谋逐字相同（真实内核对照）', async () => {
    const { nextCommand } = await import('../../../src/ai')
    const { DATA } = await import('../../../src/game/data')

    const task = makeTask()
    const plain = nextCommand(task.state, task.playerId, task.difficulty, DATA)
    const wrapped = withAdvisor(
      (t) => nextCommand(t.state, t.playerId, t.difficulty, DATA),
      { settings: settings({ enabled: false }) },
    )

    expect(await wrapped(task)).toEqual(plain)
  })
})

// ---------------------------------------------------------------- 启用：改档案

describe('withAdvisor · 启用时', () => {
  it('成功拿到计划 → inner 收到被覆盖的 profile（与原档不同）', async () => {
    const { inner, calls } = makeInner()
    const { client } = makeClient([PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await wrapped(makeTask())

    expect(calls).toHaveLength(1)
    const received = calls[0].profile as AiProfile
    expect(received).toBeDefined()
    expect(received).not.toEqual(profileFor('normal'))
    // PLAN.aggression = high → focusFire 被放大
    expect(received.focusFire).toBeGreaterThan(profileFor('normal').focusFire)
  })

  it('deploy=turtle 在"空部署计划"的档上会追加一个兵（easy 的 deployPlan 为空数组）', async () => {
    const { inner, calls } = makeInner()
    const { client } = makeClient([PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await wrapped({ ...makeTask(), difficulty: 'easy' as Difficulty })

    const received = calls[0].profile as AiProfile
    // easy 原 deployPlan = []；turtle 分支要求"非空且 < 4" ⇒ 空数组不追加（保持"随机部署"语义）
    expect(received.deployPlan).toEqual([])
  })

  it('deploy=turtle 在"已满 4 个"的档上不追加（避免把部署计划撑到超预算）', async () => {
    const { inner, calls } = makeInner()
    const base = profileFor('normal')
    expect(base.deployPlan.length).toBeGreaterThanOrEqual(4) // 前提
    const { client } = makeClient([PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await wrapped(makeTask())

    const received = calls[0].profile as AiProfile
    expect(received.deployPlan).toEqual(base.deployPlan)
  })

  it('plan 的 medium 字段保持不变（只有被指的维度动）', async () => {
    const { inner, calls } = makeInner()
    const base = profileFor('normal')
    const { client } = makeClient([PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await wrapped(makeTask())

    const received = calls[0].profile as AiProfile
    // PLAN.defense = medium → defend 不变
    expect(received.defend).toBe(base.defend)
    // PLAN.aggression = high → focusFire 变大
    expect(received.focusFire).toBeGreaterThan(base.focusFire)
  })

  it('★ 绝不覆盖结构字段（深度/宽度/预算）', async () => {
    const { inner, calls } = makeInner()
    const base = profileFor('oracle')
    const { client } = makeClient([PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await wrapped({ ...makeTask(), difficulty: 'oracle' as Difficulty })

    const received = calls[0].profile as AiProfile
    for (const field of [
      'searchDepth',
      'beamWidth',
      'innerBeamWidth',
      'nodeBudget',
      'expansionBudget',
      'rolloutMySteps',
      'rolloutFoeSteps',
      'rolloutFoeLookahead',
      'rolloutBudget',
      'lookaheadK',
    ] as const) {
      expect(received[field]).toBe(base[field])
    }
  })

  it('状态回调报 ok 并带上计划（含 note）', async () => {
    const { inner } = makeInner()
    const seen: AdvisorStatus[] = []
    const { client } = makeClient([PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client, onStatus: (s) => seen.push(s) })

    await wrapped(makeTask())

    expect(seen).toEqual([{ used: true, result: 'ok', plan: PLAN }])
  })

  it('返回 Promise（因为要等网络）', () => {
    const { inner } = makeInner()
    const { client } = makeClient([PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    expect(wrapped(makeTask())).toBeInstanceOf(Promise)
  })

  it('多个 AI 各自向 inner 传不同的 profile（按各自难度）', async () => {
    const { inner, calls } = makeInner()
    const { client } = makeClient([PLAN, PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await wrapped(makeTask())
    await wrapped({ ...makeTask(), playerId: 'ai-1', difficulty: 'easy' as Difficulty, seed: 999 })

    expect(calls).toHaveLength(2)
    const first = calls[0].profile as AiProfile
    const second = calls[1].profile as AiProfile
    // 两个不同难度的基底不同 ⇒ 结果应当不同
    expect(first).not.toEqual(second)
  })
})

// ---------------------------------------------------------------- 不变量 2：静默回退

describe('withAdvisor · 不变量 2：失败 ⇒ 静默回退', () => {
  it('客户端返回 null → inner 用「无 profile」被调用（= 原档）', async () => {
    const { inner, calls } = makeInner()
    const { client } = makeClient([null])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    const out = await wrapped(makeTask())

    expect(out).toEqual({ type: 'endTurn' })
    expect(calls[0].profile).toBeUndefined()
  })

  it('客户端抛错 → 不冒泡，inner 照常被调用', async () => {
    const { inner, calls } = makeInner()
    const { client } = makeClient([new Error('network down')])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await expect(wrapped(makeTask())).resolves.toEqual({ type: 'endTurn' })
    expect(calls[0].profile).toBeUndefined()
  })

  it('失败后状态回调报 fallback', async () => {
    const { inner } = makeInner()
    const seen: AdvisorStatus[] = []
    const { client } = makeClient([null])
    const wrapped = withAdvisor(inner, { settings: settings(), client, onStatus: (s) => seen.push(s) })

    await wrapped(makeTask())

    expect(seen).toEqual([{ used: true, result: 'fallback' }])
  })

  it('失败的结果不进缓存 ⇒ 下一次仍会重新问', async () => {
    const { inner } = makeInner()
    const { client, count } = makeClient([null, PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await wrapped(makeTask())
    await wrapped(makeTask())

    expect(count()).toBe(2) // 两次都发了请求
  })

  it('失败之后再成功 → 第二次能拿到计划（回退不粘滞）', async () => {
    const { inner, calls } = makeInner()
    const { client } = makeClient([new Error('boom'), PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await wrapped(makeTask())
    await wrapped(makeTask())

    expect(calls[0].profile).toBeUndefined()
    expect(calls[1].profile).toBeDefined()
  })

  it('inner 抛错 → 包装器不吞掉（那是 inner 的职责，不该被参谋层改变语义）', async () => {
    const boom = new Error('inner failed')
    const inner = (): Command => {
      throw boom
    }
    const { client } = makeClient([PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await expect(wrapped(makeTask())).rejects.toBe(boom)
  })

  it('digest 抛错（坏 state） → 静默回退，inner 仍被调用', async () => {
    const { inner, calls } = makeInner()
    const { client } = makeClient([PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    // 构造一个 players 不是数组的坏 state，digest 里 .filter 会抛
    const broken = { ...fakeState(), players: undefined } as unknown as GameState
    await expect(wrapped(makeTask(broken))).resolves.toEqual({ type: 'endTurn' })
    expect(calls[0].profile).toBeUndefined()
  })
})

// ---------------------------------------------------------------- 不变量 3：回合级缓存

describe('withAdvisor · 不变量 3：一个回合只问一次', () => {
  it('同一回合第二次调用 → 命中缓存，不发第二次请求', async () => {
    const { inner } = makeInner()
    const { client, count } = makeClient([PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await wrapped(makeTask())
    await wrapped(makeTask())

    expect(count()).toBe(1)
  })

  it('缓存命中时同步返回（不必再等网络）', async () => {
    const { inner } = makeInner()
    const { client } = makeClient([PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await wrapped(makeTask())
    const second = wrapped(makeTask())

    expect(second).not.toBeInstanceOf(Promise)
    expect(second).toEqual({ type: 'endTurn' })
  })

  it('缓存命中时 inner 收到的 profile 与第一次相同', async () => {
    const { inner, calls } = makeInner()
    const { client } = makeClient([PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await wrapped(makeTask())
    wrapped(makeTask())

    expect(calls[1].profile).toEqual(calls[0].profile)
  })

  it('换回合（round 变） → 重新请求', async () => {
    const { inner } = makeInner()
    const { client, count } = makeClient([PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await wrapped(makeTask())
    const nextRound = { ...fakeState(), round: 4 } as GameState
    await wrapped(makeTask(nextRound))

    expect(count()).toBe(2)
  })

  it('换 turnIndex → 重新请求（同一 round 内不同 AI 走子）', async () => {
    const { inner } = makeInner()
    const { client, count } = makeClient([PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await wrapped(makeTask())
    await wrapped(makeTask({ ...fakeState(), turnIndex: 1 } as GameState))

    expect(count()).toBe(2)
  })

  it('★ rev 变化**不**导致重新请求（缓存 key 不含 rev）', async () => {
    const { inner } = makeInner()
    const { client, count } = makeClient([PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await wrapped(makeTask())
    // 同一回合内 AI 走了几步，rev 变了 —— 但回合标识没变
    await wrapped(makeTask({ ...fakeState(), rev: 999 } as GameState))

    expect(count()).toBe(1)
  })

  it('换阶段（DEPLOY → PLAYING） → 重新请求', async () => {
    const { inner } = makeInner()
    const { client, count } = makeClient([PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await wrapped(makeTask())
    await wrapped(makeTask({ ...fakeState(), phase: 'DEPLOY' } as GameState))

    expect(count()).toBe(2)
  })

  it('换 AI（playerId 变） → 各自独立请求', async () => {
    const { inner } = makeInner()
    const { client, count } = makeClient([PLAN, PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await wrapped(makeTask())
    await wrapped({ ...makeTask(), playerId: 'ai-1' })

    expect(count()).toBe(2)
  })

  it('缓存是每个 thinker 私有的（两个 thinker 不共享）', async () => {
    const { inner } = makeInner()
    const a = makeClient([PLAN])
    const b = makeClient([PLAN])
    const first = withAdvisor(inner, { settings: settings(), client: a.client })
    const second = withAdvisor(inner, { settings: settings(), client: b.client })

    await first(makeTask())
    await second(makeTask())

    expect(a.count()).toBe(1)
    expect(b.count()).toBe(1)
  })
})

// ---------------------------------------------------------------- 装配细节

describe('withAdvisor · 装配', () => {
  it('请求里带上了 system 与 user prompt（非空）', async () => {
    const { inner } = makeInner()
    const { client, calls } = makeClient([PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await wrapped(makeTask())

    expect(calls).toHaveLength(1)
    expect(calls[0].system).toContain('JSON')
    expect(calls[0].user).toContain('回合')
  })

  it('设置里注入的 baseUrl 会被用于构造客户端（不读全局 localStorage）', async () => {
    const { inner } = makeInner()
    // 不传 client 时包装器会自己构造；注入一个假 fetch 观察是否被用到
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const { client } = makeClient([PLAN])
    const wrapped = withAdvisor(inner, { settings: settings(), client })

    await wrapped(makeTask())

    // 注入 client 时不应当触碰 fetch
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
