/**
 * LLM 参谋的**本机设置**：开关、API Key、接口地址、模型名。
 *
 * ## 为什么单独存、不放进 `PveConfig`
 *
 * 这些是"这台机器上的偏好"（跨局有效），不是"这一局的配置"。
 * 放进 `PveConfig` 会污染存档校验（`isPlausibleConfig`）与恢复往返 ——
 * 存档里混进 API Key 更是绝对不能接受的事。
 * 独立存储的结果是：**PVE 存档零改动、老存档零迁移**。
 *
 * ## 关于密钥的处理（重要）
 *
 * 项目是**纯静态、零服务器**，因此密钥**没有安全的服务端存放处**。
 * 本模块的立场是：
 *  - **源码里绝不写死真实 key**（默认值恒为空串）；
 *  - key 只存在**玩家自己的浏览器 localStorage** 里；
 *  - 不参与任何构建注入（`vite.config.ts` 的 `define` 只注入版本号与 SHA）。
 *
 * 也就是说：key 永远不会进仓库、不会进构建产物，
 * 只会在"玩家自己填了 key 的那台机器"上存在。
 *
 * ## 读取策略：**永不抛错，坏数据一律回落默认**
 *
 * 隐私模式 / 配额不足 / 手工改坏 JSON —— 都只表现为"参谋回到默认（关闭）状态"，
 * 绝不能因为读设置失败而让设置页白屏。
 */

import { DEFAULT_ENDPOINT, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS } from './client'

export const ADVISOR_STORAGE_KEY = 'ancient-tactics.advisor'

/**
 * 历史模型名 → 正式 id 的自愈映射。
 *
 * v1.6.0 把默认模型写成了 `deepseek_flash`（下划线），而 DeepSeek 网关只有
 * `deepseek-flash`（连字符）。非法 id 会被拒，客户端又是"失败一律静默"，
 * 玩家看到的现象就是"开了参谋毫无反应"。
 *
 * 这里做**读取时映射**而不是"只改默认值"：已经存进 localStorage 的旧值
 * 也要能自动纠正，玩家不必手动去高级项里改（老配置零迁移的同一原则）。
 */
const MODEL_ALIASES: Record<string, string> = {
  deepseek_flash: 'deepseek-flash',
}

/**
 * v1.6.0 的默认超时（3 秒）。
 *
 * 这个字段**从未在界面上开放过**，所以存档里出现 3000 只可能是旧默认值 ——
 * 一律跟着新默认走（否则老玩家升级后仍会卡在"3 秒必被掐断"的行为上）。
 * 依据见 `client.ts` 里 `DEFAULT_TIMEOUT_MS` 的注释：实测一次真实请求约 3.4 秒。
 */
const LEGACY_DEFAULT_TIMEOUT_MS = 3_000

/** Key 的最大长度（防手滑粘贴出一整篇文章） */
const MAX_KEY_LENGTH = 512
const MAX_BASE_URL_LENGTH = 256
const MAX_MODEL_LENGTH = 128

export interface AdvisorSettings {
  /** 总开关。默认 **false** —— 不开参谋时行为与改造前逐字一致 */
  enabled: boolean
  /** API Key。默认空串（表示"没配"→ 不发请求） */
  apiKey: string
  /** 接口基址；一般不用改 */
  baseUrl: string
  /** 模型名 */
  model: string
  /** 单次请求超时（毫秒） */
  timeoutMs: number
}

export const DEFAULT_ADVISOR_SETTINGS: AdvisorSettings = {
  enabled: false,
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: DEFAULT_MODEL,
  timeoutMs: DEFAULT_TIMEOUT_MS,
}

function asString(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback
  return value.slice(0, maxLength)
}

/** 逐字段校验并规范化；任何非法字段单独回落默认（不整体丢弃，最大化"能救则救"） */
export function normalizeAdvisorSettings(raw: unknown): AdvisorSettings {
  const base = DEFAULT_ADVISOR_SETTINGS
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...base }
  const obj = raw as Record<string, unknown>

  const timeout = obj.timeoutMs
  const rawModel = asString(obj.model, base.model, MAX_MODEL_LENGTH).trim() || base.model
  return {
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : base.enabled,
    apiKey: asString(obj.apiKey, base.apiKey, MAX_KEY_LENGTH).trim(),
    baseUrl: asString(obj.baseUrl, base.baseUrl, MAX_BASE_URL_LENGTH).trim() || base.baseUrl,
    // 旧版本存下的非法别名在这里自动纠正（见 MODEL_ALIASES）
    model: MODEL_ALIASES[rawModel] ?? rawModel,
    timeoutMs:
      typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 500 && timeout <= 30_000
        ? // 旧默认值跟着新默认走（见 LEGACY_DEFAULT_TIMEOUT_MS）
          Math.floor(timeout) === LEGACY_DEFAULT_TIMEOUT_MS
          ? base.timeoutMs
          : Math.floor(timeout)
        : base.timeoutMs,
  }
}

export function loadAdvisorSettings(): AdvisorSettings {
  try {
    const storage = globalThis.localStorage
    if (!storage) return { ...DEFAULT_ADVISOR_SETTINGS }
    const raw = storage.getItem(ADVISOR_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_ADVISOR_SETTINGS }
    return normalizeAdvisorSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_ADVISOR_SETTINGS }
  }
}

export function saveAdvisorSettings(settings: AdvisorSettings): void {
  try {
    globalThis.localStorage?.setItem(ADVISOR_STORAGE_KEY, JSON.stringify(normalizeAdvisorSettings(settings)))
  } catch {
    /* 隐私模式 / 配额不足：静默失败，只影响"下次还要重填"，不影响当前对局 */
  }
}

export function clearAdvisorSettings(): void {
  try {
    globalThis.localStorage?.removeItem(ADVISOR_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

/** 设置是否"可用"（开关开着 + 配了 key）—— 只有两者都满足才会真正发请求 */
export function isAdvisorUsable(settings: AdvisorSettings): boolean {
  return settings.enabled && settings.apiKey.trim().length > 0
}

export { DEFAULT_ENDPOINT }
