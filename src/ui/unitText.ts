/**
 * 兵种数值的"人话"标签 —— **规则速查页与对局内的单位详情卡共用这一份**。
 *
 * 抽出来的原因很简单：同一批文案在规则速查里已经写过一遍，对局内的详情卡
 * （悬停 / 长按查看）要显示的是同一个东西 —— 两处各写一份迟早会对不上。
 */

import type { UnitType } from '../game/types'

/** 移动方式的枚举顺序（规则速查的地形表按这个顺序出列） */
export const MOVE_TYPES = ['foot', 'horse', 'siege'] as const

/** 移动方式（数据里是 foot / horse / siege） */
export const MOVE_TYPE_LABEL: Record<string, string> = { foot: '步行', horse: '骑乘', siege: '器械' }

/** 攻击方式：间接单位（投石车）移动后不能攻击、被贴身也无法反击 */
export function attackKindLabel(attack: UnitType['attack']): string {
  return attack === 'direct' ? '直射' : '间接'
}

/** 射程：min === max 时只写一个数（"射程 1" 比 "射程 1–1" 干净） */
export function rangeLabel(unit: UnitType): string {
  return unit.rangeMin === unit.rangeMax ? String(unit.rangeMin) : unit.rangeMin + '–' + unit.rangeMax
}
