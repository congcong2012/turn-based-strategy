/**
 * LLM 参谋的"作战计划"：校验器与映射器。
 *
 * 重点守四件事：
 *  1. **校验策略**：缺字段 → 默认；字段存在但非法 → 整份丢弃（返回 null）。
 *  2. **`medium` = 不动**：全部 medium 的计划叠加后，档案必须与原来**逐字段相同**。
 *  3. **绝不覆盖结构字段** —— 这条是"机制完全不变"承诺的技术保证，逐字段守。
 *  4. **夹取生效**：LLM 给出极端倾向时，权重被夹在合理区间内，不会压过材料分。
 */

import { describe, expect, it } from 'vitest'
import { PROFILES, profileFor } from '../../../src/ai/profile'
import type { AiProfile, Difficulty } from '../../../src/ai/profile'
import {
  DEFAULT_PLAN,
  FACTOR,
  NOTE_MAX_LENGTH,
  PLAN_FIELDS,
  applyPlan,
  isOverridableWeight,
  parsePlan,
  planToProfile,
} from '../../../src/ai/advisor/plan'
import type { AdvisorPlan } from '../../../src/ai/advisor/plan'

/** 造一个"全部给满"的计划（各维度都偏离 medium），便于测缩放 */
const planWith = (patch: Partial<AdvisorPlan>): AdvisorPlan => ({ ...DEFAULT_PLAN, ...patch })

/** 决定搜索机制与预算的字段 —— 参谋**绝不能**碰它们 */
const STRUCTURAL_FIELDS: Array<keyof AiProfile> = [
  'noisy',
  'lookaheadK',
  'v2',
  'smartProduce',
  'scoreAware',
  'pendingMaterial',
  'rangedSafety',
  'searchDepth',
  'beamWidth',
  'innerBeamWidth',
  'expansionBudget',
  'nodeBudget',
  'rolloutMySteps',
  'rolloutFoeSteps',
  'rolloutFoeLookahead',
  'rolloutBudget',
]

describe('计划校验器 parsePlan', () => {
  it('合法全字段 → 原样返回', () => {
    const raw = {
      aggression: 'high',
      economy: 'low',
      defense: 'medium',
      focusFire: 'high',
      counterPick: 'low',
      risk: 'high',
      deploy: 'turtle',
      note: '直取王城',
    }
    expect(parsePlan(raw)).toEqual(raw)
  })

  it('空对象 → 全部默认（LLM 一个字段都没给也能用）', () => {
    expect(parsePlan({})).toEqual(DEFAULT_PLAN)
  })

  it('缺字段 → 该字段取默认，其余照用', () => {
    const parsed = parsePlan({ aggression: 'high' })
    expect(parsed?.aggression).toBe('high')
    expect(parsed?.economy).toBe('medium')
    expect(parsed?.deploy).toBe('balanced')
  })

  it('字段存在但取值非法 → 整份丢弃（不猜、不夹取）', () => {
    expect(parsePlan({ aggression: 'huge' })).toBeNull()
    expect(parsePlan({ deploy: 'aggressive' })).toBeNull()
  })

  it('字段存在但类型不对 → 整份丢弃', () => {
    expect(parsePlan({ aggression: 3 })).toBeNull()
    expect(parsePlan({ deploy: true })).toBeNull()
    expect(parsePlan({ economy: null })).toBeNull()
  })

  it('非对象输入 → null（数组、字符串、null、数字都不行）', () => {
    expect(parsePlan(null)).toBeNull()
    expect(parsePlan(undefined)).toBeNull()
    expect(parsePlan('{}')).toBeNull()
    expect(parsePlan(42)).toBeNull()
    expect(parsePlan([])).toBeNull()
  })

  it('note 超长被截断（而不是因此丢掉整份计划）', () => {
    const long = 'x'.repeat(NOTE_MAX_LENGTH + 50)
    const parsed = parsePlan({ note: long })
    expect(parsed?.note).toHaveLength(NOTE_MAX_LENGTH)
  })

  it('note 非字符串 → 整份丢弃', () => {
    expect(parsePlan({ note: 123 })).toBeNull()
  })

  it('note 为空串 → 视作没给（不产生空字符串字段）', () => {
    expect(parsePlan({ note: '' })).toEqual(DEFAULT_PLAN)
  })
})

describe('计划映射器 applyPlan', () => {
  it('★ 全部 medium → 档案与原来逐字段相同（"LLM 没意见" = "没开参谋"）', () => {
    for (const difficulty of Object.keys(PROFILES) as Difficulty[]) {
      const base = profileFor(difficulty)
      expect(applyPlan(base, DEFAULT_PLAN)).toEqual(base)
    }
  })

  it('★ 绝不覆盖结构字段（逐字段守"机制完全不变"）', () => {
    const base = profileFor('oracle')
    // 每种倾向都给"极端值"，确保所有可覆盖项都被推到边界
    const extreme = planWith({
      aggression: 'high',
      economy: 'high',
      defense: 'high',
      focusFire: 'high',
      counterPick: 'high',
      risk: 'low',
      deploy: 'turtle',
    })
    const next = applyPlan(base, extreme)
    for (const field of STRUCTURAL_FIELDS) {
      expect(next[field], `字段 ${field} 不该被参谋改动`).toEqual(base[field])
    }
  })

  it('★ 结构字段之外只动"已登记的权重"（没有别的字段被顺手改掉）', () => {
    const base = profileFor('hard')
    const next = applyPlan(base, planWith({ aggression: 'high' }))
    for (const key of Object.keys(base) as Array<keyof AiProfile>) {
      if (STRUCTURAL_FIELDS.includes(key)) continue
      if (key === 'deployPlan') continue
      if (isOverridableWeight(key)) continue
      expect(next[key], `字段 ${key} 不在可覆盖清单里，却被改了`).toEqual(base[key])
    }
  })

  it('high 提高、low 降低（以 focusFire 为例）', () => {
    const base = profileFor('hard')
    const high = applyPlan(base, planWith({ aggression: 'high', focusFire: 'high' }))
    const low = applyPlan(base, planWith({ aggression: 'low', focusFire: 'low' }))
    expect(high.focusFire).toBeGreaterThan(base.focusFire)
    expect(low.focusFire).toBeLessThan(base.focusFire)
    // 两个旋钮相乘：base × 1.3 × 1.3
    expect(high.focusFire).toBeCloseTo(base.focusFire * FACTOR.high * FACTOR.high, 6)
  })

  it('★ 原档为 0 的项永远保持 0（不给 easy/normal 凭空开启 v2 开关）', () => {
    const base = profileFor('normal')
    expect(base.economy).toBe(0)
    expect(base.defend).toBe(0)
    const next = applyPlan(base, planWith({ economy: 'high', defense: 'high', counterPick: 'high' }))
    expect(next.economy).toBe(0)
    expect(next.defend).toBe(0)
    expect(next.counter).toBe(0)
  })

  it('★ 夹取生效：极端倾向不会把权重推到危险区间', () => {
    const base = profileFor('hard')
    // 反复叠加同一方向的极端倾向，模拟"LLM 一直喊高"
    let next = base
    for (let i = 0; i < 10; i += 1) {
      next = applyPlan(next, planWith({ aggression: 'high', focusFire: 'high' }))
    }
    expect(next.focusFire).toBeLessThanOrEqual(2)
  })

  it('risk 是反向旋钮：保守（low）把威胁/暴露/回血权重调高', () => {
    const base = profileFor('hard')
    const cautious = applyPlan(base, planWith({ risk: 'low' }))
    const reckless = applyPlan(base, planWith({ risk: 'high' }))
    expect(cautious.defend).toBe(base.defend) // risk 不动 defend
    expect(cautious.repair).toBeGreaterThan(base.repair)
    expect(reckless.repair).toBeLessThan(base.repair)
  })

  it('turtle 部署追加一个枪兵（防御型）；且不超过 deployMaxUnits', () => {
    const base = profileFor('hard')
    const turtle = applyPlan(base, planWith({ deploy: 'turtle' }))
    expect(turtle.deployPlan.length).toBe(Math.min(base.deployPlan.length + 1, 4))
    expect(turtle.deployPlan.at(-1)).toBe('spear')
  })

  it('rusher / balanced 不改部署计划', () => {
    const base = profileFor('hard')
    expect(applyPlan(base, planWith({ deploy: 'rusher' })).deployPlan).toEqual(base.deployPlan)
    expect(applyPlan(base, planWith({ deploy: 'balanced' })).deployPlan).toEqual(base.deployPlan)
  })

  it('不修改入参（纯函数）', () => {
    const base = profileFor('hard')
    const snapshot = JSON.stringify(base)
    applyPlan(base, planWith({ aggression: 'high', deploy: 'turtle' }))
    expect(JSON.stringify(base)).toBe(snapshot)
  })
})

describe('planToProfile', () => {
  it('基于难度档案，且不污染 PROFILES 策略表', () => {
    const before = JSON.stringify(PROFILES.hard)
    const profile = planToProfile(planWith({ aggression: 'high' }), 'hard')
    expect(profile.focusFire).toBeGreaterThan(PROFILES.hard.focusFire)
    expect(JSON.stringify(PROFILES.hard)).toBe(before)
  })

  it('六档都能映射（不会因某档缺字段而抛错）', () => {
    for (const difficulty of Object.keys(PROFILES) as Difficulty[]) {
      expect(() => planToProfile(DEFAULT_PLAN, difficulty)).not.toThrow()
    }
  })
})

describe('导出的常量与元数据', () => {
  it('PLAN_FIELDS 覆盖全部计划字段（prompt 与校验共用的单一事实源）', () => {
    const expected = Object.keys(DEFAULT_PLAN).filter((k) => k !== 'note')
    for (const field of expected) expect(PLAN_FIELDS).toContain(field)
  })

  it('isOverridableWeight：权重为真、结构字段为假', () => {
    expect(isOverridableWeight('focusFire')).toBe(true)
    expect(isOverridableWeight('economy')).toBe(true)
    expect(isOverridableWeight('searchDepth')).toBe(false)
    expect(isOverridableWeight('nodeBudget')).toBe(false)
    expect(isOverridableWeight('rolloutBudget')).toBe(false)
  })
})
