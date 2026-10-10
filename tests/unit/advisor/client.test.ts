/**
 * LLM 参谋的网络层测试。
 *
 * ★ 这是**项目里第一个 fetch mock**（此前全仓 `tests/` 搜不到 `fetch`）。
 * 手法：把假 fetch 通过 `options.fetchImpl` **依赖注入**进去，
 * 比 `vi.stubGlobal` 更干净 —— 不污染全局，也不会漏掉还原。
 *
 * 守的核心：**所有失败路径都必须返回 null**（而不是抛异常）。
 * 因为铁律是"牌局永不中断"，一次抛出的网络异常会让 AI 回合卡死。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  createAdvisorClient,
  extractJson,
  toEndpoint,
} from '../../../src/ai/advisor/client'

/** 造一个"返回指定响应"的假 fetch */
function fakeFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch
}

/** 造一个 OpenAI 兼容的成功响应 */
function okResponse(content: string): Response {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as unknown as Response
}

const PLAN_JSON = JSON.stringify({
  aggression: 'high',
  economy: 'low',
  defense: 'medium',
  focusFire: 'medium',
  counterPick: 'high',
  risk: 'low',
  deploy: 'rusher',
})

describe('toEndpoint 规范化', () => {
  it('只有 base_url → 补上 /chat/completions', () => {
    expect(toEndpoint('https://api.deepseek.com')).toBe(DEFAULT_ENDPOINT)
    expect(toEndpoint('https://api.deepseek.com/')).toBe(DEFAULT_ENDPOINT)
  })

  it('已经是完整端点 → 原样使用', () => {
    expect(toEndpoint(DEFAULT_ENDPOINT)).toBe(DEFAULT_ENDPOINT)
  })

  it('空串 → 默认端点', () => {
    expect(toEndpoint('')).toBe(DEFAULT_ENDPOINT)
    expect(toEndpoint('   ')).toBe(DEFAULT_ENDPOINT)
  })
})

describe('extractJson 宽容提取', () => {
  it('纯 JSON → 直接解析', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('被 ```json 围栏包住 → 抠出 JSON', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('前后有解释文字 → 抠出第一个对象', () => {
    expect(extractJson('好的，这是我的建议： {"a":1} 以上。')).toEqual({ a: 1 })
  })

  it('完全不是 JSON → null', () => {
    expect(extractJson('抱歉，我无法回答')).toBeNull()
    expect(extractJson('')).toBeNull()
    expect(extractJson('{坏}')).toBeNull()
  })
})

describe('createAdvisorClient · 成功路径', () => {
  it('合法响应 → 返回计划', async () => {
    const fetchImpl = fakeFetch(() => okResponse(PLAN_JSON))
    const client = createAdvisorClient({ apiKey: 'k', fetchImpl })
    const plan = await client.requestPlan('sys', 'usr')
    expect(plan).not.toBeNull()
    expect(plan?.aggression).toBe('high')
    expect(plan?.deploy).toBe('rusher')
  })

  it('发到规范化后的端点，带 Bearer 认证与模型名', async () => {
    const spy = vi.fn(() => okResponse(PLAN_JSON))
    const client = createAdvisorClient({ apiKey: 'sk-test', fetchImpl: spy as unknown as typeof fetch })
    await client.requestPlan('sys', 'usr')

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(DEFAULT_ENDPOINT)
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe(DEFAULT_MODEL)
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[1].content).toBe('usr')
  })

  it('自定义 base_url / model 生效', async () => {
    const spy = vi.fn(() => okResponse(PLAN_JSON))
    const client = createAdvisorClient({
      apiKey: 'k',
      endpoint: toEndpoint('https://example.com/v1'),
      model: 'my-model',
      fetchImpl: spy as unknown as typeof fetch,
    })
    await client.requestPlan('sys', 'usr')
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.com/v1/chat/completions')
    expect(JSON.parse(init.body as string).model).toBe('my-model')
  })
})

describe('★ createAdvisorClient · 所有失败路径都返回 null（不抛）', () => {
  it('key 为空 → 不发请求', async () => {
    const spy = vi.fn(() => okResponse(PLAN_JSON))
    const client = createAdvisorClient({ apiKey: '', fetchImpl: spy as unknown as typeof fetch })
    expect(await client.requestPlan('s', 'u')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('HTTP 非 200 → null', async () => {
    for (const status of [400, 401, 403, 429, 500, 503]) {
      const fetchImpl = fakeFetch(() => ({ ok: false, status, json: async () => ({}) }) as unknown as Response)
      const client = createAdvisorClient({ apiKey: 'k', fetchImpl })
      expect(await client.requestPlan('s', 'u'), `HTTP ${status}`).toBeNull()
    }
  })

  it('fetch 抛错（无网 / DNS / CORS） → null', async () => {
    const fetchImpl = fakeFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const client = createAdvisorClient({ apiKey: 'k', fetchImpl })
    expect(await client.requestPlan('s', 'u')).toBeNull()
  })

  it('响应体不是合法 JSON → null', async () => {
    const fetchImpl = fakeFetch(
      () => ({ ok: true, json: async () => { throw new SyntaxError('bad json') } }) as unknown as Response,
    )
    const client = createAdvisorClient({ apiKey: 'k', fetchImpl })
    expect(await client.requestPlan('s', 'u')).toBeNull()
  })

  it('响应结构缺 choices / content → null', async () => {
    const cases: unknown[] = [{}, { choices: [] }, { choices: [{ message: {} }] }, { choices: [{ message: { content: 42 } }] }]
    for (const payload of cases) {
      const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => payload }) as unknown as Response)
      const client = createAdvisorClient({ apiKey: 'k', fetchImpl })
      expect(await client.requestPlan('s', 'u')).toBeNull()
    }
  })

  it('★ 模型输出格式不合规（schema 错） → null（而不是抛出）', async () => {
    const fetchImpl = fakeFetch(() => okResponse('{"aggression":"超强"}'))
    const client = createAdvisorClient({ apiKey: 'k', fetchImpl })
    expect(await client.requestPlan('s', 'u')).toBeNull()
  })

  it('模型输出根本不是 JSON → null', async () => {
    const fetchImpl = fakeFetch(() => okResponse('我不太确定该怎么打'))
    const client = createAdvisorClient({ apiKey: 'k', fetchImpl })
    expect(await client.requestPlan('s', 'u')).toBeNull()
  })

  it('★ 超时 → null（用假定时器精确驱动，且不留悬挂句柄）', async () => {
    vi.useFakeTimers()
    try {
      // 一个永不 resolve 的 fetch —— 只能靠超时中断
      const fetchImpl = fakeFetch(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init.signal
            signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          }),
      )
      const client = createAdvisorClient({ apiKey: 'k', timeoutMs: 50, fetchImpl })

      const pending = client.requestPlan('s', 'u')
      await vi.advanceTimersByTimeAsync(60)
      expect(await pending).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('成功路径不残留定时器（否则 vitest 会报活跃句柄）', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = fakeFetch(() => okResponse(PLAN_JSON))
      const client = createAdvisorClient({ apiKey: 'k', timeoutMs: 5_000, fetchImpl })
      const plan = await client.requestPlan('s', 'u')
      expect(plan).not.toBeNull()
      // 若定时器没被清掉，推进时间会触发 abort（本可无视），但活跃句柄数会露馅
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
