/** pveStore：单人对局存档的往返、校验与降级 */

import { describe, expect, it } from 'vitest'
import { DATA } from '../../src/game/data'
import { createGame } from '../../src/game/state'
import { emptyJournal } from '../../src/game/journal'
import type { GameStorage } from '../../src/net/gameStore'
import {
  PVE_SAVE_VERSION,
  PVE_STORAGE_KEY,
  clearPve,
  isPlausibleConfig,
  loadPve,
  savePve,
} from '../../src/app/pveStore'
import type { PveSnapshot } from '../../src/app/pveStore'
import type { PveConfig } from '../../src/app/pveSession'

interface MemoryStorage extends GameStorage {
  data: Map<string, string>
}

function memoryStorage(): MemoryStorage {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
    removeItem: (key) => {
      data.delete(key)
    },
  }
}

const config: PveConfig = { opponents: 1, humanSeat: 0, difficulty: 'normal', seed: 12345 }

function snapshot(overrides: Partial<PveSnapshot> = {}): PveSnapshot {
  return {
    version: PVE_SAVE_VERSION,
    savedAt: 1_700_000_000_000,
    config,
    state: createGame('ancient_01', ['you', 'ai-1'], DATA),
    journal: { ...emptyJournal(), log: ['甲：开局'], seq: 1 },
    ...overrides,
  }
}

describe('pveStore · 往返', () => {
  it('存进去再读出来，内容一致（含配置、状态与战报）', () => {
    const storage = memoryStorage()
    const snap = snapshot()
    savePve(storage, snap)

    const loaded = loadPve(storage)
    expect(loaded).not.toBeNull()
    expect(loaded?.version).toBe(PVE_SAVE_VERSION)
    expect(loaded?.config).toEqual(config)
    expect(loaded?.state.mapId).toBe('ancient_01')
    expect(loaded?.state.players).toEqual(['you', 'ai-1'])
    expect(loaded?.journal.log).toEqual(['甲：开局'])
  })

  it('没有存档时返回 null', () => {
    expect(loadPve(memoryStorage())).toBeNull()
  })

  it('clearPve 之后读不到', () => {
    const storage = memoryStorage()
    savePve(storage, snapshot())
    clearPve(storage)
    expect(loadPve(storage)).toBeNull()
    expect(storage.data.has(PVE_STORAGE_KEY)).toBe(false)
  })
})

describe('pveStore · 校验与降级', () => {
  it('版本号不符：清档并返回 null', () => {
    const storage = memoryStorage()
    savePve(storage, snapshot({ version: PVE_SAVE_VERSION + 1 }))
    expect(loadPve(storage)).toBeNull()
    expect(storage.data.has(PVE_STORAGE_KEY)).toBe(false)
  })

  it('坏 JSON：返回 null 且不抛错', () => {
    const storage = memoryStorage()
    storage.setItem(PVE_STORAGE_KEY, '{ 这不是 json')
    expect(loadPve(storage)).toBeNull()
  })

  it('配置非法（对手数越界 / 难度不认识 / 种子不是数）：清档并返回 null', () => {
    const cases: unknown[] = [
      { ...config, opponents: 9 },
      { ...config, opponents: 0 },
      { ...config, humanSeat: 5 },
      { ...config, difficulty: 'nightmare' },
      { ...config, seed: 'abc' },
      null,
    ]
    for (const bad of cases) {
      const storage = memoryStorage()
      savePve(storage, snapshot({ config: bad as PveConfig }))
      expect(loadPve(storage), JSON.stringify(bad)).toBeNull()
      expect(storage.data.has(PVE_STORAGE_KEY)).toBe(false)
    }
  })

  it('对局状态不可信（地图不存在）：清档并返回 null', () => {
    const storage = memoryStorage()
    const state = createGame('ancient_01', ['you', 'ai-1'], DATA)
    savePve(storage, snapshot({ state: { ...state, mapId: 'no_such_map' } }))
    expect(loadPve(storage)).toBeNull()
    expect(storage.data.has(PVE_STORAGE_KEY)).toBe(false)
  })

  it('座位数与配置推不出来的一致：清档并返回 null', () => {
    const storage = memoryStorage()
    // 配置说 1 个对手（2 方），状态里却有 3 方 —— 两份数据对不上
    const state = createGame('ancient_04', ['you', 'ai-1', 'ai-2'], DATA)
    savePve(storage, snapshot({ state }))
    expect(loadPve(storage)).toBeNull()
    expect(storage.data.has(PVE_STORAGE_KEY)).toBe(false)
  })

  it('战报损坏时只丢战报，不丢整局', () => {
    const storage = memoryStorage()
    savePve(storage, snapshot({ journal: { log: 'not-an-array' } as never }))

    const loaded = loadPve(storage)
    expect(loaded).not.toBeNull()
    expect(loaded?.journal.log).toEqual([])
    expect(loaded?.journal.events).toEqual([])
  })

  it('storage 不可用（隐私模式）时静默失败，不影响对局', () => {
    expect(loadPve(null)).toBeNull()
    expect(() => savePve(null, snapshot())).not.toThrow()
    expect(() => clearPve(null)).not.toThrow()
  })
})

describe('pveStore · isPlausibleConfig', () => {
  it('接受三档难度与合法区间', () => {
    for (const difficulty of ['easy', 'normal', 'hard'] as const) {
      expect(isPlausibleConfig({ ...config, difficulty })).toBe(true)
    }
    expect(isPlausibleConfig({ opponents: 3, humanSeat: 3, difficulty: 'hard', seed: 0 })).toBe(true)
  })

  it('拒绝越界与缺字段', () => {
    expect(isPlausibleConfig({ ...config, opponents: 4 })).toBe(false)
    expect(isPlausibleConfig({ ...config, humanSeat: 2 })).toBe(false)
    expect(isPlausibleConfig({ opponents: 1, humanSeat: 0, difficulty: 'easy' })).toBe(false)
    expect(isPlausibleConfig(undefined)).toBe(false)
  })
})
