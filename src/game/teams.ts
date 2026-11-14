/**
 * 队伍（2v2）的最小模型。
 *
 * 设计原则：**混战与单人练习必须逐字不变**。
 * 所以队伍用 `GameState.teams?: number[]`（与 `players` 下标对齐）表示，
 * 缺省即可 —— 此时 `areAllies()` 退化成"只有自己人算自己人"，
 * 与原来的 `owner === playerId` 完全等价。
 *
 * 为什么不是"给每个玩家加一个 team 字段"：`GameState.players` 是 `PlayerId[]`，
 * 到处按下标取值（出生角、初始据点归属都靠它）。再加一张按下标对齐的数组，
 * 序列化简单、旧存档天然兼容（字段不存在 = 混战）。
 */

import type { GameState, PlayerId } from './types'

/** 某个玩家的队伍编号；混战 / 单人局（`teams` 未定义）返回 null */
export function teamOf(state: GameState, playerId: PlayerId): number | null {
  if (!state.teams) return null
  const index = state.players.indexOf(playerId)
  if (index < 0) return null
  return state.teams[index] ?? null
}

/**
 * 是否友军。
 *
 * - 混战：只有 `a === b` 为真（与旧逻辑 `owner === playerId` 等价）；
 * - 2v2：同队即为友军 —— 攻击、占领、AI 评估都靠它把队友排除在"敌方"之外。
 */
export function areAllies(state: GameState, a: PlayerId, b: PlayerId): boolean {
  if (a === b) return true
  const ta = teamOf(state, a)
  if (ta === null) return false
  return ta === teamOf(state, b)
}

/** 某队的全部成员（按 players 顺序） */
export function teamMembers(state: GameState, team: number): PlayerId[] {
  if (!state.teams) return []
  return state.players.filter((_, i) => state.teams?.[i] === team)
}

/**
 * 是不是"我方"（含自己）。
 *
 * 混战时等价于 `owner === playerId` —— 这两个断言的等价性，是"2v2 不改变混战行为"
 * 的全部依据，AI 的评估函数因此可以整片替换而不动调参。
 */
export function isAllyOwner(state: GameState, playerId: PlayerId, owner: PlayerId | null): boolean {
  return owner !== null && areAllies(state, playerId, owner)
}

/**
 * 是不是"非我方"（敌方**或中立**）。
 *
 * ⚠️ 中立（null）算"非我方"，这是为了保持原有语义：
 * 旧代码里 `owner !== playerId` 对无主据点同样为真，改写成 `!areAllies` 会悄悄改掉它。
 */
export function isNonAllyOwner(state: GameState, playerId: PlayerId, owner: PlayerId | null): boolean {
  if (owner === null) return true
  return !areAllies(state, playerId, owner)
}

/**
 * 仍然"活着"的队伍：只要队里还有一个人没被淘汰，这队就还在场上。
 * 混战返回空数组（调用方应回退到 `survivors()`）。
 */
export function aliveTeams(state: GameState): number[] {
  if (!state.teams) return []
  const out = new Set<number>()
  for (const player of state.players) {
    if (state.eliminated.includes(player)) continue
    const team = teamOf(state, player)
    if (team !== null) out.add(team)
  }
  return [...out].sort((a, b) => a - b)
}

/** 队伍显示名（结算、日志、记分牌共用，避免三处各写一份） */
const TEAM_NAMES = ['甲队', '乙队', '丙队', '丁队']

export function teamLabel(team: number): string {
  return TEAM_NAMES[team] ?? `第 ${team + 1} 队`
}

/**
 * 按座位排队伍：**对角同队**（0&3 一队，1&2 一队）。
 *
 * 为什么是对角而不是相邻：本作地图的出生角是四个角落，
 * 对角同队意味着两名队友分处地图两端，不会一开局就挤在一起，
 * 也让"夹击中路"成为天然战术。相邻同队则会立刻出现"两人抢同一片野区"。
 */
export function diagonalTeams(playerCount: number): number[] {
  // 只对 4 席成立：2 席会算出 [0,0]（两人同队 ⇒ 没有对手），3 席则永远 2:1 不公平
  if (playerCount !== 4) return []
  return [0, 1, 1, 0]
}
