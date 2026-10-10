/**
 * LLM 参谋的网络调用层：**一次 fetch、带超时、所有失败静默返回 null**。
 *
 * ## 为什么这一层必须"什么都吞掉"
 *
 * 这个项目的铁律是**牌局永不中断**。LLM 是纯粹的"锦上添花"，
 * 任何失败（没网 / key 无效 / 超时 / 返回坏格式）都**只能表现为"这次没参谋"**，
 * 绝不能抛出异常让 AI 回合卡死。
 *
 * 因此本模块的契约极简：**要么返回一份校验过的计划，要么返回 null**。
 *
 * ## 超时为什么必须自己实现
 *
 * `workerClient` 目前**没有任何超时机制**（它只是"异常即静默回退主线程"）。
 * 但 LLM 走的是网络 —— 一次卡住的请求会让 AI 回合永久停摆（界面上就是
 * "电脑正在思考…"永远不消失）。所以这里用 `AbortController` 兜一个硬超时。
 *
 * ## 为什么不用 `AbortSignal.timeout()` 或 `fetch` 的 signal 透传
 *
 * 用一个**外部传入的 controller** 而不是 `AbortSignal.timeout`：这样测试可以
 * 用假定时器精确驱动超时，且能在请求成功/失败后主动清理定时器（不留悬挂的 timer，
 * 否则 vitest 会报"测试结束后仍有活跃句柄"）。
 */

import type { AdvisorPlan } from './plan'
import { parsePlan } from './plan'

/** DeepSeek 的 OpenAI 兼容对话端点 */
export const DEFAULT_ENDPOINT = 'https://api.deepseek.com/chat/completions'
export const DEFAULT_MODEL = 'deepseek_flash'
/** 硬超时：AI 单步之间本身有 450ms 间隔，3s 是"首拍前请求"的可接受上限 */
export const DEFAULT_TIMEOUT_MS = 3_000

export interface AdvisorClientOptions {
  /** 完整对话端点（不含 `/chat/completions` 的 base_url 由调用方拼好） */
  endpoint?: string
  model?: string
  apiKey: string
  timeoutMs?: number
  /** 可注入的 fetch（单测用 `vi.fn()` 替换；默认用全局 fetch） */
  fetchImpl?: typeof fetch
}

export interface AdvisorClient {
  /**
   * 请求一份计划。**永不 reject** —— 任何失败都返回 `null`。
   *
   * @param system system prompt
   * @param user   user prompt（局面摘要）
   */
  requestPlan: (system: string, user: string) => Promise<AdvisorPlan | null>
}

/**
 * 把 base_url 规范化成"对话端点"。
 *
 * 允许用户只填 `https://api.deepseek.com`（更符合直觉），
 * 也允许直接填完整端点（更灵活）。已经带 `/chat/completions` 就原样使用。
 */
export function toEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return DEFAULT_ENDPOINT
  if (trimmed.endsWith('/chat/completions')) return trimmed
  return trimmed + '/chat/completions'
}

/** 从 OpenAI 兼容响应里取出正文；结构与内容都不可信，因此逐层守卫 */
function extractContent(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0] as { message?: { content?: unknown } } | undefined
  const content = first?.message?.content
  return typeof content === 'string' ? content : null
}

/**
 * 从模型正文里"抠"出 JSON。
 *
 * 即便 system prompt 明确要求"只输出 JSON"，模型仍可能画蛇添足地包一层
 * ```json ... ``` 或在前后加一句话。这里做一次宽容的提取，
 * **真正的合法性判定交给 `parsePlan`**（类型/取值都由它把关）。
 */
export function extractJson(content: string): unknown {
  const trimmed = content.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    /* 继续尝试从文本里抠出第一个 JSON 对象 */
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

export function createAdvisorClient(options: AdvisorClientOptions): AdvisorClient {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT
  const model = options.model ?? DEFAULT_MODEL
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const doFetch = options.fetchImpl ?? globalThis.fetch

  async function requestPlan(system: string, user: string): Promise<AdvisorPlan | null> {
    // 没配 key：不发请求（也就不会有任何网络流量）
    if (!options.apiKey.trim()) return null
    if (typeof doFetch !== 'function') return null

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.7,
          // DeepSeek / OpenAI 兼容端点都支持；要求返回严格 JSON 可显著降低解析失败率
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      })

      if (!response.ok) return null

      const payload: unknown = await response.json()
      const content = extractContent(payload)
      if (content === null) return null

      return parsePlan(extractJson(content))
    } catch {
      // 超时（AbortError）/ 无网 / CORS / DNS / 坏 JSON —— 一律视作"这次没参谋"
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  return { requestPlan }
}
