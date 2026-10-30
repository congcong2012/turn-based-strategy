/**
 * 参谋相关的中文展示文案 —— **文案的单一事实源**（设置页与对局内 HUD 共用）。
 *
 * 抽出来的理由与 `difficultyCopy.ts` / `unitText.ts` 一致：
 * 同一句话在两处各写一份，迟早会不一致；而且这些映射值得被单测钉住
 * （哪档该显示什么、失败原因怎么翻译成人话）。
 */

import type { AdvisorStatus } from '../ai/advisor'
import type { AdvisorPlan } from '../ai/advisor/plan'

/** 对局内的一条"军师提示" */
export interface AdvisorHint {
  /** ok = 拿到了计划；warn = 问了但失败（本回合按原策略） */
  tone: 'ok' | 'warn'
  /** 主文案（一句话） */
  text: string
  /** 倾向标签（最多 3 个；warn 时为空） */
  tags: string[]
}

/** note 的最大展示长度（prompt 里要求 ≤20 字，但模型可能超；超了截断而不是撑破布局） */
const MAX_NOTE_LENGTH = 40

/**
 * 把"倾向"翻成短标签。
 *
 * 刻意**只显示会真正改变行为的维度**：
 * - `deploy` 只对 `turtle` 有实际作用（会在部署里补一杆枪），
 *   `rusher` / `balanced` 在实现里是"不改"——那就不该在界面上声称它做了什么。
 * - `medium` 表示"不动"，不产生标签，避免一排无信息量的"中"。
 */
export function advisorTendencyTags(plan: AdvisorPlan): string[] {
  const tags: string[] = []

  if (plan.aggression === 'high') tags.push('进攻↑')
  else if (plan.aggression === 'low') tags.push('进攻↓')

  if (plan.focusFire === 'high') tags.push('集火')
  else if (plan.focusFire === 'low') tags.push('分散')

  if (plan.defense === 'high') tags.push('重防')
  else if (plan.defense === 'low') tags.push('轻防')

  if (plan.risk === 'high') tags.push('冒险')
  else if (plan.risk === 'low') tags.push('稳健')

  if (plan.economy === 'high') tags.push('重经济')
  else if (plan.economy === 'low') tags.push('轻经济')

  if (plan.counterPick === 'high') tags.push('针对出兵')

  // 只有 turtle 真的会改部署（追加一杆长枪）；rusher/balanced 是实现上的"不改"
  if (plan.deploy === 'turtle') tags.push('部署偏守')

  return tags.slice(0, 3)
}

/**
 * 把机器可读的失败原因翻成人话。
 *
 * 输入来自 `AdvisorClient.lastFailure()`（`HTTP 400` / DOMException 的 message / 解析失败），
 * 这些原文对玩家没有意义，但**排查时必须能看懂**，所以保留状态码级别的信息。
 */
export function humanizeAdvisorReason(reason?: string): string {
  if (!reason || reason.trim().length === 0) return '未知原因'
  const raw = reason.trim()

  const http = /^HTTP (\d{3})$/.exec(raw)
  if (http) {
    const code = http[1]
    if (code === '400') return '请求被拒绝（HTTP 400：多半是模型名不对）'
    if (code === '401' || code === '403') return `密钥无效或没有权限（HTTP ${code}）`
    if (code === '404') return '接口地址不对（HTTP 404）'
    if (code === '429') return '请求太频繁或额度不足（HTTP 429）'
    if (code.startsWith('5')) return `服务端出错（HTTP ${code}），稍后再试`
    return `服务端返回 HTTP ${code}`
  }

  if (/abort|timeout|timed out/i.test(raw)) return '请求超时（可把接口地址或网络检查一下）'
  if (/Failed to fetch|NetworkError|Load failed|ERR_/i.test(raw)) return '网络不通（或接口地址写错）'
  if (/JSON/i.test(raw)) return '模型返回的不是合法 JSON'
  if (/content/i.test(raw)) return '响应里没有正文（模型或网关可能不兼容）'

  // 兜底：原样透出，但截断，避免撑破设置页
  return raw.length > 60 ? raw.slice(0, 60) + '…' : raw
}

/**
 * 由参谋状态推导对局内的提示条。
 *
 * - `none`（未启用）→ null：**默认路径完全不渲染**，与没有这个功能时一致。
 * - `ok` → 展示模型给的一句话理由 + 倾向标签。
 * - `fallback` → 展示"未响应 + 原因"，让玩家知道这一回合其实是按原策略打的
 *   （而不是以为军师在发挥作用）。
 */
export function advisorHintOf(status: AdvisorStatus | null | undefined): AdvisorHint | null {
  if (!status || status.result === 'none') return null

  if (status.result === 'fallback') {
    return {
      tone: 'warn',
      text: `军师未响应：${humanizeAdvisorReason(status.reason)}（本回合按原策略）`,
      tags: [],
    }
  }

  const plan = status.plan
  if (!plan) return null

  const note = (plan.note ?? '').trim()
  const text =
    note.length === 0
      ? '本回合按军师倾向调整了参数'
      : `「${note.length > MAX_NOTE_LENGTH ? note.slice(0, MAX_NOTE_LENGTH) + '…' : note}」`

  return { tone: 'ok', text, tags: advisorTendencyTags(plan) }
}
