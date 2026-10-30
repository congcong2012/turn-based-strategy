/**
 * 参谋 HUD 文案（`src/ui/advisorText.ts`）的单测。
 *
 * 这一层只做"状态 → 中文"的纯映射，但它决定了玩家能不能看懂
 * "军师这回合到底有没有起作用"。两条最要紧的：
 *  1. 未启用 ⇒ null（**默认路径不渲染任何东西**，界面零变化）；
 *  2. 失败 ⇒ 明确说"未响应 + 原因"，而不是让玩家以为军师在发挥作用。
 */

import { describe, expect, it } from 'vitest'
import { advisorHintOf, advisorTendencyTags, humanizeAdvisorReason } from '../../../src/ui/advisorText'
import { DEFAULT_PLAN } from '../../../src/ai/advisor/plan'
import type { AdvisorPlan } from '../../../src/ai/advisor/plan'

function plan(patch: Partial<AdvisorPlan> = {}): AdvisorPlan {
  return { ...DEFAULT_PLAN, ...patch }
}

describe('advisorHintOf · 默认路径零渲染', () => {
  it('null / undefined → null', () => {
    expect(advisorHintOf(null)).toBeNull()
    expect(advisorHintOf(undefined)).toBeNull()
  })

  it('未启用（result=none）→ null，哪怕 plan 有值', () => {
    expect(advisorHintOf({ used: false, result: 'none', plan: plan() })).toBeNull()
  })
})

describe('advisorHintOf · 拿到计划', () => {
  it('展示模型给的那句话，并带上倾向标签', () => {
    const hint = advisorHintOf({
      used: true,
      result: 'ok',
      plan: plan({ aggression: 'high', focusFire: 'high', risk: 'low', note: '抢占高地，集火长枪' }),
    })
    expect(hint?.tone).toBe('ok')
    expect(hint?.text).toContain('抢占高地，集火长枪')
    expect(hint?.tags).toContain('进攻↑')
    expect(hint?.tags).toContain('集火')
    expect(hint?.tags).toContain('稳健')
  })

  it('没有 note 时给一句中性的说明（不留空白条）', () => {
    const hint = advisorHintOf({ used: true, result: 'ok', plan: plan({ note: '   ' }) })
    expect(hint?.text.length).toBeGreaterThan(0)
    expect(hint?.text).not.toContain('「')
  })

  it('note 过长会被截断（不撑破布局）', () => {
    const long = '甲'.repeat(80)
    const hint = advisorHintOf({ used: true, result: 'ok', plan: plan({ note: long }) })
    expect(hint?.text.length).toBeLessThan(long.length + 10)
    expect(hint?.text).toContain('…')
  })

  it('ok 但没有 plan（理论上不该发生）→ null，而不是渲染空壳', () => {
    expect(advisorHintOf({ used: true, result: 'ok' })).toBeNull()
  })
})

describe('advisorHintOf · 失败要明说', () => {
  it('fallback → warn，文案含人话原因，且不带倾向标签', () => {
    const hint = advisorHintOf({ used: true, result: 'fallback', reason: 'HTTP 400' })
    expect(hint?.tone).toBe('warn')
    expect(hint?.text).toContain('未响应')
    expect(hint?.text).toContain('模型名')
    expect(hint?.tags).toEqual([])
  })

  it('没有原因时也不崩（兜底"未知原因"）', () => {
    const hint = advisorHintOf({ used: true, result: 'fallback' })
    expect(hint?.text).toContain('未知原因')
  })
})

describe('advisorTendencyTags · 只标"真的会改变行为"的维度', () => {
  it('全 medium → 没有任何标签（不产生一排无信息量的"中"）', () => {
    expect(advisorTendencyTags(plan())).toEqual([])
  })

  it('最多 3 个标签', () => {
    const tags = advisorTendencyTags(
      plan({
        aggression: 'high',
        focusFire: 'high',
        defense: 'high',
        risk: 'high',
        economy: 'high',
        counterPick: 'high',
      }),
    )
    expect(tags).toHaveLength(3)
  })

  it('★ deploy 只有 turtle 会出标签（rusher / balanced 在实现里是"不改"）', () => {
    expect(advisorTendencyTags(plan({ deploy: 'turtle' }))).toEqual(['部署偏守'])
    expect(advisorTendencyTags(plan({ deploy: 'rusher' }))).toEqual([])
    expect(advisorTendencyTags(plan({ deploy: 'balanced' }))).toEqual([])
  })

  it('反向取值也有对应标签（low 不是"没意见"）', () => {
    expect(advisorTendencyTags(plan({ aggression: 'low', focusFire: 'low' }))).toEqual(['进攻↓', '分散'])
  })
})

describe('humanizeAdvisorReason · 原始错误 → 人话', () => {
  it('常见 HTTP 状态码各自有指向性文案', () => {
    expect(humanizeAdvisorReason('HTTP 400')).toContain('模型名')
    expect(humanizeAdvisorReason('HTTP 401')).toContain('密钥')
    expect(humanizeAdvisorReason('HTTP 403')).toContain('密钥')
    expect(humanizeAdvisorReason('HTTP 404')).toContain('接口地址')
    expect(humanizeAdvisorReason('HTTP 429')).toContain('额度')
    expect(humanizeAdvisorReason('HTTP 503')).toContain('服务端')
    expect(humanizeAdvisorReason('HTTP 418')).toContain('HTTP 418')
  })

  it('超时 / 断网 / 坏 JSON 都有专门文案', () => {
    expect(humanizeAdvisorReason('The operation was aborted.')).toContain('超时')
    expect(humanizeAdvisorReason('Failed to fetch')).toContain('网络')
    expect(humanizeAdvisorReason('返回内容不是合法的计划 JSON')).toContain('JSON')
  })

  it('空原因 → 未知原因；未知原因原样透出但截断', () => {
    expect(humanizeAdvisorReason(undefined)).toBe('未知原因')
    expect(humanizeAdvisorReason('  ')).toBe('未知原因')
    const long = 'x'.repeat(200)
    expect(humanizeAdvisorReason(long).length).toBeLessThanOrEqual(61)
  })
})
