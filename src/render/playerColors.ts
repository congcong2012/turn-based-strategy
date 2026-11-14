/**
 * 阵营配色（棋盘的棋子/据点、记分牌、战报共用）。
 *
 * 为什么要单独一层：玩家可以在设置里指定"我自己的颜色"，
 * 于是"某个玩家是什么颜色"不再只由座位下标决定 —— 渲染层（Pixi）与 React 层
 * 必须用**同一条规则**，否则会出现"我的兵是紫的、记分牌上我却叫赤色"。
 */

import type { GameState, PlayerId } from '../game/types'
import { teamOf } from '../game/teams'
import { getSettings } from '../app/settings'

/** 默认四色（按座位顺序） */
export const ROLE_COLORS = ['#c65a44', '#4aa89b', '#d2a24b', '#9078c8'] as const

/** 2v2 的队伍配色：同队同色，便于一眼分清敌我 */
export const TEAM_COLORS = ['#c65a44', '#4aa89b'] as const

/**
 * 某个玩家的颜色（十六进制字符串）。
 *
 * 优先级：**2v2 队伍色 > 自定义"我的颜色" > 座位默认色**。
 * 队伍模式下手动配色会让"同队同色"这个视觉约定失效，所以队伍模式下忽略个人偏好。
 */
export function ownerColor(state: GameState, playerId: PlayerId, selfId?: PlayerId | null): string {
  if (state.teams) {
    const team = teamOf(state, playerId)
    if (team !== null) return TEAM_COLORS[team % TEAM_COLORS.length]
  }
  if (selfId && playerId === selfId) {
    const preferred = getSettings().selfColor
    if (preferred) return preferred
  }
  const index = state.players.indexOf(playerId)
  return ROLE_COLORS[(index < 0 ? 0 : index) % ROLE_COLORS.length]
}

/** 同上，但给 Pixi 用的数值形式（0xRRGGBB） */
export function ownerColorNumber(state: GameState, playerId: PlayerId, selfId?: PlayerId | null): number {
  return Number.parseInt(ownerColor(state, playerId, selfId).slice(1), 16)
}
