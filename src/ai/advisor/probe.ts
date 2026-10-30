/**
 * 「测试连接」：在**开局之前**单独验证 key / 接口地址 / 模型名是否可用。
 *
 * ## 为什么需要它
 *
 * 参谋这一层刻意"失败即静默"（否则 LLM 的任何抖动都会变成玩家的报错弹窗）。
 * 代价是：key 填错、模型名写错、接口地址写错时，玩家的体感只有"开了好像没用"，
 * 而且**对局中途没有任何提示**。v1.7.0 就因此把"参谋完全没生效"带上过线。
 *
 * 这个探测把"静默失败"变成"开局前就能看见的一次明确结论"：
 * 发一个只有几十 token 的请求，走**和实战完全相同**的代码路径
 * （`createAdvisorClient` → `requestPlan` → `parsePlan`），因此它验证的是真链路，
 * 不是"能不能连上主机"这种弱检查。
 *
 * ## 契约
 *
 * **永不抛错**：任何异常都折叠成 `{ ok: false, reason }`，由 UI 负责展示。
 * 理由和网络层一致 —— 设置页绝不能因为探测失败而白屏。
 */

import { DEFAULT_MODEL, DEFAULT_TIMEOUT_MS, createAdvisorClient, toEndpoint } from './client'
import { isAdvisorUsable } from './settings'
import type { AdvisorSettings } from './settings'

export interface ProbeResult {
  ok: boolean
  /** 往返耗时（毫秒）—— 玩家能据此判断"是不是慢到会被超时掐断" */
  ms: number
  /** 失败原因（原始、机器可读；UI 用 `humanizeAdvisorReason` 翻译成人话） */
  reason?: string
  /** 实际使用的模型名（成功时回显，让玩家确认没填错） */
  model?: string
}

/**
 * 探测用的最小提示词。
 *
 * 只要一个合法 JSON —— 既能验证鉴权/模型/端点，又能验证
 * `response_format: json_object` 这条链路，且花费可以忽略（几十 token）。
 */
const PROBE_SYSTEM = '只输出一个 JSON 对象：{"ok":true}'
const PROBE_USER = 'ping'

export interface ProbeOptions {
  /** 注入 fetch（单测用） */
  fetchImpl?: typeof fetch
  /** 注入时钟（单测用，便于断言耗时） */
  now?: () => number
  /** 覆盖超时；不传则用设置里的值 */
  timeoutMs?: number
}

export async function probeAdvisor(
  settings: AdvisorSettings,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const now = options.now ?? (() => Date.now())
  const started = now()

  // 先在本地拦掉"根本没配"的情况：不发无意义的请求
  if (!isAdvisorUsable(settings)) {
    return {
      ok: false,
      ms: 0,
      reason: settings.enabled ? '还没填 API Key' : '请先勾选「AI 参谋」开关',
    }
  }

  const timeoutMs = Math.min(options.timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_MS, 30_000)
  const model = settings.model.trim() || DEFAULT_MODEL

  const client = createAdvisorClient({
    endpoint: toEndpoint(settings.baseUrl),
    model,
    apiKey: settings.apiKey,
    timeoutMs,
    fetchImpl: options.fetchImpl,
  })

  const plan = await client.requestPlan(PROBE_SYSTEM, PROBE_USER)
  const ms = Math.max(0, now() - started)

  if (!plan) {
    return { ok: false, ms, reason: client.lastFailure?.() ?? '未知原因' }
  }
  return { ok: true, ms, model }
}
