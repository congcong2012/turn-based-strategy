/**
 * LLM 参谋的**装配层**：把「大模型给倾向」接到「搜索内核出指令」这条链上。
 *
 * ## 一句话概括
 *
 * `withAdvisor` 是 `AiThinker` 的一层**装饰器**：它先问一次 LLM 要"作战倾向"，
 * 把倾向翻成 `AiProfile` 覆盖层塞进 task，再交给**原有**的 `inner`（也就是
 * `nextCommand` / Worker）去算具体指令。搜索内核、评估器、rollout **一行都不改**。
 *
 * ## 三条必须守住的不变量（都有单测）
 *
 * 1. **未启用 ⇒ 逐字相同**：`settings.enabled === false` 或没配 key 时，
 *    直接把 task 原样转给 `inner`，**不做任何加工**。这条是"默认行为零变化"的保证。
 * 2. **失败 ⇒ 静默回退**：任何异常（摘要算错、网络层抛错、inner 抛错）都被
 *    最外层 try/catch 吃掉，退化成"这一次没参谋"。**牌局永不中断。**
 * 3. **缓存以"回合"为单位**：LLM 是慢且贵的（秒级、要钱），而 AI 一回合要走几十步。
 *    因此**一个回合只问一次**，该回合内后续每一步都复用同一份倾向。
 *
 * ## 为什么缓存 key 不能用 `state.rev`
 *
 * `rev` 是"每次指令都自增"的版本号 —— 同一个回合里第 1 步和第 2 步的 `rev` 就不同，
 * 拿它做 key 会导致**每一步都重新请求**（正是要避免的）。
 * 更糟的是 `wait` 分支不自增 `rev`，key 会撞在一起。
 * 因此改用**语义上稳定的回合标识**：`playerId : round : turnIndex : phase`。
 *
 * ## 为什么缓存放在闭包 Map 里而不是持久化
 *
 * 这是刻意的：**参谋结果不进存档、不进状态**。理由有三
 *  - 参谋默认关闭，把"未启用"这条默认路径保持得越干净越好；
 *  - 存档里混进 LLM 的输出会让"同种子必然同结果"这条复现性承诺失效；
 *  - 内存缓存的生存期天然等于"这一局这一档参谋"，随会话销毁而消失，不泄漏。
 *
 * 代价是"开了参谋后刷新页面，同一个回合可能拿到不同的倾向"——
 * 这一点已在设置页明确告知玩家（默认关闭，故默认路径不受影响）。
 */

import { DATA } from '../../game/data'
import type { GameData } from '../../game/data'
import type { Command } from '../../game/types'
import type { AiTask } from '../workerProtocol'
import { nextCommand } from '../index'
import { createAdvisorClient, toEndpoint } from './client'
import type { AdvisorClient } from './client'
import { digest } from './digest'
import { planToProfile } from './plan'
import type { AdvisorPlan } from './plan'
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt'
import { DEFAULT_ADVISOR_SETTINGS, isAdvisorUsable, loadAdvisorSettings } from './settings'
import type { AdvisorSettings } from './settings'

/** `AiThinker` 的形状（本地重声明，避免 `advisor → app` 的反向依赖） */
export type AdvisorInner = (task: AiTask) => Command | Promise<Command>

/** 参谋的一次工作结果（仅用于观测，绝不参与决策） */
export interface AdvisorStatus {
  /** 本次是否走了参谋（false = 未启用/已跳过） */
  used: boolean
  /** 参谋结果：'none'=未启用，'ok'=拿到了计划，'fallback'=问了但回退 */
  result: 'none' | 'ok' | 'fallback'
  /** 拿到的计划（用于 HUD 展示 `note` 与各维度倾向） */
  plan?: AdvisorPlan
  /** 回退原因（仅排查用；正常为 undefined） */
  reason?: string
}

export interface AdvisorOptions {
  /** 覆盖设置（默认从 localStorage 读）。测试显式传入即可完全脱离浏览器环境 */
  settings?: AdvisorSettings
  /** 覆盖网络客户端（默认按 settings 构造）。测试注入假实现 */
  client?: AdvisorClient
  /** 覆盖数据集（默认 `DATA`；测试注入） */
  data?: GameData
  /** 状态回调（HUD 展示 / 观测点） */
  onStatus?: (status: AdvisorStatus) => void
}

/** 缓存 key：语义稳定的"回合标识"（**绝不能用 rev**，见文件头注释） */
function cacheKey(task: AiTask): string {
  const { playerId, state } = task
  return `${playerId}:${state.round}:${state.turnIndex}:${state.phase}`
}

/**
 * 用 `settings` 构造一个网络客户端。
 *
 * 抽出成独立函数是为了让 `withAdvisor` 保持"纯装配"，且**只有真正要发请求时**
 * 才 new 一个 client（未启用时连客户端都不需要存在）。
 */
function clientFor(settings: AdvisorSettings, injected?: AdvisorClient): AdvisorClient {
  if (injected) return injected
  return createAdvisorClient({
    endpoint: toEndpoint(settings.baseUrl),
    model: settings.model,
    apiKey: settings.apiKey,
    timeoutMs: settings.timeoutMs,
  })
}

/**
 * 把"参谋"这层能力套在一个 `AiThinker` 外面。
 *
 * @param inner 原有的思考实现（主线程同步 / Worker 均可）—— 参谋只负责**改档案**，
 *              真正出指令的始终是它。
 * @param options 设置 / 客户端 / 数据集 / 状态回调
 * @returns 一个**行为完全向后兼容**的 `AiThinker`：未启用时逐字等价于 `inner`
 */
export function withAdvisor(inner: AdvisorInner, options: AdvisorOptions = {}): AdvisorInner {
  // 设置与客户端在**装配时**就固定下来：之后不再重读 localStorage。
  // 这样"一局之内参谋配置稳定"，也不会因为玩家中途改设置而产生半途换算法的诡异行为。
  const settings = options.settings ?? loadAdvisorSettings()
  const data = options.data ?? DATA
  const active = isAdvisorUsable(settings)
  // 未启用：连客户端都不建（省掉一个闭包对象，也不会有任何网络代码路径）
  const client = active ? clientFor(settings, options.client) : null
  const cache = new Map<string, AdvisorPlan>()

  return (task: AiTask): Command | Promise<Command> => {
    // ── 不变量 1：未启用 ⇒ 原样透传，逐字相同 ──────────────────────────
    if (!active || client === null) {
      options.onStatus?.({ used: false, result: 'none' })
      return inner(task)
    }

    try {
      const key = cacheKey(task)

      // 缓存的计划：直接复用，不发第二次请求
      const cached = cache.get(key)
      if (cached) {
        options.onStatus?.({ used: true, result: 'ok', plan: cached })
        return inner({ ...task, profile: planToProfile(cached, task.difficulty) })
      }

      // ── 需要请求：返回 Promise（AiThinker 本就支持异步） ────────────────
      return (async (): Promise<Command> => {
        let plan: AdvisorPlan | null = null
        try {
          const summary = digest({ state: task.state, playerId: task.playerId, data })
          plan = await client.requestPlan(SYSTEM_PROMPT, buildUserPrompt(summary))
        } catch {
          // 摘要/请求抛错：视作"这次没参谋"，继续往下走（inner 用原档）
          plan = null
        }

        if (plan) {
          cache.set(key, plan)
          options.onStatus?.({ used: true, result: 'ok', plan })
        } else {
          options.onStatus?.({ used: true, result: 'fallback' })
        }

        // 拿到计划 → 覆盖档案；拿不到 → 传 undefined（即"用 inner 自己的默认"）
        const patched: AiTask = plan
          ? { ...task, profile: planToProfile(plan, task.difficulty) }
          : { ...task, profile: undefined }
        return await inner(patched)
      })()
    } catch (err) {
      // ── 不变量 2：任何同步异常 ⇒ 静默回退原实现 ────────────────────────
      options.onStatus?.({
        used: true,
        result: 'fallback',
        reason: err instanceof Error ? err.message : String(err),
      })
      return inner(task)
    }
  }
}

/**
 * 默认装配：`withAdvisor(nextCommand 包装)`。
 *
 * 给"不想显式接线"的调用方（例如未来的评估台或脚本）一个开箱即用的 thinker。
 * `usePveGame` 走的是显式路线（它要用 Worker 作为 inner）。
 */
export function advisorThinker(options: AdvisorOptions = {}): AdvisorInner {
  const data = options.data ?? DATA
  return withAdvisor((task) => nextCommand(task.state, task.playerId, task.difficulty, data), options)
}

/** 清空某个 thinker 的缓存（目前无用；保留给"下一局重开"的语义扩展） */
export { DEFAULT_ADVISOR_SETTINGS }
