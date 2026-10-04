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
  setAiSlotCount as lobbySetAiSlotCount,
  setMapId as lobbySetMapId,
  setNickname as lobbySetNickname,
  setReady as lobbySetReady,
  upsertPlayer,
} from '../app/lobbyReducer'
import { isValidRoomCode, normalizeRoomCode } from '../app/roomCode'
import { deriveConnectionState } from './connectionState'
import type { ConnectionState } from './connectionState'
import { createManualTransport } from './manualTransport'
import { describeTransportError } from './transportErrorText'
import type { ManualRole, ManualTransport } from './manualTransport'
import { defaultStorage, loadGame, saveGame } from './gameStore'
import type { GameStorage } from './gameStore'
import { MAX_AI_STEPS, nextCommand } from '../ai'
import type { Difficulty } from '../ai'
import { applyCommand } from '../game/commands'
import { defaultMapFor } from '../game/data'
import { describeErrorCode } from '../game/errorText'
import { appendJournal, emptyJournal } from '../game/journal'
import type { Journal, LoggedEvent } from '../game/journal'
import { createGame } from '../game/state'
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

/** 掉线托管的每步间隔：与单人练习同款节奏，让牌桌上看得清 AI 在动 */
const TAKEOVER_STEP_MS = 450
/** 托管一个回合最多走多少步（兜底，绝不死循环） */
const TAKEOVER_MAX_STEPS = MAX_AI_STEPS
/**
 * 用哪一档 AI 代替真人行动（掉线托管 + AI 补位）。
 * 取「普通」：不掉线的人既不该被更强的 AI 惩罚，也不该被白送。
 *
 * 已预留"按房间配置"的位置（房主未来若要开"困难 AI 补位"，只需把这里换成
 * `lobby.aiDifficulty` 之类的字段，UI 加一个下拉即可）。
 */
const TAKEOVER_DIFFICULTY: Difficulty = 'normal'

/**
 * AI 补位席位的 id 前缀。
 *
 * 为什么用 `ai-*`：单人练习（`pveSession`）已经在用同一套命名（`ai-0/1/2`），
 * 而 `isPlayerConnected()` 是"未知玩家一律视为在线"——
 * 于是**大厅里根本不存在的 AI 席位天然会被当作"已连接"**，不需要给 `lobby.players` 塞假玩家。
 * 这是本功能能做到"最小侵入"的关键。
 */
const AI_SEAT_PREFIX = 'ai-'
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
  /** 房主选择的地图（null = 自动） */
  mapId: string | null
  /**
   * AI 补位：本局总共几个席位（含真人；0 = 不补位）。
   * 房主在大厅可调，开局时一次性生效（之后随 lobby 快照同步给所有人）。
   */
  aiSlotCount: number
  /** 本会话是不是观战者（只读：不占席位、不能操作） */
  spectating: boolean
  /** 是否启用了房间密码（只暴露布尔值，不回显明文） */
  passwordEnabled: boolean
  /** 用户可见的连接状态（连接中 / 已连接 / 等待对手 / 重连中 / 失败） */
  connection: ConnectionState
  /** 传输层原始状态与说明（诊断面板用） */
  transportStatus: TransportStatus
  transportDetail: string | null
  /** 手动直连配对状态（未使用则为 null） */
  manual: ManualPairingState | null
  /** 最近的错误记录（诊断面板用，最新的在最后） */
  errors: Array<{ at: number; text: string }>
  /** 当前是否轮到我行动 */
  myTurn: boolean
  /** M3：对局是否被暂停（房主掉线，或轮到掉线玩家） */
  paused: boolean
  pausedReason: 'none' | 'host-offline' | 'player-offline'
  /** M3：房主可以把掉线玩家的回合跳过 */
  canSkipTurn: boolean
  /** 房主可以让 AI **代打**掉线玩家的整个回合（比"跳过"更不伤那一方） */
  canTakeOver: boolean
  /** 正在被 AI 代打的玩家（null = 没有托管在跑） */
  takeoverPlayerId: PlayerId | null
  /** M3：掉线中的玩家（对局进行时保留席位） */
  offlinePlayers: PlayerId[]
  /** M3：中文战报（最新在最后） */
  log: string[]
  /** M5：最近的原始事件（带序号，供渲染层播动画与音效，保证只播一次） */
  events: LoggedEvent[]
}

/** 与 roomSession 同源：战报/事件累积器的实现已抽到 game/journal（联机与单人共用） */
export type { LoggedEvent }

/** 手动直连（SDP 交换）的配对状态 */
export type ManualPhase = 'creating' | 'need-offer' | 'need-answer' | 'connecting' | 'connected' | 'failed'
export type ManualPairingState = { role: ManualRole; code: string | null; phase: ManualPhase; error: string | null }

export type { ConnectionState } from './connectionState'

export interface RoomSessionOptions {
  /** 带密码的传输工厂（可选；提供时优先使用，密码在 join 时才确定） */
  transportFactoryForPassword?: (password: string | null) => TransportFactory
  playerId: PlayerId
  nickname: string
  strategy: SignalStrategy
  kind: TransportKind
  transportFactory: TransportFactory
  /**
   * 手动直连的传输工厂（测试可注入假实现；默认走真实 WebRTC）。
   * 抽这个口子是为了能单测"连接成功那一刻的相位竞争"——真实 WebRTC 在单测环境里跑不起来。
   */
  manualTransportFactory?: (options: { role: ManualRole; handlers: TransportHandlers }) => ManualTransport
  now?: () => number
  tickMs?: number
  /** 房主侧对局持久化用的存储（默认 localStorage；测试可注入内存实现） */
  storage?: GameStorage | null
  onChange?: (view: RoomView) => void
}

export interface RoomSession {
  getView: () => RoomView
  /** 加入房间；`asSpectator` = 以观战身份进入（不占席位、不能操作） */
  join: (roomCode: string, password?: string, asSpectator?: boolean) => Promise<void>
  /** 明确离开房间：会清掉房主侧的持久化对局（刷新/关闭标签页请用 dispose） */
  leave: () => Promise<void>
  setReady: (ready: boolean) => void
  setNickname: (nickname: string) => void
  /** 房主：选择地图（null = 按人数自动） */
  setMap: (mapId: string | null) => void
  /** 设置 AI 补位（本局总共几个席位、含真人；0 = 不补位）。仅房主有效 */
  setAiSlots: (count: number) => void
  /** 房主：LOBBY → DEPLOY，创建权威对局状态 */
  startGame: () => void
  /** 任何玩家：发出对局指令（房主本地校验，客户端发给房主校验） */
  sendCommand: (cmd: Command) => void
  /** 房主：跳过掉线玩家的回合（仅当其确实掉线时可用） */
  skipDisconnectedTurn: () => void
  /** 让 AI 代打掉线玩家的这一整个回合（仅房主可用） */
  takeOverDisconnectedTurn: () => void
  /** M7：手动直连（公共信令不可用时的备用方案）——开始配对 */
  startManualPairing: (roomCode: string, role: ManualRole) => Promise<void>
  /** M7：提交对方给的连接码（好友：邀请码；房主：应答码） */
  submitManualCode: (code: string) => Promise<void>
  /** M7：一键重连（断开后按当前信令策略重新加入） */
  retryConnection: () => void
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
  let roomPassword: string | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let helloAttempts = 0
  let lastHelloAt = 0
  let disposed = false
  /**
   * 掉线托管的运行状态：正在被 AI 代打的玩家 + 已代打步数。
   * 用 setTimeout 逐拍推进（而不是一口气跑完），这样牌桌上能看清 AI 的动作，
   * 也能在掉线者中途回来时立刻交还控制权。
   */
  let takeover: { playerId: PlayerId; steps: number } | null = null
  let takeoverTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * AI 补位：本局总共几个席位（含补位的 AI；0 = 关闭，只有真人）。
   * 房主在大厅设置，开局时一次性决定，之后随 lobby 快照同步给所有人。
   */
  let aiSlotCount = 0
  /**
   * 观战模式：本会话是**只读客户端** —— 不占对局席位、不发指令、不参与准备。
   * 本作没有战争迷雾，观战者看到的与任何一名玩家相同，因此不需要裁剪信息。
   */
  let spectating = false
  /**
   * 会话已作废（leave 之后）。
   * 为什么需要它：join() 里 `await transportFactory(...)` 可能要几百毫秒（动态 import + 建连），
   * 若这期间发生了 leave（React StrictMode 的"挂载→卸载→再挂载"、用户秒点离开），
   * 回调返回后 transport 才就绪，旧的 activate() 会把**已经离开的会话救活**：
   * 它继续跑 tick、继续自任房主、继续 onChange 覆盖新会话的界面
   * （v1.0.0 实测：刷新重连后列表只剩自己，就是旧会话在抢 UI）。
   */
  let closed = false
  let lastLobbyHost: PlayerId | null = null
  let lastLobbyRev = -1
  let game: GameState | null = null
  let journal: Journal = emptyJournal()
  let manualTransport: ManualTransport | null = null
  let manual: ManualPairingState | null = null
  let errorLog: Array<{ at: number; text: string }> = []

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
    if (!lobby) return fallbackPlayers()
    // 对局中：把 AI 补位席位也列出来（计分板/战报需要它们有名字，
    // 否则 GameScreen 会退化成显示 `ai-2` 这种 id 前缀）
    const aiSeats: LobbyPlayer[] = (game?.players ?? [])
      .filter(isAiSeat)
      .map((playerId) => ({
        playerId,
        nickname: aiSeatName(playerId),
        ready: true,
        isHost: false,
        connected: true,
      }))
    return [...lobby.players, ...aiSeats]
  }

  /** AI 补位席位的显示名：与单人练习的叫法一致（电脑甲/乙/丙），按座位序派生 */
  function aiSeatName(playerId: PlayerId): string {
    const seat = Number(playerId.slice(AI_SEAT_PREFIX.length))
    const ordinal = Number.isFinite(seat) ? seat : 0
    const labels = ['电脑甲', '电脑乙', '电脑丙']
    return labels[ordinal] ?? '电脑' + (ordinal + 1)
  }

  function isHost(): boolean {
    return election !== null && isSelfHost(election)
  }

  function canStart(): boolean {
    if (lobby) return lobby.canStart
    const online = currentPlayers().filter((p) => p.connected)
    return online.length >= 2 && online.every((p) => p.ready)
  }

  /** 该席位是不是 AI 补位（不是真人，永远"在线"，由房主的 AI 驱动） */
  function isAiSeat(playerId: PlayerId): boolean {
    return playerId.startsWith(AI_SEAT_PREFIX)
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
      mapId: lobby?.mapId ?? null,
      // 以 lobby 快照为准：客户端只能从快照得知这个设置（房主侧两者本就一致）
      aiSlotCount: lobby?.aiSlotCount ?? aiSlotCount,
      spectating,
      passwordEnabled: roomPassword !== null,
      myTurn: game !== null && game.phase === 'PLAYING' && game.players[game.turnIndex] === selfId,
      paused: pausedReason !== 'none',
      pausedReason,
      canSkipTurn: isHost() && currentOffline && game?.phase === 'PLAYING',
      canTakeOver: isHost() && currentOffline && game?.phase === 'PLAYING' && takeover === null,
      takeoverPlayerId: takeover?.playerId ?? null,
      offlinePlayers: players.filter((p) => !p.connected).map((p) => p.playerId),
      log: journal.log,
      events: journal.events,
      connection: deriveConnection(),
      transportStatus: status,
      transportDetail: statusDetail,
      manual,
      errors: errorLog,
    }
  }

  /**
   * 用户可见的连接状态：
   *  - 传输层明确失败 → failed
   *  - 还在连接 / 刚加入 → connecting
   *  - 有 peer → connected
   *  - 没有 peer：对局中或对手席位存在 → reconnecting（等待重连）；否则 waiting（等对手进房）
   */
  function deriveConnection(): ConnectionState {
    return deriveConnectionState({
      role,
      status,
      detail: statusDetail,
      peerCount: transport?.getPeers().length ?? 0,
      expectedPlayers: lobby?.players.filter((p) => p.connected).length ?? 0,
      inGame: game !== null,
    })
  }

  /** 玩家 id → 昵称（战报用） */
  function nameOfPlayer(playerId: PlayerId): string {
    return lobby?.players.find((p) => p.playerId === playerId)?.nickname ?? (playerId === selfId ? nickname : playerId.slice(0, 6))
  }

  /** 把内核事件翻译成战报（用"变更前"的状态解析已被歼灭单位/已易主据点的名字） */
  function appendLog(events: GameEvent[], before: GameState | null, after: GameState): void {
    journal = appendJournal(journal, events, before, after, nameOfPlayer)
  }

  function broadcastGame(events: GameEvent[] = []): void {
    if (!game || !isHost()) return
    transport?.send({ t: 'game', from: selfId, state: game, events })
  }

  /** 房主：执行一条指令（本地或来自客户端的意图），并把结果广播出去 */
  // ------------------------------------------------------------------ 掉线托管

  /**
   * 让 AI 代打掉线玩家的**这一整个回合**（仅房主执行，结果照常广播）。
   *
   * 为什么值得单独做（而不是只有"跳过其回合"）：好友局最难凑的是"所有人同时在线"，
   * 一个人接电话/断网就白站一局，其他人还得替他点跳过。既然已经有现成的 AI
   * （公平、纯函数、不读任何隐藏信息），交给它代打一回合是最不伤体验的兜底。
   *
   * 关键点：
   *  - **逐拍推进**（450ms 一步）：一口气跑完会在牌桌上"闪现"，也来不及在掉线者回来时收手；
   *  - 掉线者中途重连 → 立刻停止并交还控制权；
   *  - 步数上限 + "rev 没变说明指令被拒"双保险，绝不把整局卡在托管里。
   */
  function stopTakeover(): void {
    if (takeoverTimer !== null) {
      clearTimeout(takeoverTimer)
      takeoverTimer = null
    }
    takeover = null
  }

  function scheduleTakeoverStep(): void {
    if (takeoverTimer !== null || disposed) return
    takeoverTimer = setTimeout(stepTakeover, TAKEOVER_STEP_MS)
  }

  function stepTakeover(): void {
    takeoverTimer = null
    if (disposed || !game || game.phase !== 'PLAYING' || !takeover) return

    const actor = game.players[game.turnIndex]
    if (actor !== takeover.playerId) {
      notice = 'AI 代打结束：回合已交接'
      stopTakeover()
      emit()
      return
    }
    // AI 补位席位永远由 AI 驱动（不检查连接状态）；真人席位则一旦重连就交还控制权
    if (!isAiSeat(actor) && isPlayerConnected(actor)) {
      notice = '掉线玩家已重连，控制权已交还'
      stopTakeover()
      emit()
      return
    }

    takeover.steps += 1
    if (takeover.steps > TAKEOVER_MAX_STEPS) {
      runCommand(actor, { type: 'endTurn' })
      notice = 'AI 代打结束（已达单回合步数上限）'
      stopTakeover()
      emit()
      return
    }

    const cmd = nextCommand(game, actor, TAKEOVER_DIFFICULTY)
    // ⚠️ 别用 `state.rev` 判断指令有没有生效：`wait` 分支**不会**自增 rev（commands.ts 里
    //    其它分支都有 `s.rev += 1`，只有它没有），拿 rev 当代理会把合法的 wait 误判成"被拒"，
    //    于是托管第一步就停、回合永远交不出去。直接用 runCommand 的真实返回值。
    if (!runCommand(actor, cmd)) {
      // 指令被拒（理论上不该发生）：停手，别把整局拖进死循环。
      // 带上指令类型，出问题时一眼能看出是哪一类动作不合法。
      notice = 'AI 代打中止：' + cmd.type + ' 指令被拒绝'
      stopTakeover()
      emit()
      return
    }
    if (cmd.type === 'endTurn' || game.phase !== 'PLAYING') {
      notice = 'AI 已代打完这一回合'
      stopTakeover()
      emit()
      return
    }
    scheduleTakeoverStep()
  }

  /**
   * 部署阶段把 AI 席位一次性部署完（含 `deployDone`）。
   *
   * 与行动阶段的逐拍推进不同，部署是"开盘前的摆子"，一口气做完更利落
   * （也是 PVE 里 `pumpDeploy` 的做法）。
   */
  function pumpDeployAi(): void {
    if (!isHost() || !game || game.phase !== 'DEPLOY') return
    let guard = 0
    while (guard < 64) {
      guard += 1
      const pending = game.players.find(
        (p) => p.startsWith(AI_SEAT_PREFIX) && !game?.deploy[p]?.done,
      )
      if (!pending) return
      if (!runCommand(pending, nextCommand(game, pending, TAKEOVER_DIFFICULTY))) {
        // 指令被拒（理论上不该发生）：停下，别死循环
        return
      }
    }
  }

  function beginTakeover(): void {
    if (disposed || !isHost() || !game || game.phase !== 'PLAYING') return
    const current = game.players[game.turnIndex]
    // AI 补位席位不需要"是否掉线"的判断：它本来就该由 AI 走
    if (!isAiSeat(current) && isPlayerConnected(current)) return
    if (takeover !== null) return
    takeover = { playerId: current, steps: 0 }
    notice = takeoverNotice(current)
    emit()
    scheduleTakeoverStep()
  }

  /** 托管/代打开始时的提示文案（AI 补位与掉线托管用不同的说法） */
  function takeoverNotice(playerId: PlayerId): string {
    return isAiSeat(playerId) ? 'AI 正在行动…' : '掉线玩家的回合交给 AI 代打…'
  }

  /** 执行一条指令（房主侧）。返回**是否被接受** —— 掉线托管要靠它判断该不该继续。 */
  function runCommand(playerId: PlayerId, cmd: Command, peerId?: PeerId): boolean {
    if (!game || !isHost()) return false
    if (game.phase === 'DEPLOY' && cmd.type === 'deployDone') {
      // 允许房主/客户端在部署阶段随时确认
    }
    const result = applyCommand(game, playerId, cmd)
    if (!result.ok) {
      if (peerId) transport?.send({ t: 'cmdRejected', from: selfId, code: result.code }, peerId)
      else recordError('指令被拒绝：' + describeErrorCode(result.code))
      emit()
      return false
    }
    const before = game
    game = result.state
    appendLog(result.events, before, game)
    if (roomCode) saveGame(storage, roomCode, game)
    broadcastGame(result.events)
    emit()
    return true
  }

  /**
   * 只在视图**真正变化**时通知 React。
   * 之前每个 tick（250ms）都无条件 emit，导致整个界面每秒重渲染 4 次：
   * 页面永远不空闲（移动端发热、自动化测试里元素"永不稳定"），纯属浪费。
   */
  let lastSignature = ''
  function emit(): void {
    if (disposed) return
    const view = buildView()
    let signature: string
    try {
      signature = JSON.stringify(view)
    } catch {
      signature = String(Math.random())
    }
    if (signature === lastSignature) return
    lastSignature = signature
    options.onChange?.(view)
  }

  /** 记录一条错误：既用于界面提示，也进诊断面板的历史 */
  function recordError(text: string): void {
    error = text
    errorLog = [...errorLog, { at: now(), text }].slice(-20)
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
    transport?.send(
      { t: 'hello', from: selfId, nickname, joinedAt: election?.joinedAt ?? now(), spectator: spectating },
      to,
    )
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
      // 交接发生时是否已经开局（决定提示文案：大厅接管 vs 对局内接管）
      const wasInGame = game !== null && game.phase !== 'GAME_OVER'
      if (effect.type === 'becameHost') {
        role = 'host'
        lobby = lobbyFromRecords()
        notice = wasInGame ? '原房主掉线，你已接任房主' : '你已成为房主'
        broadcastLobby()
        // 对局中接管：**内存里那份局面就是最新的**（房主每执行一步都会全量广播），
        // 所以不需要任何"状态传输"，直接用自己手上的继续，并再广播一次让所有人（含原房主）对齐。
        // maybeRestoreGame 只在 game === null 时才会读本地存档，因此不会覆盖它。
        maybeRestoreGame()
        if (game) {
          if (roomCode) saveGame(storage, roomCode, game)
          broadcastGame()
        }
      } else if (effect.type === 'steppedDown') {
        role = 'client'
        lobby = null
        lastLobbyHost = null
        lastLobbyRev = -1
        if (ready) sendToPlayer({ t: 'ready', from: selfId, ready: true }, effect.hostId)
        // 降级后必须重新自我介绍：新房主只有收到 hello 才会广播权威名单，
        // 否则我们这边会停在"等待对手"（实测：刷新重连竞态下正是这样卡住的）
        const peerId = playerToPeer.get(effect.hostId)
        if (peerId) {
          helloSent.delete(peerId)
          sendHello(peerId)
        }
      } else if (effect.type === 'broadcastHostHello') {
        transport?.send({
          t: 'hostHello',
          from: selfId,
          hostId: effect.hostId,
          joinedAt: election?.joinedAt ?? now(),
          epoch: election?.epoch ?? 0,
        })
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
          // joinedAt 一并带上：对方即便还没收到我们的 hello，也能正确裁决竞态
          transport?.send(
            {
              t: 'hostHello',
              from: selfId,
              hostId: selfId,
              joinedAt: election?.joinedAt ?? now(),
              epoch: election?.epoch ?? 0,
            },
            peerId,
          )
          // 若是掉线玩家回来了：恢复席位（对局进行中我们保留了他的座位）
          lobby = markConnected(lobby, msg.from)
          aiSlotCount = lobby.aiSlotCount
          // 若对局已开始，补发完整快照（断线重连 / 中途加入）
          if (game) transport?.send({ t: 'game', from: selfId, state: game }, peerId)
          else maybeRestoreGame()
          const known = hasPlayer(lobby, msg.from)
          // 观战者不占席位：房间满员时也放行（否则「满员也能观战」的承诺不成立）
          if (!known && msg.spectator !== true && isFull(lobby)) {
            transport?.send({ t: 'roomFull', from: selfId }, peerId)
            notice = '有玩家尝试加入，但房间已满'
            break
          }
          lobby = upsertPlayer(
            lobby,
            { playerId: msg.from, nickname: msg.nickname, spectator: msg.spectator === true },
            { resetReady: reconnected },
          )
          broadcastLobby()
        }
        break
      }
      case 'hostHello': {
        if (election) {
          const result = electionHostHello(election, msg.hostId, msg.joinedAt ?? null, msg.epoch ?? null)
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
        recordError('指令被拒绝：' + describeErrorCode(msg.code))
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
          notice = '房间已满：每房最多 4 人，请换一个房间码'
          emit()
        })
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
      // 传输层是英文错误（Trystero 抛出），这里翻成玩家能照做的中文提示
      statusDetail = detail ? describeTransportError(detail) : null
      if (next === 'failed' && statusDetail) recordError(statusDetail)
      if (manual && next === 'connected') manual = { ...manual, phase: 'connected', error: null }
      emit()
    },
  }

  /**
   * 统一入口：当前该由 AI 行动时，把它交给托管调度去走。
   *
   * 覆盖两种情形：
   *  1. **AI 补位席位**（`ai-*`）—— 始终由 AI 驱动；
   *  2. **真人掉线**—— 但"托管"是房主点的动作（`takeOverDisconnectedTurn`），
   *     所以这里**不自动**替掉线者行动，只处理 AI 席位，避免"房主没点就被 AI 接管"。
   *
   * 部署阶段用 `pumpDeployAi` 一口气做完，不进逐拍调度。
   */
  function pumpAiSeats(): void {
    if (!isHost() || !game || takeover !== null) return
    if (game.phase === 'DEPLOY') {
      pumpDeployAi()
      emit()
      return
    }
    if (game.phase !== 'PLAYING') return
    const actor = game.players[game.turnIndex]
    if (!actor || !isAiSeat(actor)) return
    beginTakeover()
  }

  function runTick(): void {
    if (!election) return
    const result = electionTick(election, now())
    election = result.state
    applyEffects(result.effects)
    pumpAiSeats()

    // 信令慢启动 / 房间继承兜底：出现下面任一情况就重发 hello
    //   1) 还没握手到任何 peer（信令慢启动）
    //   2) 有 peer，但名单里除了自己没有任何在线玩家（说明握手没走通：对方没回过 hello）
    // 第 2 条是"静默分裂"的解药：刷新后新会话可能直接继承一个已建连的房间，
    // 两端都不会再触发 onPeerJoin，于是谁都不再自我介绍 → 双方各自超时自任房主、名单永远只有自己。
    if (helloAttempts < HELLO_MAX_ATTEMPTS && now() - lastHelloAt >= HELLO_RETRY_MS) {
      const peers = transport?.getPeers().length ?? 0
      const rosterKnown = (lobby?.players.filter((p) => p.connected).length ?? 0) > 1
      if (peers === 0 || !rosterKnown) sendHello()
    }
    emit()
  }

  /** 拆掉当前房间连接与状态（不含提示文案的处理） */
  async function teardown(): Promise<void> {
    closed = true
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
    journal = emptyJournal()
    lastLobbyHost = null
    lastLobbyRev = -1
    status = 'idle'
    statusDetail = null
    manualTransport = null
    manual = null
    roomPassword = null
    errorLog = []
    peerToPlayer.clear()
    playerToPeer.clear()
    helloSent.clear()
  }

  /** 进入房间前的状态复位（join 与手动直连共用） */
  function resetForRoom(normalized: string): void {
    error = null
    notice = null
    roomCode = normalized
    role = 'joining'
    ready = false
    lobby = null
    game = null
    journal = emptyJournal()
    lastLobbyHost = null
    lastLobbyRev = -1
    helloAttempts = 0
    manual = null
    roomPassword = null
    helloSent.clear()
    peerToPlayer.clear()
    playerToPeer.clear()
    election = createElection(selfId, nickname, now(), 'LOBBY')
    emit()
  }

  /** 传输就绪后启动会话循环（join 与手动直连共用） */
  function activate(created: Transport): void {
    if (disposed || closed) {
      void created.leave()
      return
    }
    transport = created
    sendHello()
    // 关键：对"加入前就已经连上的 peer"补一次定向 hello。
    // 场景（v1.0.0 实测踩到）：刷新页面时新会话可能直接继承一个已建连的房间
    // （旧会话尚未释放 / Trystero 按 (appId, roomId) 复用 room），此时两端都不会再触发
    // onPeerJoin，于是谁都不再自我介绍 → 双方各自超时自任房主 → 名单永远看不到对方。
    for (const peerId of created.getPeers()) sendHello(peerId)
    if (timer) clearInterval(timer)
    timer = setInterval(runTick, tickMs)
    emit()
  }

  return {
    getView: buildView,

    async join(code: string, password?: string, asSpectator = false): Promise<void> {
      if (disposed) return
      closed = false
      spectating = asSpectator
      const normalized = normalizeRoomCode(code)
      if (!isValidRoomCode(normalized)) {
        recordError('房间码必须是 6 位（仅使用易辨识字符）')
        emit()
        return
      }
      resetForRoom(normalized)
      roomPassword = password && password.trim().length > 0 ? password.trim().slice(0, 64) : null
      const created = await options.transportFactory(handlers, roomPassword)
      if (disposed || closed) {
        // 会话已在等待期间被离开：连出来的传输必须立刻释放（否则 Trystero 的房间会被下一个会话继承）
        await created.leave()
        return
      }
      activate(created)
    },

    async startManualPairing(code: string, pairingRole: ManualRole): Promise<void> {
      if (disposed) return
      closed = false
      const normalized = normalizeRoomCode(code)
      if (!isValidRoomCode(normalized)) {
        error = '房间码必须是 6 位（仅使用易辨识字符）'
        emit()
        return
      }
      resetForRoom(normalized)
      const created = (options.manualTransportFactory ?? createManualTransport)({ role: pairingRole, handlers })
      if (disposed || closed) {
        await created.leave()
        return
      }
      activate(created)
      manualTransport = created
      manual = { role: pairingRole, code: null, phase: pairingRole === 'host' ? 'creating' : 'need-offer', error: null }

      if (pairingRole === 'host') {
        // 手动直连时角色是明确的：邀请方就是房主，不必等 3 秒
        if (election) election = { ...election, hostId: selfId, selfDeclared: true }
        role = 'host'
        lobby = lobbyFromRecords()
        maybeRestoreGame()
        broadcastLobby()
        try {
          const offerCode = await created.createOfferCode()
          if (manual) manual = { ...manual, code: offerCode, phase: 'need-answer' }
        } catch (err) {
          const message = String((err as Error)?.message ?? err)
          if (manual) manual = { ...manual, phase: 'failed', error: message }
          error = message
        }
      } else {
        role = 'client'
      }
      emit()
    },

    async submitManualCode(code: string): Promise<void> {
      const pairing = manual
      const mt = manualTransport
      if (!pairing || !mt) return
      try {
        if (pairing.role === 'guest') {
          const answerCode = await mt.acceptOfferCode(code)
          manual = { ...(manual ?? pairing), code: answerCode, phase: 'need-answer', error: null }
          notice = '把上面的应答码发回给房主，等待他粘贴'
        } else {
          await mt.acceptAnswerCode(code)
          // ⚠️ acceptAnswerCode 会一直等到数据通道打开；而通道打开的那一刻，
          // onStatus('connected') 已经把相位推进到 'connected'。
          // 所以这里必须基于**最新**状态收尾，绝不能用 await 之前的旧快照覆盖 ——
          // 否则会把 'connected' 打回 'connecting'，房主页面从房间视图退回"加入表单"且再也回不去
          // （E2E 里表现为"等待开始按钮超时 / 按钮被从 DOM 摘掉"，曾被误判为环境抖动）。
          const latest = manual ?? pairing
          if (latest.phase === 'connected') {
            manual = { ...latest, error: null }
          } else if (status === 'failed') {
            // 等通道超时：waitForOpen 会先报 'failed'，这里把相位落成失败态（而不是永远挂在"建立中"）
            manual = { ...latest, phase: 'failed', error: statusDetail }
          } else {
            manual = { ...latest, phase: 'connecting', error: null }
          }
        }
      } catch (err) {
        const message = String((err as Error)?.message ?? err)
        manual = { ...(manual ?? pairing), phase: 'failed', error: message }
        error = message
      }
      emit()
    },

    retryConnection(): void {
      const code = roomCode
      const password = roomPassword ?? undefined
      if (!code) return
      void this.leave().then(() => this.join(code, password))
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
      // ⚠️ 必须排除观战者：他们**不占对局席位**（否则会被当成参战玩家，AI/胜负/计分都算错人）
      const order = (lobby?.players ?? [])
        .filter((p) => p.connected && !p.spectator)
        .map((p) => p.playerId)
      if (order.length < 2) {
        error = '至少需要 2 名玩家才能开始'
        emit()
        return
      }
      // AI 补位：房主选了就把席位补到目标数（真人优先入座，多出来的由 AI 坐）
      const targetSlots = lobby?.aiSlotCount ?? aiSlotCount
      if (targetSlots > 0) {
        for (let seat = order.length; seat < targetSlots; seat += 1) {
          order.push(AI_SEAT_PREFIX + seat)
        }
      }
      const mapId = lobby?.mapId ?? defaultMapFor(order.length)
      game = createGame(mapId, order)
      if (election) election = electionSetPhase(election, 'DEPLOY')
      if (lobby) lobby = { ...lobby, phase: 'DEPLOY' }
      notice =
        targetSlots > 0
          ? '进入部署阶段：' + targetSlots + ' 个席位由 AI 补位，在己方部署区放置初始部队'
          : '进入部署阶段：在己方部署区放置初始部队'
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

    takeOverDisconnectedTurn(): void {
      beginTakeover()
    },

    setMap(mapId: string | null): void {
      if (!isHost() || !lobby) return
      lobby = lobbySetMapId(lobby, mapId)
      broadcastLobby()
      emit()
    },

    setAiSlots(count: number): void {
      if (!isHost() || !lobby) return
      lobby = lobbySetAiSlotCount(lobby, count)
      aiSlotCount = lobby.aiSlotCount
      // rev 由 broadcastLobby 统一 +1（这里别自己加，否则客户端会跳过一版快照）
      broadcastLobby()
      emit()
    },

    sendCommand(cmd: Command): void {
      if (!game) return
      // 观战者是只读的：不接受任何操作（连认输都不行——它本来就不在局里）
      if (spectating) {
        recordError('观战模式下不能操作')
        emit()
        return
      }
      // 提示条是"最近发生了什么"的状态行：我自己一操作，旧提示就该让位
      if (notice !== null) {
        notice = null
        emit()
      }
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
      stopTakeover()
      if (timer) clearInterval(timer)
      timer = null
      void transport?.leave()
      transport = null
    },
  }
}
