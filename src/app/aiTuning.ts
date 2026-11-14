/**
 * AI 参数手调（开发者工具）。
 *
 * 目的：让人**自己上手调** AI 的启发式权重，而不用改代码重编译。
 * 只影响**单人练习**（PVE）—— 联机的 AI 补位用服务端房主的机器算，
 * 不该被某个玩家的本地设置改变别人的对局。
 *
 * 三个设计约束：
 *  1. **默认不覆盖**：没存过任何值时，`loadAiTuning()` 返回空对象，
 *     AI 行为与改造前逐字一致（这条在 `mergeTuning` 的注释里也写了）。
 *  2. **只认已知字段 + 数值夹取**：localStorage 是不可信输入（玩家能手改、旧版本可能残留），
 *     非法值一律丢弃而不是让 `AiProfile` 出现 NaN（NaN 会让评分全部变成 NaN，AI 直接瘫）。
 *  3. **覆盖优先级最高**：`tuning` 在"难度档案 → 参谋覆盖 → 手调"里排最后，
 *     因为手调是显式意图；参谋只是给 AI 换个风格。
 */

import type { AiProfile } from '../ai/profile'

export const AI_TUNING_STORAGE_KEY = 'ancient-tactics.ai-tuning'

/** 可调的数值项（键 → 元数据）。没列进来的字段一律不接受覆盖。 */
export interface TuningField {
  key: keyof AiProfile
  label: string
  hint: string
  min: number
  max: number
  step: number
}

/**
 * 只暴露**战术向**的旋钮：搜索层参数（searchDepth / beamWidth / nodeBudget）故意不做，
 * 它们会直接把单步耗时打到几十秒，属于"改代码 + 跑评估台"的事，不是玩着调的。
 */
export const TUNING_FIELDS: readonly TuningField[] = [
  { key: 'focusFire', label: '集火', hint: '越高越执着于补刀残血（困难档默认 0.6）', min: 0, max: 2, step: 0.05 },
  { key: 'cohesion', label: '抱团', hint: '向友军重心靠拢；调高会挤成一团（默认 0）', min: 0, max: 5, step: 0.5 },
  { key: 'economy', label: '经济', hint: '据点的收入价值，越高越爱抢村（默认 3）', min: 0, max: 10, step: 1 },
  { key: 'threat', label: '避险', hint: '预计挨打的惩罚；调高会畏战（默认 0）', min: 0, max: 3, step: 0.1 },
  { key: 'defend', label: '守土', hint: '回防与反占领的权重（默认 6）', min: 0, max: 12, step: 1 },
  { key: 'repair', label: '补给', hint: '残血回据点回血的倾向（默认 8）', min: 0, max: 15, step: 1 },
  { key: 'counter', label: '克制', hint: '出兵时按克制关系挑兵（默认 1）', min: 0, max: 3, step: 0.1 },
  { key: 'lookaheadK', label: '前瞻宽度', hint: '对前几名候选做一步推演；0 = 纯启发式（默认 12）', min: 0, max: 24, step: 1 },
] as const

/** 布尔开关（同样只收已知键） */
export const TUNING_TOGGLES: ReadonlyArray<{ key: keyof AiProfile; label: string; hint: string }> = [
  { key: 'v2', label: 'v2 语义', hint: '关闭后回到 v1 的"没正收益就过手"' },
  { key: 'smartProduce', label: '智能出兵', hint: '按性价比与克制选兵，关闭则越贵越优先' },
  { key: 'scoreAware', label: '比分意识', hint: '临近回合上限时按计分表算账' },
] as const

/** 一份覆盖（只含玩家改过的字段；空对象 = 不覆盖） */
export type AiTuning = Partial<Record<keyof AiProfile, number | boolean>>

function clampNumber(value: number, field: TuningField): number {
  const bounded = Math.min(field.max, Math.max(field.min, value))
  // 按 step 取整，避免出现 0.30000000000000004 这类脏值
  const stepped = Math.round(bounded / field.step) * field.step
  return Math.round(stepped * 1000) / 1000
}

/**
 * 规范化任意输入（localStorage / 导入的 JSON）。
 * 未知键、类型不符、NaN、越界 —— 一律丢弃或夹取，**绝不抛错**。
 */
export function normalizeTuning(raw: unknown): AiTuning {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const obj = raw as Record<string, unknown>
  const out: AiTuning = {}

  for (const field of TUNING_FIELDS) {
    const value = obj[field.key as string]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    out[field.key] = clampNumber(value, field)
  }
  for (const toggle of TUNING_TOGGLES) {
    const value = obj[toggle.key as string]
    if (typeof value === 'boolean') out[toggle.key] = value
  }
  return out
}

/**
 * 把覆盖叠加到档案上。
 *
 * ⚠️ `tuning` 为空时必须**原样返回** `base`（同一个对象）——
 * 这是"没调过 = 行为零变化"的实现依据。
 */
export function mergeTuning(base: AiProfile, tuning: AiTuning | undefined): AiProfile {
  if (!tuning) return base
  const keys = Object.keys(tuning)
  if (keys.length === 0) return base
  const merged: AiProfile = { ...base }
  for (const field of TUNING_FIELDS) {
    const value = tuning[field.key]
    if (typeof value === 'number') (merged[field.key] as number) = value
  }
  for (const toggle of TUNING_TOGGLES) {
    const value = tuning[toggle.key]
    if (typeof value === 'boolean') (merged[toggle.key] as boolean) = value
  }
  return merged
}

/** 带默认值的存储（与其它 store 一样：隐私模式下静默失败，不影响对局） */
export interface TuningStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

function defaultStorage(): TuningStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function loadAiTuning(storage: TuningStorage | null = defaultStorage()): AiTuning {
  if (!storage) return {}
  try {
    const raw = storage.getItem(AI_TUNING_STORAGE_KEY)
    if (!raw) return {}
    return normalizeTuning(JSON.parse(raw))
  } catch {
    return {}
  }
}

export function saveAiTuning(tuning: AiTuning, storage: TuningStorage | null = defaultStorage()): void {
  if (!storage) return
  try {
    const normalized = normalizeTuning(tuning)
    storage.setItem(AI_TUNING_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    /* 配额不足 / 隐私模式：静默失败 */
  }
}

export function clearAiTuning(storage: TuningStorage | null = defaultStorage()): void {
  if (!storage) return
  try {
    storage.removeItem(AI_TUNING_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
