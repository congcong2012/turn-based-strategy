/**
 * LLM 参谋的 Prompt —— **文案的单一事实源**。
 *
 * 单独成文件（而不是塞进 `client.ts`）的理由：
 *  - 单测可以直接断言"system prompt 里列出了计划的所有字段名"，
 *    这样**改了 schema 却忘记改 prompt** 这种错配会在测试里立刻暴露；
 *  - 字段名与取值范围从 `./plan` 派生，不手抄第二份。
 *
 * 设计要点：
 *  - **只输出 JSON**（明确禁止 Markdown 代码块与解释），降低解析失败率；
 *  - 明确告知"没把握就给 medium"，让模型在信息不足时**倾向于不改变**（最安全的默认）；
 *  - 不给任何"你可以直接指挥部队"的暗示 —— 只提"作战倾向"。
 */

import { BALANCE_TEXT } from './digest'
import type { AdvisorDigest } from './digest'
import { PLAN_FIELDS, planFieldOptions } from './plan'

/** 把字段取值表渲染成 prompt 里的一段文字（从 plan 层派生，不手抄） */
function fieldSpec(): string {
  const options = planFieldOptions()
  return PLAN_FIELDS.map((field) => {
    const values = options[field] ?? []
    return `- ${field}: ${values.map((v) => `"${v}"`).join(' | ')}`
  }).join('\n')
}

/**
 * System prompt。
 *
 * ⚠️ 与 `plan.ts` 的字段名强绑定 —— `prompt.test.ts` 有一条断言守着这条，
 * 改 schema 时这里会红，逼着两处一起改。
 */
export const SYSTEM_PROMPT = [
  '你是一款古代战棋游戏的"军师参谋"。你**不直接指挥部队**，只给主将提供一份"作战倾向"，',
  '由主将既有的推演系统去执行具体走位与出兵。',
  '',
  '请**只输出一个 JSON 对象**，不要任何解释文字，不要 Markdown 代码块，不要注释。',
  '',
  '字段与取值范围（每个字段只能取列出的值）：',
  fieldSpec(),
  '- note: （可选）不超过 20 字的中文理由，仅展示给玩家，不影响决策',
  '',
  '规则：',
  '1. 信息不足或没有把握时，**一律给 "medium"** —— 它表示"不做任何调整"，是最安全的选择。',
  '2. 只能使用上面列出的字段名与取值，不要自创字段。',
  '3. 只输出 JSON。',
].join('\n')

/** 定性结论 → 中文（供摘要文本使用） */
function balanceText(value: AdvisorDigest['balance']): string {
  return BALANCE_TEXT[value]
}

/**
 * User prompt：把摘要摊成**紧凑的中文文本**。
 *
 * 刻意不塞原始 state —— 摘要只含聚合数字与短枚举，
 * 因此这里既省 token，也不会泄漏坐标/单位 id（防越权）。
 */
export function buildUserPrompt(d: AdvisorDigest): string {
  const phase = d.phase === 'deploy' ? '部署（开局摆兵）' : '行动'
  const hq = d.hqSafe ? '安全' : '⚠️ 正被敌方占领'
  const distance =
    d.foeDistanceToMyHq >= 0 && d.myDistanceToFoeHq >= 0
      ? `敌主力距我王城约 ${d.foeDistanceToMyHq} 格；我主力距敌王城约 ${d.myDistanceToFoeHq} 格`
      : '尚未探明双方王城距离'

  return [
    `【回合】第 ${d.round} 回合，距回合上限还有 ${d.roundsLeft} 回合`,
    `【阶段】${phase}`,
    `【我方】兵力 ${d.mine.units} 支，兵力值 ${Math.round(d.mine.power)}，军费 ${d.mine.funds}`,
    `　　　　据点 ${d.mine.villages} 村 / ${d.mine.barracks} 兵营 / ${d.mine.hq} 王城`,
    `【敌方】兵力 ${d.foes.units} 支，兵力值 ${Math.round(d.foes.power)}`,
    `　　　　据点 ${d.foes.villages} 村 / ${d.foes.barracks} 兵营 / ${d.foes.hq} 王城`,
    `【兵力对比】${balanceText(d.balance)}（我方 ${Math.round(d.mine.power)} vs 敌方 ${Math.round(d.foes.power)}）`,
    `【威胁】我方王城${hq}；有 ${d.exposedUnits} 支我方单位处于险境（可能被一击打掉）`,
    `【敌情】${distance}`,
    `【比分】${balanceText(d.scoreLead)}（按终局计分口径粗估）`,
    '',
    '请给出你这一回合的作战倾向。',
  ].join('\n')
}
