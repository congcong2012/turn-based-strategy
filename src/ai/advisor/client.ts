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
/**
 * 模型 id。
 *
 * ⚠️ **必须用连字符 `deepseek-flash`** —— DeepSeek 网关里没有下划线写法，
 * `deepseek_flash` 会被拒（400/404），而本层契约是"失败一律返回 null"，
 * 于是表现成**参谋永远静默回退**、界面上没有任何提示（v1.6.0 的真实线上 bug）。
 * 可用值以 `GET /models` 为准（当前：`deepseek-flash` / `deepseek-v4-pro`）。
 */
export const DEFAULT_MODEL = 'deepseek-flash'
/**
 * 硬超时。
 *
 * ⚠️ 为什么不是 3 秒（v1.6.0 的初值）：`deepseek-flash` 是**推理模型**，
 * 一次真实请求实测约 **3.4 秒**（纯版 252 提示 token，419 推理 token + 62 正文 token）。
 * 3 秒会在返回前就 AbortController.abort()，而本层"失败即静默"，于是表现成
 * "开了参谋毫无反应" —— 和模型名写错时的症状一模一样（两个 bug 叠在一起）。
 *
 * 10 秒的依据：给慢网/长摘要留 3 倍余量；同时它是"AI 首拍前的等待上限"，
 * 断网时每回合最多多等 10 秒（之后照常按原档走），不会卡死。
 */
export const DEFAULT_TIMEOUT_MS = 10_000

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
  /**
   * 最近一次失败的原因（**仅用于诊断**；成功时返回 null）。
   *
   * 为什么需要它：本模块刻意"失败即静默"，否则 LLM 的任何抖动都会变成玩家的报错弹窗。
   * 但完全没有痕迹的静默会让排查变成猜谜 —— 例如模型 id 写错时，
   * 现象只是"参谋好像没生效"，看不出是 400。有了这条，`__atPve.advisorStatus().reason`
   * 就能直接说出 `HTTP 400` / 超时 / 解析失败。
   */
  lastFailure?: () => string | null
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

  /** 最近一次失败原因（诊断用；成功时清空） */
  let lastFailure: string | null = null

  async function requestPlan(system: string, user: string): Promise<AdvisorPlan | null> {
    lastFailure = null
    // 没配 key：不发请求（也就不会有任何网络流量）
    if (!options.apiKey.trim()) {
      lastFailure = '未配置 API Key'
      return null
    }
    if (typeof doFetch !== 'function') {
      lastFailure = '当前环境没有 fetch'
      return null
    }

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

      if (!response.ok) {
        lastFailure = `HTTP ${response.status}`
        return null
      }

      const payload: unknown = await response.json()
      const content = extractContent(payload)
      if (content === null) {
        lastFailure = '响应里没有 choices[0].message.content'
        return null
      }

      const plan = parsePlan(extractJson(content))
      if (!plan) {
        lastFailure = '返回内容不是合法的计划 JSON'
        return null
      }
      return plan
    } catch (err) {
      // 超时（AbortError）/ 无网 / CORS / DNS / 坏 JSON —— 一律视作"这次没参谋"
      lastFailure = err instanceof Error ? err.message : String(err)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  return { requestPlan, lastFailure: () => lastFailure }
}
