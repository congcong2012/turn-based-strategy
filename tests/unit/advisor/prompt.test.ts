/**
 * Prompt 文本的专项测试。
 *
 * 守的核心是**"schema 与 prompt 不许走样"**：
 * 改了 `plan.ts` 的字段名却忘记改 prompt，模型就会按旧字段名输出 →
 * 校验器判非法 → 参谋静默失效（而且**不会有任何报错**，最难查的那类 bug）。
 * 因此这里把两条绑定关系都钉死。
 */

import { describe, expect, it } from 'vitest'
import { digest } from '../../../src/ai/advisor/digest'
import { PLAN_FIELDS, planFieldOptions } from '../../../src/ai/advisor/plan'
import { SYSTEM_PROMPT, buildUserPrompt } from '../../../src/ai/advisor/prompt'
import { P1, newGame, startPlaying, testData } from '../game/fixtures'

const data = testData()

describe('System Prompt', () => {
  it('★ 列出了计划的全部字段名（schema 与 prompt 不许走样）', () => {
    for (const field of PLAN_FIELDS) {
      expect(SYSTEM_PROMPT, `system prompt 缺少字段 ${field}`).toContain(field)
    }
  })

  it('★ 每个字段的全部合法取值都出现在 prompt 里（模型才知道可以选什么）', () => {
    const options = planFieldOptions()
    for (const field of PLAN_FIELDS) {
      for (const value of options[field] ?? []) {
        expect(SYSTEM_PROMPT, `字段 ${field} 的取值 ${value} 没写进 prompt`).toContain(`"${value}"`)
      }
    }
  })

  it('明确要求只输出 JSON，且禁止 Markdown 代码块', () => {
    expect(SYSTEM_PROMPT).toContain('只输出一个 JSON 对象')
    expect(SYSTEM_PROMPT).toContain('不要 Markdown 代码块')
  })

  it('明确告知"没把握就给 medium"（安全默认）', () => {
    expect(SYSTEM_PROMPT).toContain('medium')
    expect(SYSTEM_PROMPT).toMatch(/没有把握|信息不足/)
  })

  it('不暗示模型可以直接指挥部队（只提倾向）', () => {
    expect(SYSTEM_PROMPT).toContain('不直接指挥部队')
    expect(SYSTEM_PROMPT).toContain('作战倾向')
  })
})

describe('User Prompt', () => {
  const state = startPlaying(newGame(data), data)
  const d = digest({ state, playerId: P1, data })
  const text = buildUserPrompt(d)

  it('包含关键数字（回合、兵力、军费、据点）', () => {
    expect(text).toContain(`第 ${d.round} 回合`)
    expect(text).toContain(`兵力 ${d.mine.units} 支`)
    expect(text).toContain(`${d.mine.funds}`)
    expect(text).toContain(`${d.mine.barracks} 兵营`)
  })

  it('包含定性结论的中文（而不是原始枚举）', () => {
    expect(text).not.toContain('"ahead"')
    expect(text).not.toContain('"behind"')
    expect(text).toMatch(/领先|落后|均势/)
  })

  it('★ 不泄漏坐标与单位 id（防越权直接指挥）', () => {
    for (const unit of state.units) {
      expect(text).not.toContain(unit.id)
    }
    // 不该出现任何 "x,y" 形式的坐标
    expect(text).not.toMatch(/\b\d+,\s*\d+\b/)
  })

  it('部署与行动阶段的文案不同', () => {
    const deploy = buildUserPrompt(digest({ state: newGame(data), playerId: P1, data }))
    expect(deploy).toContain('部署')
    expect(text).toContain('行动')
  })

  it('王城被占领时给出警示', () => {
    const myHq = state.buildings.find((b) => b.type === 'hq' && b.owner === P1)
    if (!myHq) throw new Error('测试地图应当有 A 的王城')
    const contested = {
      ...state,
      buildings: state.buildings.map((b) =>
        b.id === myHq.id ? { ...b, capture: { playerId: 'B', points: 2, unitId: 'u' } } : b,
      ),
    }
    const warn = buildUserPrompt(digest({ state: contested, playerId: P1, data }))
    expect(warn).toContain('正被敌方占领')
  })

  it('双方王城距离未知时不编造数字', () => {
    const noHq = { ...state, buildings: state.buildings.filter((b) => b.type !== 'hq') }
    const text2 = buildUserPrompt(digest({ state: noHq, playerId: P1, data }))
    expect(text2).toContain('尚未探明')
  })
})
