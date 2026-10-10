/**
 * LLM 参谋设置持久化的专项测试。
 *
 * 守三件事：
 *  1. **默认值安全**：默认关闭、**key 为空串**（源码里绝不写死真实密钥）。
 *  2. **坏数据不崩**：隐私模式 / 坏 JSON / 类型错 → 一律回落默认，不抛错。
 *  3. **逐字段救**：单个字段非法只回落该字段，不整体丢弃。
 *
 * ★ 注意：单测环境是 `environment: 'node'`，**没有 localStorage**。
 * 因此这里注入一个内存实现，而不是依赖真的浏览器存储。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ADVISOR_STORAGE_KEY,
  DEFAULT_ADVISOR_SETTINGS,
  clearAdvisorSettings,
  isAdvisorUsable,
  loadAdvisorSettings,
  normalizeAdvisorSettings,
  saveAdvisorSettings,
} from '../../../src/ai/advisor/settings'

/** 极简内存 storage（模拟 localStorage 的那三个方法） */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('默认设置的安全性', () => {
  it('★ 默认关闭，且 apiKey 是空串（源码里绝不写死真实密钥）', () => {
    expect(DEFAULT_ADVISOR_SETTINGS.enabled).toBe(false)
    expect(DEFAULT_ADVISOR_SETTINGS.apiKey).toBe('')
  })

  it('★ 无 localStorage 环境下读取 → 返回默认（不抛错）', () => {
    // node 环境本来就没有 localStorage，这里显式确认
    vi.stubGlobal('localStorage', undefined)
    expect(loadAdvisorSettings()).toEqual(DEFAULT_ADVISOR_SETTINGS)
  })

  it('存储里没有这一项 → 默认', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    expect(loadAdvisorSettings()).toEqual(DEFAULT_ADVISOR_SETTINGS)
  })
})

describe('读写往返', () => {
  it('存进去再读出来，字段一致', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)

    saveAdvisorSettings({
      enabled: true,
      apiKey: 'sk-abc',
      baseUrl: 'https://api.example.com',
      model: 'my-model',
      timeoutMs: 2_000,
    })

    expect(loadAdvisorSettings()).toEqual({
      enabled: true,
      apiKey: 'sk-abc',
      baseUrl: 'https://api.example.com',
      model: 'my-model',
      timeoutMs: 2_000,
    })
  })

  it('清空后回到默认', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    saveAdvisorSettings({ ...DEFAULT_ADVISOR_SETTINGS, apiKey: 'sk-x' })
    clearAdvisorSettings()
    expect(loadAdvisorSettings()).toEqual(DEFAULT_ADVISOR_SETTINGS)
  })

  it('key 前后空白被裁掉', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    saveAdvisorSettings({ ...DEFAULT_ADVISOR_SETTINGS, apiKey: '  sk-trim  ' })
    expect(loadAdvisorSettings().apiKey).toBe('sk-trim')
  })
})

describe('★ 坏数据一律回落默认（设置页永不白屏）', () => {
  it('坏 JSON → 默认', () => {
    const storage = memoryStorage()
    storage.setItem(ADVISOR_STORAGE_KEY, '{ 这不是 json')
    vi.stubGlobal('localStorage', storage)
    expect(loadAdvisorSettings()).toEqual(DEFAULT_ADVISOR_SETTINGS)
  })

  it('存的是数组 / 字符串 / null → 默认', () => {
    for (const bad of ['[]', '"hi"', 'null', '42']) {
      const storage = memoryStorage()
      storage.setItem(ADVISOR_STORAGE_KEY, bad)
      vi.stubGlobal('localStorage', storage)
      expect(loadAdvisorSettings(), `输入 ${bad}`).toEqual(DEFAULT_ADVISOR_SETTINGS)
    }
  })

  it('storage.getItem 抛错（隐私模式） → 默认', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
    })
    expect(loadAdvisorSettings()).toEqual(DEFAULT_ADVISOR_SETTINGS)
  })

  it('setItem 抛错（配额不足） → 静默失败，不抛', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    expect(() => saveAdvisorSettings(DEFAULT_ADVISOR_SETTINGS)).not.toThrow()
  })
})

describe('★ 逐字段救（单个字段非法只回落该字段）', () => {
  it('enabled 类型错 → 只回落 enabled，其余照用', () => {
    const normalized = normalizeAdvisorSettings({ enabled: 'yes', apiKey: 'sk-keep', model: 'm' })
    expect(normalized.enabled).toBe(false)
    expect(normalized.apiKey).toBe('sk-keep')
    expect(normalized.model).toBe('m')
  })

  it('timeoutMs 越界 / 非数 → 回落默认', () => {
    expect(normalizeAdvisorSettings({ timeoutMs: 10 }).timeoutMs).toBe(DEFAULT_ADVISOR_SETTINGS.timeoutMs)
    expect(normalizeAdvisorSettings({ timeoutMs: 999_999 }).timeoutMs).toBe(DEFAULT_ADVISOR_SETTINGS.timeoutMs)
    expect(normalizeAdvisorSettings({ timeoutMs: 'fast' }).timeoutMs).toBe(DEFAULT_ADVISOR_SETTINGS.timeoutMs)
    expect(normalizeAdvisorSettings({ timeoutMs: Number.NaN }).timeoutMs).toBe(DEFAULT_ADVISOR_SETTINGS.timeoutMs)
  })

  it('baseUrl / model 为空串 → 回落默认（不会拼出坏端点）', () => {
    const normalized = normalizeAdvisorSettings({ baseUrl: '   ', model: '' })
    expect(normalized.baseUrl).toBe(DEFAULT_ADVISOR_SETTINGS.baseUrl)
    expect(normalized.model).toBe(DEFAULT_ADVISOR_SETTINGS.model)
  })

  it('超长 key 被截断（防手滑粘贴一整篇文章）', () => {
    const huge = 'x'.repeat(5_000)
    expect(normalizeAdvisorSettings({ apiKey: huge }).apiKey.length).toBeLessThanOrEqual(512)
  })
})

describe('isAdvisorUsable：开关 + key 两者缺一不可', () => {
  it('关着 → 不可用（即使有 key）', () => {
    expect(isAdvisorUsable({ ...DEFAULT_ADVISOR_SETTINGS, enabled: false, apiKey: 'sk-x' })).toBe(false)
  })

  it('开着但没 key → 不可用（不发请求）', () => {
    expect(isAdvisorUsable({ ...DEFAULT_ADVISOR_SETTINGS, enabled: true, apiKey: '' })).toBe(false)
    expect(isAdvisorUsable({ ...DEFAULT_ADVISOR_SETTINGS, enabled: true, apiKey: '   ' })).toBe(false)
  })

  it('开着且有 key → 可用', () => {
    expect(isAdvisorUsable({ ...DEFAULT_ADVISOR_SETTINGS, enabled: true, apiKey: 'sk-x' })).toBe(true)
  })
})
