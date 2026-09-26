/** 连接状态推导（纯函数，便于单测；房主权威之外唯一需要"猜"的地方） */

import type { TransportStatus } from './types'

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'waiting' | 'reconnecting' | 'failed'

/** 用户可见文案（UI 与诊断面板共用一份） */
export const CONNECTION_LABELS: Record<ConnectionState, string> = {
  idle: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  waiting: '等待对手加入',
  reconnecting: '重连中…',
  failed: '连接失败',
}

export function connectionLabel(state: ConnectionState): string {
  return CONNECTION_LABELS[state] ?? state
}

export interface ConnectionInput {
  /** 会话角色：未进房为 idle */
  role: 'idle' | 'joining' | 'host' | 'client'
  /** 传输层上报的原始状态 */
  status: TransportStatus
  /** 传输层给的说明（失败原因） */
  detail?: string | null
  /** 当前 peer 数 */
  peerCount: number
  /** 名单里在线的玩家数（含自己） */
  expectedPlayers: number
  /** 是否已经进入对局 */
  inGame: boolean
}

/**
 * 判定顺序（从确定到不确定）：
 *  1. 未进房 → idle
 *  2. 传输层明确失败 → failed
 *  3. 还在连接 / 刚加入 → connecting
 *  4. 有 peer → connected
 *  5. 传输层说在重连 → reconnecting
 *  6. 没有 peer，但对局进行中或名单里还有别人 → reconnecting（等对手回来）
 *  7. 其它 → waiting（信令已连上，等人进房）
 */
export function deriveConnectionState(input: ConnectionInput): ConnectionState {
  const { role, status, peerCount, expectedPlayers, inGame } = input
  if (role === 'idle') return 'idle'
  if (status === 'failed') return 'failed'
  if (status === 'connecting' || role === 'joining') return 'connecting'
  if (peerCount > 0) return 'connected'
  if (status === 'reconnecting') return 'reconnecting'
  if (inGame || expectedPlayers > 1) return 'reconnecting'
  return 'waiting'
}

/** 给用户看的下一步建议（失败时才有意义） */
export function recoveryHint(state: ConnectionState, strategy: string): string | null {
  if (state === 'connected' || state === 'waiting' || state === 'idle') return null
  if (state === 'connecting') return null
  if (state === 'reconnecting') return '正在尝试重连；若一直连不上，可用「手动直连」面对面交换连接码。'
  return strategy === 'mqtt'
    ? '公共信令连不上：可以试试切换 Torrent 信令，或改用手动直连（通过微信互发连接码）。'
    : '信令连不上：可以切换回 MQTT，或改用手动直连（通过微信互发连接码）。'
}
