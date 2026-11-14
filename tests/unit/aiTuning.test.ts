/**
 * 手调 AI 参数（首页「开发者工具」）。
 *
 * 三条不变量：
 *  1. **没调过 = 零变化**（空覆盖必须原样返回同一个档案对象）；
 *  2. **localStorage 是不可信输入** —— 脏值/越界/未知键都要被丢掉或夹住，绝不能变成 NaN；
 *  3. 覆盖优先级最高（显式手调压过参谋建议）。
 */

import { describe, expect, it } from 'vitest'
import {
  AI_TUNING_STORAGE_KEY,
  clearAiTuning,
  loadAiTuning,
  mergeTuning,
  normalizeTuning,
  saveAiTuning,
} from '../../src/app/aiTuning'
import type { TuningStorage } from '../../src/app/aiTuning'
import { PROFILES, profileFor } from '../../src/ai/profile'

function memoryStorage(): TuningStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

describe('normalizeTuning · 不可信输入', () => {
  it('未知键、错误类型、NaN 一律丢弃', () => {
    const out = normalizeTuning({
      focusFire: 0.9,
      unknownKey: 5,
      threat: 'high',
      defend: Number.NaN,
      v2: 'yes',
      smartProduce: false,
    })
    expect(out.focusFire).toBe(0.9)
    expect(out.smartProduce).toBe(false)
    expect('unknownKey' in out).toBe(false)
    expect('threat' in out).toBe(false)
    expect('defend' in out).toBe(false)
    expect('v2' in out).toBe(false)
  })

  it('越界会被夹到区间内，并按 step 取整', () => {
    const out = normalizeTuning({ focusFire: 99, cohesion: -5, lookaheadK: 7.6 })
    expect(out.focusFire).toBe(2) // max
    expect(out.cohesion).toBe(0) // min
    expect(out.lookaheadK).toBe(8) // step 1 取整
  })

  it('非对象输入 → 空覆盖（不抛）', () => {
    for (const bad of [null, undefined, 42, 'x', []]) {
      expect(normalizeTuning(bad)).toEqual({})
    }
  })
})

describe('mergeTuning · 零变化与覆盖', () => {
  it('★ 空覆盖必须原样返回同一个对象（"没调过 = 行为不变"的依据）', () => {
    const base = profileFor('hard')
    expect(mergeTuning(base, {})).toBe(base)
    expect(mergeTuning(base, undefined)).toBe(base)
  })

  it('数值与布尔都被写进副本，且不改原对象', () => {
    const base = profileFor('hard')
    const merged = mergeTuning(base, { focusFire: 1.8, defend: 0, v2: false })
    expect(merged.focusFire).toBe(1.8)
    expect(merged.defend).toBe(0)
    expect(merged.v2).toBe(false)
    // 原档案不受影响
    expect(base.focusFire).toBe(PROFILES.hard.focusFire)
    expect(base.v2).toBe(PROFILES.hard.v2)
  })

  it('未覆盖的字段保持原值', () => {
    const base = profileFor('hard')
    const merged = mergeTuning(base, { counter: 3 })
    expect(merged.counter).toBe(3)
    expect(merged.economy).toBe(base.economy)
    expect(merged.lookaheadK).toBe(base.lookaheadK)
  })
})

describe('存取', () => {
  it('存 → 读 往返一致；清除后回到空覆盖', () => {
    const storage = memoryStorage()
    saveAiTuning({ focusFire: 1.2, defend: 0 }, storage)
    expect(storage.data.has(AI_TUNING_STORAGE_KEY)).toBe(true)
    expect(loadAiTuning(storage)).toEqual({ focusFire: 1.2, defend: 0 })

    clearAiTuning(storage)
    expect(loadAiTuning(storage)).toEqual({})
  })

  it('存脏数据/坏 JSON → 读回空覆盖（不抛）', () => {
    const storage = memoryStorage()
    storage.setItem(AI_TUNING_STORAGE_KEY, '{oops')
    expect(loadAiTuning(storage)).toEqual({})
    storage.setItem(AI_TUNING_STORAGE_KEY, JSON.stringify({ threat: 'x' }))
    expect(loadAiTuning(storage)).toEqual({})
  })

  it('没有 storage（隐私模式）时不抛', () => {
    expect(() => saveAiTuning({ focusFire: 1 }, null)).not.toThrow()
    expect(loadAiTuning(null)).toEqual({})
  })
})
