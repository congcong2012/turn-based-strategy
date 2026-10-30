/**
 * 「测试连接」（`probeAdvisor`）的单测。
 *
 * 它守的是设置页那个按钮的**用户可见结论**：
 * 成功要回显模型与耗时；失败要给出**能指向具体原因**的文案
 * （key 错 / 模型名错 / 超时 / 没填 key），而不是一句"失败"。
 *
 * 手法与 `client.test.ts` 一致：注入假 fetch，不碰全局。
 */

import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_ADVISOR_SETTINGS } from '../../../src/ai/advisor/settings'
import type { AdvisorSettings } from '../../../src/ai/advisor/settings'
import { probeAdvisor } from '../../../src/ai/advisor/probe'

function fakeFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch
}

function okResponse(content: string): Response {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as unknown as Response
}

function settings(patch: Partial<AdvisorSettings> = {}): AdvisorSettings {
  return { ...DEFAULT_ADVISOR_SETTINGS, enabled: true, apiKey: 'sk-test', ...patch }
}

describe('probeAdvisor · 成功路径', () => {
  it('模型返回合法 JSON → ok，并回显模型名与耗时', async () => {
    const fetchImpl = fakeFetch(() => okResponse('{"ok":true}'))
    let clock = 1000
    const result = await probeAdvisor(settings({ model: 'deepseek-flash' }), {
      fetchImpl,
      now: () => {
        clock += 250
        return clock
      },
    })

    expect(result.ok).toBe(true)
    expect(result.model).toBe('deepseek-flash')
    expect(result.ms).toBeGreaterThan(0)
    expect(result.reason).toBeUndefined()
  })

  it('走的是和实战相同的端点（base_url 会被补成 /chat/completions）', async () => {
    const seen: string[] = []
    const fetchImpl = fakeFetch((url) => {
      seen.push(url)
      return okResponse('{"ok":true}')
    })
    await probeAdvisor(settings({ baseUrl: 'https://example.test/v1' }), { fetchImpl })
    expect(seen[0]).toBe('https://example.test/v1/chat/completions')
  })

  it('探测请求本身很小（system+user 合起来不超过 100 字），不烧钱', async () => {
    let body = ''
    const fetchImpl = fakeFetch((_url, init) => {
      body = String(init.body ?? '')
      return okResponse('{"ok":true}')
    })
    await probeAdvisor(settings(), { fetchImpl })
    const parsed = JSON.parse(body) as { messages: Array<{ content: string }> }
    const totalChars = parsed.messages.reduce((n, m) => n + m.content.length, 0)
    expect(totalChars).toBeLessThan(100)
  })
})

describe('probeAdvisor · 失败路径（都要给人话能看懂的原因）', () => {
  it('★ 没填 key → 直接返回，不发请求', async () => {
    const spy = fakeFetch(() => okResponse('{"ok":true}'))
    const result = await probeAdvisor(settings({ apiKey: '   ' }), { fetchImpl: spy })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('API Key')
    expect(spy).not.toHaveBeenCalled()
  })

  it('开关没打开 → 提示先勾选，不发请求', async () => {
    const spy = fakeFetch(() => okResponse('{"ok":true}'))
    const result = await probeAdvisor(settings({ enabled: false }), { fetchImpl: spy })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('开关')
    expect(spy).not.toHaveBeenCalled()
  })

  it('HTTP 401 → 原因带状态码（UI 会翻成"密钥无效"）', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response)
    const result = await probeAdvisor(settings(), { fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('HTTP 401')
  })

  it('HTTP 400（典型：模型名写错）→ 原因带状态码', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: false, status: 400, json: async () => ({}) }) as unknown as Response)
    const result = await probeAdvisor(settings({ model: 'deepseek_flash' }), { fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('HTTP 400')
  })

  it('网络抛错 → 把原始信息带回来（UI 翻成"网络不通"）', async () => {
    const fetchImpl = fakeFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const result = await probeAdvisor(settings(), { fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('Failed to fetch')
  })

  it('返回的不是合法 JSON → 明确指出（而不是笼统"失败"）', async () => {
    const fetchImpl = fakeFetch(() => okResponse('我不太确定'))
    const result = await probeAdvisor(settings(), { fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('JSON')
  })
})
