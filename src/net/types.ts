/** 传输层与联机协议的类型定义（M1 大厅 + M2 对局指令） */

import type { Command, ErrorCode, GameEvent, GameState } from '../game/types'

export type PeerId = string
export type PlayerId = string

/** 信令策略：mqtt（实测可达）与 torrent（备用降级） */
export type SignalStrategy = 'mqtt' | 'torrent'
/** 传输实现：trystero（真实 P2P）或 local（同机 BroadcastChannel，仅 DEV 调试） */
export type TransportKind = 'trystero' | 'local' | 'manual'

export type Phase = 'LOBBY' | 'DEPLOY' | 'PLAYING' | 'PAUSED' | 'GAME_OVER'
/** 连接状态：连接中 / 已连接 / 重连中 / 失败（M7 补齐"重连中"） */
export type TransportStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed'
export type RoomRole = 'idle' | 'joining' | 'host' | 'client'

export type LobbyPlayer = {
  playerId: PlayerId
  nickname: string
  ready: boolean
  isHost: boolean
  connected: boolean
}

/** 房主广播的权威房间名单快照 */
export type LobbySnapshot = {
  roomCode: string
  phase: Phase
  hostId: PlayerId
  players: LobbyPlayer[]
  maxPlayers: number
  canStart: boolean
  /** 房主选择的地图（null = 开局时按人数自动挑） */
  mapId: string | null
  /** 房主侧单调递增版本号：客户端据此丢弃过期的重排快照 */
  rev: number
}

/** 线上消息（信封统一带 from = playerId，用于身份绑定与重连识别） */
export type Wire =
  | { t: 'game'; from: PlayerId; state: GameState; events?: GameEvent[] }
  | { t: 'cmd'; from: PlayerId; cmd: Command }
  | { t: 'cmdRejected'; from: PlayerId; code: ErrorCode }
  | { t: 'hello'; from: PlayerId; nickname: string; joinedAt: number }
  /**
   * hostHello 带 joinedAt：接收方无需先收到对方的 hello 也能裁决竞态（见 ADR-3 / ADR-19）。
   * `epoch` = 房主权任期号：**任期大的赢**，用于游戏内主机迁移时压住"带着旧局面的原房主"。
   */
  | { t: 'hostHello'; from: PlayerId; hostId: PlayerId; joinedAt: number; epoch?: number }
  | { t: 'lobby'; from: PlayerId; lobby: LobbySnapshot }
  | { t: 'ready'; from: PlayerId; ready: boolean }
  | { t: 'nick'; from: PlayerId; nickname: string }
  | { t: 'roomFull'; from: PlayerId }
  | { t: 'bye'; from: PlayerId }

/** 房间密码：Trystero 会用它派生信令密钥并做握手校验，密码不一致则根本配不上对 */
export interface TransportHandlers {
  onMessage: (msg: Wire, peerId: PeerId) => void
  onPeerJoin: (peerId: PeerId) => void
  onPeerLeave: (peerId: PeerId) => void
  onStatus: (status: TransportStatus, detail?: string) => void
}

/** 传输层接口：Trystero 与本地调试传输共用同一契约 */
export interface Transport {
  readonly selfId: PeerId
  readonly kind: TransportKind
  send: (msg: Wire, to?: PeerId) => void
  getPeers: () => PeerId[]
  leave: () => Promise<void>
}

/** 传输工厂：密码在 join 时才确定，因此作为第二个参数传入 */
export type TransportFactory = (handlers: TransportHandlers, password?: string | null) => Promise<Transport>
