/**
 * 房间会话：把「传输层 + 房主选举 + 权威大厅名单」编排成一个可测试的纯 TS 状态机。
 * React 只负责订阅视图，游戏/协议逻辑全部在这里，便于单测（不依赖浏览器）。
 *
 * 模式与 GDD 一致：客户端只发意图（ready / nick），房主维护权威名单并广播 lobby。
 */

import {
  createElection,
  setPhase as electionSetPhase,
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
  markConnected,
  markDisconnected,
  removePlayer,
  setNickname as lobbySetNickname,
  setReady as lobbySetReady,
  upsertPlayer,
} from '../app/lobbyReducer'
import { isValidRoomCode, normalizeRoomCode } from '../app/roomCode'
import { defaultStorage, loadGame, saveGame } from './gameStore'
import type { GameStorage } from './gameStore'
import { applyCommand } from '../game/commands'
import { describeEvents } from '../game/logText'
import type { LogContext } from '../game/logText'
import { createGame } from '../game/state'
import { buildingType, unitType } from '../game/data'
import type { Command, GameEvent, GameState } from '../game/types'
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
  /** M2：房主创建对局后，客户端会持续收到权威状态 */
  game: GameState | null
  /** 当前是否轮到我行动 */
  myTurn: boolean
  /** M3：对局是否被暂停（房主掉线，或轮到掉线玩家） */
  paused: boolean
  pausedReason: 'none' | 'host-offline' | 'player-offline'
  /** M3：房主可以把掉线玩家的回合跳过 */
  canSkipTurn: boolean
  /** M3：掉线中的玩家（对局进行时保留席位） */
  offlinePlayers: PlayerId[]
  /** M3：中文战报（最新在最后） */
  log: string[]
  /** M5：最近的原始事件（带序号，供渲染层播动画与音效，保证只播一次） */
  events: LoggedEvent[]
}

export type LoggedEvent = { seq: number; event: GameEvent }

export interface RoomSessionOptions {
  playerId: PlayerId
  nickname: string
  strategy: SignalStrategy
  kind: TransportKind
  transportFactory: TransportFactory
  now?: () => number
  tickMs?: number
  /** 房主侧对局持久化用的存储（默认 localStorage；测试可注入内存实现） */
  storage?: GameStorage | null
  onChange?: (view: RoomView) => void
}

export interface RoomSession {
  getView: () => RoomView
  join: (roomCode: string) => Promise<void>
  /** 明确离开房间：会清掉房主侧的持久化对局（刷新/关闭标签页请用 dispose） */
  leave: () => Promise<void>
  setReady: (ready: boolean) => void
  setNickname: (nickname: string) => void
  /** 房主：LOBBY → DEPLOY，创建权威对局状态 */
  startGame: () => void
  /** 任何玩家：发出对局指令（房主本地校验，客户端发给房主校验） */
  sendCommand: (cmd: Command) => void
  /** 房主：跳过掉线玩家的回合（仅当其确实掉线时可用） */
  skipDisconnectedTurn: () => void
  dispose: () => void
}

export function createRoomSession(options: RoomSessionOptions): RoomSession {
  const now = options.now ?? (() => Date.now())
  const tickMs = options.tickMs ?? TICK_MS
  const selfId = options.playerId
  const storage = options.storage === undefined ? defaultStorage() : options.storage

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
  let game: GameState | null = null
  let log: string[] = []
  let recentEvents: LoggedEvent[] = []
  let eventSeq = 0

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

  function isPlayerConnected(playerId: PlayerId): boolean {
    if (!lobby) return election?.records[playerId]?.connected ?? false
    return lobby.players.find((p) => p.playerId === playerId)?.connected ?? false
  }

  function buildView(): RoomView {
    const players = currentPlayers()
    const me = players.find((p) => p.playerId === selfId)
    const hostId = election?.hostId ?? null
    const hostRec = hostId && election ? election.records[hostId] : undefined

    // 断线暂停判定：房主不在 → 客户端整体冻结；轮到掉线玩家 → 对局停滞
    const hostOffline =
      !isHost() && hostId !== null && game !== null && !(election?.records[hostId]?.connected ?? false)
    const currentId = game ? (game.players[game.turnIndex] ?? null) : null
    const currentOffline =
      !!game && game.phase !== 'GAME_OVER' && currentId !== null && !isPlayerConnected(currentId)
    const pausedReason: RoomView['pausedReason'] = hostOffline
      ? 'host-offline'
      : currentOffline
        ? 'player-offline'
        : 'none'

    return buildViewWith({ players, me, hostId, hostRec, pausedReason, currentOffline })
  }

  function buildViewWith(input: {
    players: LobbyPlayer[]
    me: LobbyPlayer | undefined
    hostId: PlayerId | null
    hostRec: { nickname: string } | undefined
    pausedReason: RoomView['pausedReason']
    currentOffline: boolean
  }): RoomView {
    const { players, me, hostId, hostRec, pausedReason, currentOffline } = input
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
      // 注：paused/pausedReason/canSkipTurn/offlinePlayers 在下方 return 中补齐
      notice,
      error,
      peerCount: transport ? transport.getPeers().length : 0,
      game,
      myTurn: game !== null && game.phase === 'PLAYING' && game.players[game.turnIndex] === selfId,
      paused: pausedReason !== 'none',
      pausedReason,
      canSkipTurn: isHost() && currentOffline && game?.phase === 'PLAYING',
      offlinePlayers: players.filter((p) => !p.connected).map((p) => p.playerId),
      log,
      events: recentEvents,
    }
  }

  /** 把内核事件翻译成战报（用"变更前"的状态解析已被歼灭单位/已易主据点的名字） */
  function appendLog(events: GameEvent[], before: GameState | null, after: GameState): void {
    if (events.length === 0) return
    void after
    const nameOf = (playerId: PlayerId): string =>
      lobby?.players.find((p) => p.playerId === playerId)?.nickname ?? (playerId === selfId ? nickname : playerId.slice(0, 6))
    const ctx: LogContext = {
      unitName: (unitId) => {
        const unit = before?.units.find((u) => u.id === unitId) ?? after.units.find((u) => u.id === unitId)
        if (!unit) return '某部队'
        return unitType(unit.type).name + '·' + nameOf(unit.owner)
      },
      buildingName: (buildingId) => {
        const building = before?.buildings.find((b) => b.id === buildingId) ?? after.buildings.find((b) => b.id === buildingId)
        return building ? buildingType(building.type).name : '据点'
      },
      playerName: nameOf,
    }
    log = [...log, ...describeEvents(events, ctx)].slice(-60)
    const logged = events.map((event) => {
      eventSeq += 1
      return { seq: eventSeq, event }
    })
    recentEvents = [...recentEvents, ...logged].slice(-12)
  }

  function broadcastGame(events: GameEvent[] = []): void {
    if (!game || !isHost()) return
    transport?.send({ t: 'game', from: selfId, state: game, events })
  }

  /** 房主：执行一条指令（本地或来自客户端的意图），并把结果广播出去 */
  function runCommand(playerId: PlayerId, cmd: Command, peerId?: PeerId): void {
    if (!game || !isHost()) return
    if (game.phase === 'DEPLOY' && cmd.type === 'deployDone') {
      // 允许房主/客户端在部署阶段随时确认
    }
    const result = applyCommand(game, playerId, cmd)
    if (!result.ok) {
      if (peerId) transport?.send({ t: 'cmdRejected', from: selfId, code: result.code }, peerId)
      else error = '指令被拒绝：' + result.code
      emit()
      return
    }
    const before = game
    game = result.state
    appendLog(result.events, before, game)
    if (roomCode) saveGame(storage, roomCode, game)
    broadcastGame(result.events)
    emit()
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

  /**
   * 房主重连后恢复上一局：仅当持久化对局里的所有玩家都已回到房间时才恢复，
   * 恢复后立即把完整状态广播出去，客户端无缝继续。
   */
  function maybeRestoreGame(): void {
    if (!isHost() || game !== null || !roomCode || !lobby) return
    const stored = loadGame(storage, roomCode)
    if (!stored || stored.phase === 'GAME_OVER') return
    const roster = new Set(lobby.players.filter((p) => p.connected).map((p) => p.playerId))
    if (!stored.players.every((p) => roster.has(p))) return
    game = stored
    if (election) {
      // GAME_OVER 已在上面排除，这里只可能是 DEPLOY / PLAYING
      election = electionSetPhase(election, stored.phase === 'DEPLOY' ? 'DEPLOY' : 'PLAYING')
    }
    if (lobby) lobby = { ...lobby, phase: stored.phase }
    notice = '已恢复上一局对局（断线重连）'
    broadcastGame()
    broadcastLobby()
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
        maybeRestoreGame()
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
          // 若是掉线玩家回来了：恢复席位（对局进行中我们保留了他的座位）
          lobby = markConnected(lobby, msg.from)
          // 若对局已开始，补发完整快照（断线重连 / 中途加入）
          if (game) transport?.send({ t: 'game', from: selfId, state: game }, peerId)
          else maybeRestoreGame()
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
      case 'cmd': {
        if (isHost()) runCommand(msg.from, msg.cmd, peerId)
        break
      }
      case 'game': {
        if (!isHost()) {
          if (msg.events && msg.events.length > 0) appendLog(msg.events, game, msg.state)
          game = msg.state
          // 对局期间禁止主机迁移：客户端只等待房主回来，不接管（GDD 8.5）
          if (election) {
            election = electionSetPhase(
              election,
              msg.state.phase === 'GAME_OVER' ? 'GAME_OVER' : msg.state.phase === 'DEPLOY' ? 'DEPLOY' : 'PLAYING',
            )
          }
          if (lobby) {
            lobby = {
              ...lobby,
              phase: msg.state.phase === 'GAME_OVER' ? 'GAME_OVER' : msg.state.phase === 'DEPLOY' ? 'DEPLOY' : 'PLAYING',
            }
          }
        }
        break
      }
      case 'cmdRejected': {
        error = '指令被拒绝：' + msg.code
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
      const inGame = game !== null && (game.phase === 'DEPLOY' || game.phase === 'PLAYING')
      // 对局进行中：保留席位等待重连；未开局：直接移出名单
      lobby = inGame ? markDisconnected(lobby, playerId) : removePlayer(lobby, playerId)
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
    game = null
    role = 'idle'
    roomCode = null
    ready = false
    log = []
    recentEvents = []
    eventSeq = 0
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
      game = null
      log = []
      recentEvents = []
      eventSeq = 0
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
      const order = (lobby?.players ?? []).filter((p) => p.connected).map((p) => p.playerId)
      if (order.length < 2) {
        error = '至少需要 2 名玩家才能开始'
        emit()
        return
      }
      game = createGame('ancient_01', order)
      if (election) election = electionSetPhase(election, 'DEPLOY')
      if (lobby) lobby = { ...lobby, phase: 'DEPLOY' }
      notice = '进入部署阶段：在己方部署区放置初始部队'
      transport?.send({ t: 'game', from: selfId, state: game })
      broadcastLobby()
      emit()
    },

    skipDisconnectedTurn(): void {
      if (!isHost() || !game || game.phase !== 'PLAYING') return
      const current = game.players[game.turnIndex]
      if (isPlayerConnected(current)) return
      notice = '已跳过掉线玩家的回合'
      runCommand(current, { type: 'endTurn' })
    },

    sendCommand(cmd: Command): void {
      if (!game) return
      if (isHost()) {
        runCommand(selfId, cmd)
        return
      }
      const hostPeer = election?.hostId ? playerToPeer.get(election.hostId) : undefined
      const wire = { t: 'cmd' as const, from: selfId, cmd }
      if (hostPeer) transport?.send(wire, hostPeer)
      else transport?.send(wire)
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
