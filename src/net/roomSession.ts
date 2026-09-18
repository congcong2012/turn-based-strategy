/**
 * 房间会话：把「传输层 + 房主选举 + 权威大厅名单」编排成一个可测试的纯 TS 状态机。
 * React 只负责订阅视图，游戏/协议逻辑全部在这里，便于单测（不依赖浏览器）。
 *
 * 模式与 GDD 一致：客户端只发意图（ready / nick），房主维护权威名单并广播 lobby。
 */

import {
  createElection,
  gone as electionGone,
  hostHello as electionHostHello,
  isSelfHost,
  seen as electionSeen,
  tick as electionTick,
} from '../app/hostElection'
import type { ElectionEffect, ElectionState } from '../app/hostElection'
import {
  createLobby,
  hasPlayer,
  isFull,
  removePlayer,
  setNickname as lobbySetNickname,
  setReady as lobbySetReady,
  upsertPlayer,
} from '../app/lobbyReducer'
import { isValidRoomCode, normalizeRoomCode } from '../app/roomCode'
import type {
  LobbyPlayer,
  LobbySnapshot,
  PeerId,
  PlayerId,
  RoomRole,
  SignalStrategy,
  Transport,
  TransportFactory,
  TransportHandlers,
  TransportKind,
  TransportStatus,
  Wire,
} from './types'

const TICK_MS = 250
const HELLO_RETRY_MS = 3000
const HELLO_MAX_ATTEMPTS = 8

export interface RoomView {
  status: TransportStatus
  statusDetail: string | null
  kind: TransportKind
  strategy: SignalStrategy
  role: RoomRole
  roomCode: string | null
  selfId: PlayerId
  nickname: string
  ready: boolean
  players: LobbyPlayer[]
  canStart: boolean
  isHost: boolean
  hostNickname: string | null
  notice: string | null
  error: string | null
  peerCount: number
}

export interface RoomSessionOptions {
  playerId: PlayerId
  nickname: string
  strategy: SignalStrategy
  kind: TransportKind
  transportFactory: TransportFactory
  now?: () => number
  tickMs?: number
  onChange?: (view: RoomView) => void
}

export interface RoomSession {
  getView: () => RoomView
  join: (roomCode: string) => Promise<void>
  leave: () => Promise<void>
  setReady: (ready: boolean) => void
  setNickname: (nickname: string) => void
  startGame: () => void
  dispose: () => void
}

export function createRoomSession(options: RoomSessionOptions): RoomSession {
  const now = options.now ?? (() => Date.now())
  const tickMs = options.tickMs ?? TICK_MS
  const selfId = options.playerId

  let status: TransportStatus = 'idle'
  let statusDetail: string | null = null
  let role: RoomRole = 'idle'
  let roomCode: string | null = null
  let nickname = options.nickname
  let ready = false
  let election: ElectionState | null = null
  let lobby: LobbySnapshot | null = null
  let notice: string | null = null
  let error: string | null = null
  let transport: Transport | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let helloAttempts = 0
  let lastHelloAt = 0
  let disposed = false
  let lastLobbyHost: PlayerId | null = null
  let lastLobbyRev = -1

  const peerToPlayer = new Map<PeerId, PlayerId>()
  const playerToPeer = new Map<PlayerId, PeerId>()
  const helloSent = new Set<PeerId>()

  /** 本地兜底名单：房主快照到达前用于渲染 */
  function fallbackPlayers(): LobbyPlayer[] {
    if (!election) return []
    return Object.values(election.records)
      .filter((r) => r.connected)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((r) => ({
        playerId: r.playerId,
        nickname: r.nickname,
        ready: r.playerId === selfId ? ready : false,
        isHost: election?.hostId === r.playerId,
        connected: true,
      }))
  }

  function currentPlayers(): LobbyPlayer[] {
    if (lobby) return lobby.players
    return fallbackPlayers()
  }

  function isHost(): boolean {
    return election !== null && isSelfHost(election)
  }

  function canStart(): boolean {
    if (lobby) return lobby.canStart
    const online = currentPlayers().filter((p) => p.connected)
    return online.length >= 2 && online.every((p) => p.ready)
  }

  function buildView(): RoomView {
    const players = currentPlayers()
    const me = players.find((p) => p.playerId === selfId)
    const hostId = election?.hostId ?? null
    const hostRec = hostId && election ? election.records[hostId] : undefined
    return {
      status,
      statusDetail,
      kind: transport?.kind ?? options.kind,
      strategy: options.strategy,
      role,
      roomCode,
      selfId,
      nickname,
      ready: me ? me.ready : ready,
      players,
      canStart: canStart(),
      isHost: isHost(),
      hostNickname: hostId === selfId ? nickname : (hostRec?.nickname ?? null),
      notice,
      error,
      peerCount: transport ? transport.getPeers().length : 0,
    }
  }

  function emit(): void {
    if (disposed) return
    options.onChange?.(buildView())
  }

  function sendToPlayer(msg: Wire, playerId: PlayerId): void {
    const peerId = playerToPeer.get(playerId)
    if (peerId) transport?.send(msg, peerId)
    else transport?.send(msg)
  }

  function sendHello(to?: PeerId): void {
    // 先登记再发送：在同步投递（本地/内存传输）下避免双方互相应答造成无限递归
    if (to) {
      if (helloSent.has(to)) return
      helloSent.add(to)
    } else {
      lastHelloAt = now()
      helloAttempts += 1
    }
    transport?.send({ t: 'hello', from: selfId, nickname, joinedAt: election?.joinedAt ?? now() }, to)
  }

  function broadcastLobby(): void {
    if (!lobby || !isHost()) return
    lobby = { ...lobby, rev: lobby.rev + 1 }
    transport?.send({ t: 'lobby', from: selfId, lobby })
  }

  /** 从选举记录重建权威名单（接管房主时用；其他人的准备状态未知，重置为未准备） */
  function lobbyFromRecords(): LobbySnapshot {
    const snapshot = roomCode ?? ''
    let next = createLobby(snapshot, selfId)
    if (election) {
      const records = Object.values(election.records)
        .filter((r) => r.connected)
        .sort((a, b) => a.joinedAt - b.joinedAt)
      for (const rec of records) {
        next = upsertPlayer(next, { playerId: rec.playerId, nickname: rec.nickname })
      }
    }
    next = lobbySetReady(next, selfId, ready)
    return next
  }

  function applyEffects(effects: ElectionEffect[]): void {
    for (const effect of effects) {
      if (effect.type === 'becameHost') {
        role = 'host'
        lobby = lobbyFromRecords()
        notice = '你已成为房主'
        broadcastLobby()
      } else if (effect.type === 'steppedDown') {
        role = 'client'
        lobby = null
        lastLobbyHost = null
        lastLobbyRev = -1
        if (ready) sendToPlayer({ t: 'ready', from: selfId, ready: true }, effect.hostId)
      } else if (effect.type === 'broadcastHostHello') {
        transport?.send({ t: 'hostHello', from: selfId, hostId: effect.hostId })
      }
    }
  }

  function handleMessage(msg: Wire, peerId: PeerId): void {
    if (msg.from === selfId) return

    switch (msg.t) {
      case 'hello': {
        sendHello(peerId)
        const prevPeer = playerToPeer.get(msg.from)
        const reconnected = prevPeer !== undefined && prevPeer !== peerId
        if (prevPeer && prevPeer !== peerId) peerToPlayer.delete(prevPeer)
        playerToPeer.set(msg.from, peerId)
        peerToPlayer.set(peerId, msg.from)

        const seen = electionSeen(
          election ?? createElection(selfId, nickname, now()),
          { playerId: msg.from, nickname: msg.nickname, joinedAt: msg.joinedAt, connected: true },
        )
        election = seen.state

        if (isHost() && lobby) {
          // 立即告诉新玩家谁是房主，避免对方空等 3 秒后误自任房主
          transport?.send({ t: 'hostHello', from: selfId, hostId: selfId }, peerId)
          const known = hasPlayer(lobby, msg.from)
          if (!known && isFull(lobby)) {
            transport?.send({ t: 'roomFull', from: selfId }, peerId)
            notice = '有玩家尝试加入，但房间已满'
            break
          }
          lobby = upsertPlayer(lobby, { playerId: msg.from, nickname: msg.nickname }, { resetReady: reconnected })
          broadcastLobby()
        }
        break
      }
      case 'hostHello': {
        if (election) {
          const result = electionHostHello(election, msg.hostId)
          election = result.state
          applyEffects(result.effects)
        }
        break
      }
      case 'lobby': {
        if (election && msg.from === election.hostId && !isHost()) {
          // 只接受来自当前房主的、比已收到更新的快照（避免竞态窗口里的旧快照回退）
          const fromNewHost = lastLobbyHost !== msg.from
          if (fromNewHost || msg.lobby.rev > lastLobbyRev) {
            lastLobbyHost = msg.from
            lastLobbyRev = msg.lobby.rev
            lobby = msg.lobby
            role = 'client'
          }
        }
        break
      }
      case 'ready': {
        if (isHost() && lobby) {
          lobby = lobbySetReady(lobby, msg.from, msg.ready)
          broadcastLobby()
        }
        break
      }
      case 'nick': {
        if (isHost() && lobby) {
          lobby = lobbySetNickname(lobby, msg.from, msg.nickname)
          broadcastLobby()
        }
        break
      }
      case 'roomFull': {
        void teardown().then(() => {
          notice = '房间已满：MVP 每房最多 2 人，请换一个房间码'
          emit()
        })
        break
      }
      case 'startHint': {
        notice = '房主开始了游戏（对局逻辑将在 M2 实现）'
        break
      }
      case 'bye': {
        handlePeerLeave(peerId)
        break
      }
    }
    emit()
  }

  function handlePeerJoin(peerId: PeerId): void {
    sendHello(peerId)
    emit()
  }

  function handlePeerLeave(peerId: PeerId): void {
    const playerId = peerToPlayer.get(peerId)
    peerToPlayer.delete(peerId)
    helloSent.delete(peerId)
    if (!playerId) {
      emit()
      return
    }
    // 该玩家已经用新连接重连（刷新场景）→ 不要移除
    if (playerToPeer.get(playerId) !== peerId) {
      emit()
      return
    }
    playerToPeer.delete(playerId)
    if (election) election = electionGone(election, playerId).state
    if (isHost() && lobby) {
      lobby = removePlayer(lobby, playerId)
      broadcastLobby()
    }
    emit()
  }

  const handlers: TransportHandlers = {
    onMessage: handleMessage,
    onPeerJoin: handlePeerJoin,
    onPeerLeave: handlePeerLeave,
    onStatus: (next: TransportStatus, detail?: string) => {
      status = next
      statusDetail = detail ?? null
      if (next === 'error' && detail) error = detail
      emit()
    },
  }

  function runTick(): void {
    if (!election) return
    const result = electionTick(election, now())
    election = result.state
    applyEffects(result.effects)

    // 信令慢启动兜底：还没握手到任何 peer 时重发 hello
    if (helloAttempts < HELLO_MAX_ATTEMPTS && now() - lastHelloAt >= HELLO_RETRY_MS) {
      const peers = transport?.getPeers().length ?? 0
      if (peers === 0) sendHello()
    }
    emit()
  }

  /** 拆掉当前房间连接与状态（不含提示文案的处理） */
  async function teardown(): Promise<void> {
    if (timer) clearInterval(timer)
    timer = null
    if (transport) {
      transport.send({ t: 'bye', from: selfId })
      await transport.leave()
    }
    transport = null
    election = null
    lobby = null
    role = 'idle'
    roomCode = null
    ready = false
    lastLobbyHost = null
    lastLobbyRev = -1
    status = 'idle'
    statusDetail = null
    peerToPlayer.clear()
    playerToPeer.clear()
    helloSent.clear()
  }

  return {
    getView: buildView,

    async join(code: string): Promise<void> {
      if (disposed) return
      const normalized = normalizeRoomCode(code)
      if (!isValidRoomCode(normalized)) {
        error = '房间码必须是 6 位（仅使用易辨识字符）'
        emit()
        return
      }
      error = null
      notice = null
      roomCode = normalized
      role = 'joining'
      ready = false
      lobby = null
      lastLobbyHost = null
      lastLobbyRev = -1
      helloAttempts = 0
      helloSent.clear()
      peerToPlayer.clear()
      playerToPeer.clear()
      election = createElection(selfId, nickname, now(), 'LOBBY')
      emit()

      const created = await options.transportFactory(handlers)
      if (disposed) {
        await created.leave()
        return
      }
      transport = created
      sendHello()
      if (timer) clearInterval(timer)
      timer = setInterval(runTick, tickMs)
      emit()
    },

    async leave(): Promise<void> {
      await teardown()
      notice = null
      error = null
      emit()
    },

    setReady(next: boolean): void {
      ready = next
      if (isHost() && lobby) {
        lobby = lobbySetReady(lobby, selfId, next)
        broadcastLobby()
      } else if (election?.hostId) {
        sendToPlayer({ t: 'ready', from: selfId, ready: next }, election.hostId)
      }
      emit()
    },

    setNickname(next: string): void {
      nickname = next.trim().slice(0, 16) || '无名将军'
      if (isHost() && lobby) {
        lobby = lobbySetNickname(lobby, selfId, nickname)
        broadcastLobby()
      } else if (election?.hostId) {
        sendToPlayer({ t: 'nick', from: selfId, nickname }, election.hostId)
      }
      emit()
    },

    startGame(): void {
      if (!isHost() || !canStart()) return
      notice = '全员已准备 —— 对局将在 M2 进入部署阶段（本里程碑只做提示）'
      transport?.send({ t: 'startHint', from: selfId })
      emit()
    },

    dispose(): void {
      disposed = true
      if (timer) clearInterval(timer)
      timer = null
      void transport?.leave()
      transport = null
    },
  }
}
