/**
 * LLM 参谋的"作战计划"：类型 + 校验器 + 映射器。
 *
 * ## 这个模块在整个 LLM 参谋里的位置
 *
 * 大模型**不直接指挥部队**（不给"打谁/走哪/造什么兵"），只输出一份**倾向**。
 * 本模块负责把那份倾向翻译成 AI 内核能吃的 `AiProfile` **覆盖层**，
 * 然后交给**完全不变**的搜索内核（`nextCommandWith`）。
 *
 *     LLM 输出 JSON ──parsePlan──> AdvisorPlan ──planToProfile──> AiProfile 覆盖层
 *
 * ## 三条不可动摇的设计约束
 *
 * 1. **全枚举、无自由文本**：LLM 无法越权指定具体指令 —— 它只能调"倾向旋钮"，
 *    决策权始终在搜索内核手里。`note` 字段是唯一的字符串，且**绝不参与决策**。
 * 2. **`medium` = 不动**：三档里的"中等"映射为**保持原档数值不变**，
 *    因此"LLM 说没意见"与"没开参谋"逐字一致。
 * 3. **绝不覆盖结构字段**：`searchDepth` / `beamWidth` / `nodeBudget` /
 *    `expansionBudget` / `rollout*` 等决定**搜索预算与机制**的字段一律不碰 ——
 *    覆盖它们会破坏"机制完全不变"这条承诺（预算与深度不匹配会爆炸或退化）。
 *
 * ## 校验策略：宽松解析 + 严格拒绝
 *
 * - **缺字段 → 用默认值**（LLM 少给一个字段，仍能用）；
 * - **字段存在但类型/取值错 → 整份丢弃**（LLM 胡说八道，直接回退原档）。
 *
 * 调用方拿到 `null` 就应当走"静默回退原难度"那条路，牌局不受任何影响。
 */

import { profileFor } from '../profile'
import type { AiProfile, Difficulty } from '../profile'

/** 三档倾向。`medium` = 不改变该维度（保持原档数值） */
export type Level = 'low' | 'medium' | 'high'

/** 部署风格 */
export type DeployStyle = 'balanced' | 'rusher' | 'turtle'

export interface AdvisorPlan {
  /** 进攻主动程度：越低越保守推进 */
  aggression: Level
  /** 对据点收入（经济）的重视 */
  economy: Level
  /** 对防守己方据点的重视 */
  defense: Level
  /** 集火补刀的倾向 */
  focusFire: Level
  /** 兵种克制意识（按 matchup 选兵/出兵） */
  counterPick: Level
  /** 冒险程度：high = 更愿以暴露换节奏 */
  risk: Level
  /** 部署风格 */
  deploy: DeployStyle
  /**
   * 一句话理由（**仅供 HUD 展示，绝不进入决策**）。超长会被截断。
   */
  note?: string
}

/** 缺字段时的默认取值：全部"不改变" —— 即"LLM 没意见" = 与原来一致 */
export const DEFAULT_PLAN: AdvisorPlan = {
  aggression: 'medium',
  economy: 'medium',
  defense: 'medium',
  focusFire: 'medium',
  counterPick: 'medium',
  risk: 'medium',
  deploy: 'balanced',
}

/**
 * 三档 → 缩放系数。`medium` 恒为 1（不动）。
 *
 * 这是**数值的单一事实源**：prompt 的取值范围描述、校验器的合法值表、
 * 映射器的缩放全部从这里派生，避免三处各写一份而走样。
 */
export const FACTOR: Record<Level, number> = { low: 0.7, medium: 1, high: 1.3 }

/** 各字段的合法取值（校验器用；同时是"有哪些字段"的单一事实源） */
const LEVEL_FIELDS = ['aggression', 'economy', 'defense', 'focusFire', 'counterPick', 'risk'] as const
type LevelField = (typeof LEVEL_FIELDS)[number]
const LEVELS: readonly Level[] = ['low', 'medium', 'high']
const DEPLOY_STYLES: readonly DeployStyle[] = ['balanced', 'rusher', 'turtle']

/** `note` 的截断长度 */
export const NOTE_MAX_LENGTH = 40

/**
 * 每个**可被覆盖**字段的硬上下界：超界就夹取（而不是丢弃整份计划）。
 *
 * 下界一律 0：这些权重都是"越大越在意"，负数会让评分反向，没有意义。
 * 上界取原档最大值的约 2–4 倍，防止 LLM 给出极端值把评估项压过材料分
 * ——（切片 1 的教训：乘性大权重会压过材料项，实测 0/16 胜）。
 */
const BOUNDS: Record<string, [number, number]> = {
  focusFire: [0, 2],
  economy: [0, 12],
  defend: [0, 24],
  counter: [0, 4],
  counterValue: [0, 8],
  threat: [0, 12],
  exposure: [0, 2],
  repair: [0, 16],
}

function clamp(value: number, [lo, hi]: [number, number]): number {
  return Math.min(hi, Math.max(lo, value))
}

/**
 * 缩放一个权重：**原值为 0 时恒保持 0**。
 *
 * 为什么必须这样：`easy` / `normal` 两档的 v2/v3 开关**全部为 0**（刻意与"加 v2 之前"
 * 逐字一致）。若不特判，`0 × 1.3` 仍是 0（无害），但语义上容易让人以为"高倾向 = 开发了新能力"。
 * 显式写出来是为了让这条约束在代码里可见：**参谋不能凭空给弱档开启它没有的评估项**。
 */
function scale(value: number, factor: number): number {
  return value === 0 ? 0 : value * factor
}

/** 覆盖一个字段（带夹取）；未在 BOUNDS 里登记的字段不会被覆盖 */
function setWeight(profile: AiProfile, key: keyof AiProfile & string, value: number): void {
  const bounds = BOUNDS[key]
  if (!bounds) return
  // 这些字段在 AiProfile 里都是 number；用 unknown 中转以满足 TS 的键索引检查
  ;(profile as unknown as Record<string, number>)[key] = clamp(value, bounds)
}

/**
 * 把计划**叠加**到一份档案上，返回新档案（不修改入参）。
 *
 * 多档倾向作用于同一字段时取**系数相乘**（例如 aggression 与 focusFire 都影响
 * `focusFire` 字段），最后整体夹取一次。
 */
export function applyPlan(base: AiProfile, plan: AdvisorPlan): AiProfile {
  const next: AiProfile = { ...base, deployPlan: [...base.deployPlan] }

  // 集火：两个旋钮都指向 `focusFire`，取乘积
  setWeight(next, 'focusFire', scale(base.focusFire, FACTOR[plan.aggression] * FACTOR[plan.focusFire]))
  setWeight(next, 'economy', scale(base.economy, FACTOR[plan.economy]))
  setWeight(next, 'defend', scale(base.defend, FACTOR[plan.defense]))
  setWeight(next, 'counter', scale(base.counter, FACTOR[plan.counterPick]))
  setWeight(next, 'counterValue', scale(base.counterValue, FACTOR[plan.counterPick]))

  // 风险：**反向** —— 越保守（low）越在意威胁/暴露/回血，系数越大
  const riskFactor = 2 - FACTOR[plan.risk] // low(0.7) → 1.3；medium → 1；high(1.3) → 0.7
  setWeight(next, 'threat', scale(base.threat, riskFactor))
  setWeight(next, 'exposure', scale(base.exposure, riskFactor))
  setWeight(next, 'repair', scale(base.repair, riskFactor))

  // 部署：turtle 追加一个防御型单位（枪兵克制骑兵冲锋）；
  // rusher / balanced 不改（既有 deployPlan 本就偏进攻，语义已近似）
  if (plan.deploy === 'turtle' && next.deployPlan.length > 0 && next.deployPlan.length < 4) {
    next.deployPlan.push('spear')
  }

  return next
}

/**
 * 计划 → 该难度下的完整档案。
 *
 * 用 `profileFor`（**返回副本**）作为基底，因此绝不会污染 `PROFILES` 策略表 ——
 * 这一点很重要：参谋只影响这一局的这一个 AI，不能把改动泄漏给其它对局或单测。
 */
export function planToProfile(plan: AdvisorPlan, difficulty: Difficulty): AiProfile {
  return applyPlan(profileFor(difficulty), plan)
}

/**
 * 校验并规范化 LLM 的原始输出。**不可信输入**，因此逐字段检查。
 *
 * 返回 `null` 表示"这份计划不能要"（调用方应当静默回退原档）。
 */
export function parsePlan(raw: unknown): AdvisorPlan | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>

  const out: AdvisorPlan = { ...DEFAULT_PLAN }

  for (const key of LEVEL_FIELDS) {
    const value = obj[key]
    if (value === undefined) continue // 缺 → 默认
    if (typeof value !== 'string' || !LEVELS.includes(value as Level)) return null
    out[key] = value as Level
  }

  if (obj.deploy !== undefined) {
    const value = obj.deploy
    if (typeof value !== 'string' || !DEPLOY_STYLES.includes(value as DeployStyle)) return null
    out.deploy = value as DeployStyle
  }

  if (obj.note !== undefined) {
    if (typeof obj.note !== 'string') return null
    // 截断而不是拒绝：理由只是展示用，不值得为长度丢掉整份计划
    if (obj.note.length > 0) out.note = obj.note.slice(0, NOTE_MAX_LENGTH)
  }

  return out
}

/** 可被计划的字段名（供 prompt 与测试共用，防止两边走样） */
export const PLAN_FIELDS: readonly string[] = [...LEVEL_FIELDS, 'deploy']

/** 各字段的合法取值（prompt 生成与校验共用） */
export function planFieldOptions(): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {}
  for (const key of LEVEL_FIELDS) out[key] = LEVELS
  out.deploy = DEPLOY_STYLES
  return out
}

/** 某字段是否属于"可被覆盖"的权重（映射器守门用；结构字段一律为 false） */
export function isOverridableWeight(key: string): boolean {
  return key in BOUNDS
}

export type { LevelField }
