/** 战斗：确定性伤害公式与反击（GDD 7） */

import { DATA } from './data'
import type { GameData } from './data'
import { defenseOf } from './board'
import type { GameState, Unit } from './types'
import { chebyshevDistance } from './movement'

/** 对满血目标的基础伤害（来自 matchup.json） */
export function baseDamage(attackerType: string, defenderType: string, data: GameData = DATA): number {
  return data.matchup[attackerType]?.[defenderType] ?? 0
}

/**
 * 伤害 = max(minDamage, floor(基础攻击 × 攻方当前HP/攻方HP上限 × (1 − 守方地形减伤)))
 * 完全确定性，无随机数。
 */
export function computeDamage(state: GameState, attacker: Unit, defender: Unit, data: GameData = DATA): number {
  const atkType = data.units[attacker.type]
  const base = baseDamage(attacker.type, defender.type, data)
  const ratio = Math.max(0, attacker.hp) / atkType.hp
  const defense = defenseOf(state, defender.x, defender.y, data)
  return Math.max(data.rules.minDamage, Math.floor(base * ratio * (1 - defense)))
}

/** 反击条件：守方存活、射程覆盖、且该兵种可反击（投石车不可） */
export function canCounter(attacker: Unit, defender: Unit, data: GameData = DATA): boolean {
  const defType = data.units[defender.type]
  if (!defType.counter) return false
  const d = chebyshevDistance(attacker, defender)
  return d >= defType.rangeMin && d <= defType.rangeMax
}
