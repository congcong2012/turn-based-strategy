/**
 * AI Worker：协议等价性 + 客户端在"没有 Worker / Worker 挂掉"时的一定可用性。
 *
 * 这里不去真的起线程（vitest 是 node 环境，没有 `Worker`），而是
 *  1. 直接测 `handleAiRequest`（Worker 里跑的纯函数）与主线程 `nextCommand` 逐字等价；
 *  2. 用假 Worker 验证客户端的两条退化路径（起不来 / 中途报错）。
 * 真 Worker 的端到端行为由 `tests/e2e/pve.spec.ts` 与 `preview.spec.ts` 覆盖。
 */

import { describe, expect, it, vi } from 'vitest'
import { DATA } from '../../src/game/data'
import { createGame } from '../../src/game/state'
import { createBlankMap } from '../../src/game/mapTemplates'
import { nextCommand } from '../../src/ai'
import { hashSeed, mulberry32 } from '../../src/ai/rng'
import { createAiWorkerClient } from '../../src/ai/workerClient'
import { createWorkerData, handleAiRequest } from '../../src/ai/workerProtocol'
import type { AiTask } from '../../src/ai/workerProtocol'
import type { GameState } from '../../src/game/types'

function taskFor(state: GameState, difficulty: 'easy' | 'normal' | 'hard', seed = 20261004): AiTask {
  return {
    state,
    playerId: state.players[1],
    difficulty,
    seed: hashSeed(seed, state.rev, state.turnSeq, state.turnIndex, state.players[1], difficulty),
    map: DATA.maps[state.mapId],
  }
}

describe('aiWorker · 协议等价性', () => {
  it('同一入参下，Worker 侧算出的指令与主线程逐字相同（这是回退安全的根据）', () => {
    const state = createGame('ancient_01', ['you', 'ai-1'], DATA)
    const data = createWorkerData()
    for (const difficulty of ['easy', 'normal', 'hard'] as const) {
      const task = taskFor(state, difficulty)
      const viaWorker = handleAiRequest({ ...task, id: 1 }, data)
      const viaMain = nextCommand(state, task.playerId, difficulty, DATA, mulberry32(task.seed))
      expect(viaWorker, difficulty).toEqual(viaMain)
    }
  })

  it('对同一个局面反复调用得到同一条指令（确定性，不受线程影响）', () => {
    const state = createGame('ancient_01', ['you', 'ai-1'], DATA)
    const data = createWorkerData()
    const task = taskFor(state, 'hard')
    const first = handleAiRequest({ ...task, id: 1 }, data)
    const second = handleAiRequest({ ...task, id: 2 }, data)
    expect(second).toEqual(first)
  })

  it('请求里带的自制地图会被注册并使用（Worker 里本来没有这张图）', () => {
    const custom = createBlankMap({ id: 'user_wtest', name: '自制图', width: 20, height: 20, players: 2 })
    const empty = createWorkerData()
    expect(empty.maps[custom.id]).toBeUndefined()

    const data = createWorkerData()
    const state = createGame(custom.id, ['you', 'ai-1'], { ...data, maps: { ...data.maps, [custom.id]: custom } })
    const task: AiTask = {
      state,
      playerId: 'ai-1',
      difficulty: 'normal',
      seed: 1,
      map: custom,
    }
    expect(() => handleAiRequest({ ...task, id: 1 }, data)).not.toThrow()
    expect(data.maps[custom.id]).toBeDefined()
  })

  it('地图缺失时抛出可诊断的错误（workerEntry 会把它转成 ok:false 回给主线程）', () => {
    const custom = createBlankMap({ id: 'user_missing_map', name: '自制图', width: 20, height: 20, players: 2 })
    const data = createWorkerData()
    const state: GameState = { ...createGame('ancient_01', ['you', 'ai-1'], DATA), mapId: custom.id }
    // 故意不把地图放进 data.maps：模拟"带的地图丢了"
    expect(() =>
      handleAiRequest({ id: 1, state, playerId: 'ai-1', difficulty: 'normal', seed: 1, map: { ...custom, id: 'user_other' } }, data),
    ).toThrow()
  })
})

describe('aiWorker · 客户端的一定可用性', () => {
  it('环境里没有 Worker（如 node/单测）时，同步返回结果并标记未使用 Worker', () => {
    const client = createAiWorkerClient()
    expect(client.usingWorker()).toBe(false)

    const state = createGame('ancient_01', ['you', 'ai-1'], DATA)
    const task = taskFor(state, 'normal')
    const result = client.think(task)
    expect(result).not.toBeInstanceOf(Promise) // 同步路径：老测试的同步假设不受影响
    expect(result).toEqual(nextCommand(state, task.playerId, 'normal', DATA, mulberry32(task.seed)))
    client.dispose()
  })

  it('创建 Worker 失败 → 退化为主线程，不抛错', () => {
    const onFallback = vi.fn()
    const client = createAiWorkerClient({
      createWorker: () => {
        throw new Error('Worker 被 CSP 拦了')
      },
      onFallback,
    })
    const state = createGame('ancient_01', ['you', 'ai-1'], DATA)
    const task = taskFor(state, 'hard')
    const result = client.think(task)
    expect(result).not.toBeInstanceOf(Promise)
    expect(onFallback).toHaveBeenCalledTimes(1)
    expect(client.usingWorker()).toBe(false)
    client.dispose()
  })

  it('Worker 中途报错 → 在途请求由主线程按同入参补算，之后不再使用 Worker', async () => {
    const onFallback = vi.fn()
    const client = createAiWorkerClient({
      createWorker: () => {
        const fake: Record<string, unknown> = { terminate: () => {} }
        fake.postMessage = () => {
          // 模拟"消息发出去之后 Worker 崩了"
          queueMicrotask(() => (fake.onerror as (() => void) | null)?.())
        }
        return fake as unknown as Worker
      },
      onFallback,
    })

    const state = createGame('ancient_01', ['you', 'ai-1'], DATA)
    const task = taskFor(state, 'normal')
    const result = client.think(task)
    expect(result).toBeInstanceOf(Promise)

    // 回退：结果仍是"同入参算出的那一条"，与主线程一致
    await expect(result).resolves.toEqual(nextCommand(state, task.playerId, 'normal', DATA, mulberry32(task.seed)))
    expect(onFallback).toHaveBeenCalled()
    expect(client.usingWorker()).toBe(false)

    // 之后的请求直接走主线程（同步）
    expect(client.think(task)).not.toBeInstanceOf(Promise)
    client.dispose()
  })

  it('Worker 内部回 ok:false（例如地图异常）时，也由主线程补算，行为不变', async () => {
    const client = createAiWorkerClient({
      createWorker: () => {
        const fake: Record<string, unknown> = { terminate: () => {} }
        fake.postMessage = (request: { id: number }) => {
          queueMicrotask(() => {
            const onmessage = fake.onmessage as ((event: { data: unknown }) => void) | null
            onmessage?.({ data: { id: request.id, ok: false, error: '未知地图' } })
          })
        }
        return fake as unknown as Worker
      },
    })
    const state = createGame('ancient_01', ['you', 'ai-1'], DATA)
    const task = taskFor(state, 'normal')
    await expect(client.think(task)).resolves.toEqual(
      nextCommand(state, task.playerId, 'normal', DATA, mulberry32(task.seed)),
    )
    client.dispose()
  })

  it('dispose 之后不再等待任何请求（不会悬挂）', () => {
    const client = createAiWorkerClient({
      createWorker: () => ({ terminate: () => {}, postMessage: () => {} }) as unknown as Worker,
    })
    const state = createGame('ancient_01', ['you', 'ai-1'], DATA)
    void client.think(taskFor(state, 'normal'))
    expect(() => client.dispose()).not.toThrow()
  })
})

describe('aiWorker · 可选 profile（LLM 参谋的覆盖档）', () => {
  it('★ 任务不带 profile ⇒ 与改造前逐字相同（协议层零变化）', () => {
    const state = createGame('ancient_01', ['you', 'ai-1'], DATA)
    const data = createWorkerData()
    const task = taskFor(state, 'hard')
    // 显式确认任务上没有 profile 字段（aiTaskFor 在不传时不会塞）
    expect('profile' in task).toBe(false)
    const viaWorker = handleAiRequest({ ...task, id: 1 }, data)
    const viaMain = nextCommand(state, task.playerId, 'hard', DATA, mulberry32(task.seed))
    expect(viaWorker).toEqual(viaMain)
  })

  it('任务带 profile ⇒ 走 nextCommandWith（用给定档案算），且与主线程一致', async () => {
    const { nextCommandWith } = await import('../../src/ai')
    const { profileFor } = await import('../../src/ai/profile')
    const { parsePlan, planToProfile } = await import('../../src/ai/advisor/plan')

    const state = createGame('ancient_01', ['you', 'ai-1'], DATA)
    const data = createWorkerData()
    const plan = parsePlan({
      aggression: 'high',
      economy: 'low',
      defense: 'medium',
      focusFire: 'high',
      counterPick: 'medium',
      risk: 'low',
      deploy: 'balanced',
    })
    expect(plan).not.toBeNull()
    const profile = planToProfile(plan!, 'hard')
    // 前提：这份档案确实与 hard 原档不同（否则这条测试没在测东西）
    expect(profile).not.toEqual(profileFor('hard'))

    const task = { ...taskFor(state, 'hard'), profile }
    const viaWorker = handleAiRequest({ ...task, id: 1 }, data)
    const viaMain = nextCommandWith(state, task.playerId, profile, DATA, mulberry32(task.seed))
    expect(viaWorker).toEqual(viaMain)
  })

  it('带 profile 时随机数种子仍用 task.seed（参谋不改随机序列）', async () => {
    const { nextCommandWith } = await import('../../src/ai')
    const { parsePlan, planToProfile } = await import('../../src/ai/advisor/plan')

    const state = createGame('ancient_01', ['you', 'ai-1'], DATA)
    const data = createWorkerData()
    const plan = parsePlan({ aggression: 'high' })!
    const profile = planToProfile(plan, 'easy')

    const task = { ...taskFor(state, 'easy'), profile }
    const viaWorker = handleAiRequest({ ...task, id: 1 }, data)
    // 用同一份 profile、同一个 seed 在主线程重算 —— 必须逐字相同
    expect(viaWorker).toEqual(nextCommandWith(state, task.playerId, profile, DATA, mulberry32(task.seed)))
  })

  it('profile 不污染难度档：同一局面下不带 profile 的结果仍是原档的', async () => {
    const { profileFor } = await import('../../src/ai/profile')
    const { parsePlan, planToProfile } = await import('../../src/ai/advisor/plan')

    const state = createGame('ancient_01', ['you', 'ai-1'], DATA)
    const data = createWorkerData()
    // 先用一份"极端"档案算一次
    const profile = planToProfile(parsePlan({ aggression: 'high', risk: 'high' })!, 'normal')
    handleAiRequest({ ...taskFor(state, 'normal'), profile, id: 1 }, data)

    // 再不带 profile 算一次 —— 结果必须等于原档（证明上一步没改到 PROFILES）
    const plain = taskFor(state, 'normal')
    expect(handleAiRequest({ ...plain, id: 2 }, data)).toEqual(
      nextCommand(state, plain.playerId, 'normal', DATA, mulberry32(plain.seed)),
    )
    // profileFor 返回副本，原表未被污染
    expect(profileFor('normal').focusFire).toBe(0.15)
  })
})
