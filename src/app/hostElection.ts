/**
 * 房主选举（纯函数，可单测）
 *
 * 规则：
 *  1. 加入后广播 hello；若 3 秒内无人以 hostHello 应答 → 自己成为房主（"第一个加入者即房主"）。
 *  2. 收到 hostHello → 承认对方（第二个及以后加入者天然是客户端）。
 *  3. 双方几乎同时自任房主（竞态）→ 按 playerId 字典序收敛，较小者胜出。
 *  4. 房主掉线 → 等待 5 秒；仍未回来则由剩余玩家中最早加入者接管。
 *     接管仅在 LOBBY 阶段允许（与 GDD 8.5「游戏内不做主机迁移」一致）。
 */

import type { Phase } from '../net/types'

export const CLAIM_WAIT_MS = 3000
export const HOST_LOST_GRACE_MS = 5000

export interface PeerRecord {
  playerId: string
  nickname: string
  joinedAt: number
  connected: boolean
}

export interface ElectionState {
  selfId: string
  phase: Phase
  joinedAt: number
  hostId: string | null
  selfDeclared: boolean
  /** 第一次发现房主掉线的时刻（用于宽限期计时） */
  hostLostAt: number | null
  records: Record<string, PeerRecord>
}

export type ElectionEffect =
  | { type: 'becameHost'; hostId: string }
  | { type: 'steppedDown'; hostId: string }
  | { type: 'broadcastHostHello'; hostId: string }

export interface ElectionResult {
  state: ElectionState
  effects: ElectionEffect[]
}

export function createElection(
  selfId: string,
  nickname: string,
  joinedAt: number,
  phase: Phase = 'LOBBY',
): ElectionState {
  return {
    selfId,
    phase,
    joinedAt,
    hostId: null,
    selfDeclared: false,
    hostLostAt: null,
    records: { [selfId]: { playerId: selfId, nickname, joinedAt, connected: true } },
  }
}

export function setPhase(state: ElectionState, phase: Phase): ElectionState {
  return { ...state, phase }
}

export function isSelfHost(state: ElectionState): boolean {
  return state.hostId !== null && state.hostId === state.selfId
}

/** 剩余玩家中"最早加入"者（joinedAt 相同时按 playerId 字典序，保证各端算出同一结果） */
export function pickSuccessor(records: Record<string, PeerRecord>): string | null {
  const connected = Object.values(records).filter((r) => r.connected)
  if (connected.length === 0) return null
  connected.sort((a, b) => {
    if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt
    return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0
  })
  return connected[0].playerId
}

export function seen(state: ElectionState, rec: PeerRecord): ElectionResult {
  const records: Record<string, PeerRecord> = { ...state.records, [rec.playerId]: { ...rec, connected: true } }
  let next: ElectionState = { ...state, records }
  if (state.hostId !== null && state.hostId === rec.playerId) next = { ...next, hostLostAt: null }
  return { state: next, effects: [] }
}

export function hostHello(state: ElectionState, hostId: string): ElectionResult {
  if (state.hostId === hostId) return { state, effects: [] }

  // 竞态：我已在先声明且字典序更小 → 我保持房主并重申，让对方降级
  if (state.selfDeclared && state.selfId < hostId) {
    return { state, effects: [{ type: 'broadcastHostHello', hostId: state.selfId }] }
  }

  const effects: ElectionEffect[] = []
  if (state.selfDeclared && hostId !== state.selfId) effects.push({ type: 'steppedDown', hostId })

  return {
    state: { ...state, hostId, selfDeclared: hostId === state.selfId, hostLostAt: null },
    effects,
  }
}

export function gone(state: ElectionState, playerId: string): ElectionResult {
  const rec = state.records[playerId]
  if (!rec) return { state, effects: [] }
  const records: Record<string, PeerRecord> = { ...state.records, [playerId]: { ...rec, connected: false } }
  return { state: { ...state, records }, effects: [] }
}

/** 驱动计时器：由 session 周期性调用 */
export function tick(state: ElectionState, now: number): ElectionResult {
  const effects: ElectionEffect[] = []
  let next = state

  // 记录"第一次发现房主掉线"的时刻 / 房主回来后清除
  if (next.hostId !== null && next.hostId !== next.selfId) {
    const hostRec = next.records[next.hostId]
    if (hostRec && !hostRec.connected) {
      if (next.hostLostAt === null) next = { ...next, hostLostAt: now }
    } else if (next.hostLostAt !== null) {
      next = { ...next, hostLostAt: null }
    }
  }

  // 1) 无人应答 → 自任房主
  if (next.hostId === null && !next.selfDeclared && now - next.joinedAt >= CLAIM_WAIT_MS) {
    next = { ...next, hostId: next.selfId, selfDeclared: true, hostLostAt: null }
    effects.push({ type: 'becameHost', hostId: next.selfId })
    effects.push({ type: 'broadcastHostHello', hostId: next.selfId })
    return { state: next, effects }
  }

  // 2) 房主掉线超过宽限期 → 最早的剩余玩家接管（仅 LOBBY）
  const hostRec = next.hostId ? next.records[next.hostId] : undefined
  if (
    next.hostId !== null &&
    next.hostId !== next.selfId &&
    next.phase === 'LOBBY' &&
    hostRec !== undefined &&
    !hostRec.connected &&
    next.hostLostAt !== null &&
    now - next.hostLostAt >= HOST_LOST_GRACE_MS
  ) {
    if (pickSuccessor(next.records) === next.selfId && !next.selfDeclared) {
      next = { ...next, hostId: next.selfId, selfDeclared: true, hostLostAt: null }
      effects.push({ type: 'becameHost', hostId: next.selfId })
      effects.push({ type: 'broadcastHostHello', hostId: next.selfId })
    }
  }

  return { state: next, effects }
}
