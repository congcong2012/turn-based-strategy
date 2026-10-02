/**
 * 单人练习（PVE）的本地会话：**完全不联网**。
 *
 * 与 roomSession 的关系：
 *  - 复用同一份**纯函数游戏内核**（createGame / applyCommand）；
 *  - 对外产出**同形状的 `RoomView`**，因此 `GameScreen` / `BoardCanvas` 可以原样复用；
 *  - 不注入 Transport、不做房主选举、没有大厅阶段 —— 人进来就是部署阶段。
 *
 * 权威模型沿用"房主权威"的语义，只是房主就是本机：人类指令与 AI 指令都走 applyCommand，
 * 因此 PVE 与联机跑的是同一套规则代码。
 */

import { DATA, defaultMapFor } from '../game/data'
import type { GameData } from '../game/data'
import { createGame, currentPlayer } from '../game/state'
import { applyCommand } from '../game/commands'
import { describeErrorCode } from '../game/errorText'
import { appendJournal, emptyJournal } from '../game/journal'
import type { Journal } from '../game/journal'
import { nextCommand, MAX_AI_STEPS } from '../ai'
import type { Difficulty } from '../ai'
import { hashSeed, mulberry32 } from '../ai/rng'
import type { Command, GameState, PlayerId } from '../game/types'
import type { LobbyPlayer, RoomRole, SignalStrategy, TransportKind, TransportStatus } from '../net/types'
import type { ConnectionState } from '../net/connectionState'
import type { RoomView } from '../net/roomSession'

export type PveDifficulty = Difficulty

export interface PveConfig {
  /** 对手（AI）数量：1–3，总玩家数 = opponents + 1（2–4 人） */
  opponents: number
  /** 人类占据哪个出生角（0 起）。出生角序号**同时就是出手顺序**：0 号先手 */
  humanSeat: number
  difficulty: PveDifficulty
  /** 随机种子：简单难度据此抽随机数；普通 / 困难是确定性策略。同种子 + 同配置必然可复现 */
  seed: number
}

/** 人类与 AI 的默认身份 */
export const PVE_HUMAN_ID = 'you'
const AI_PREFIX = 'ai-'
const AI_NAMES = ['电脑甲', '电脑乙', '电脑丙']

/** AI 每步之间的间隔（毫秒）：让棋盘上的动作看得出来 */
export const DEFAULT_ACTION_DELAY_MS = 450

type Scheduler = (fn: () => void, ms: number) => () => void

const defaultScheduler: Scheduler = (fn, ms) => {
  const handle = setTimeout(fn, ms)
  return () => clearTimeout(handle)
}

/** 需要落盘的最小集合：配置（含种子）+ 对局状态 + 战报 */
export interface PveSaveData {
  config: PveConfig
  state: GameState
  journal: Journal
}

/**
 * 落盘原因：
 *  - `human` / `ai`：一次成功指令（AI 的会由上层做尾部节流）
 *  - `system`：会话初始化或重开一局
 *  - `ended`：对局结束 —— 上层应当**清档**，免得下次进 #/pve 停在旧结算页
 */
export type PvePersistReason = 'human' | 'ai' | 'system' | 'ended'

/** 从存档恢复所需的全部内容 */
export type PveRestore = PveSaveData

export interface PveSessionOptions {
  /** 开新局用；与 `restore` 二选一 */
  config?: PveConfig
  /** 从存档恢复；与 `config` 二选一，优先级更高 */
  restore?: PveRestore
  humanId?: string
  humanNickname?: string
  /** 覆盖 AI 昵称（按 AI 序号 0 起）；默认"电脑甲/乙/丙" */
  aiNickname?: (ordinal: number) => string
  data?: GameData
  actionDelayMs?: number
  /** 可注入的调度器：测试可传同步实现，从而不需要 await */
  schedule?: Scheduler
  onChange?: (view: RoomView) => void
  /**
   * 需要落盘时回调。会话本身**不碰 localStorage**（注入进来才可纯单测）；
   * 节流与清档策略都由上层决定。
   */
  onPersist?: (data: PveSaveData, reason: PvePersistReason) => void
}

export interface PveSession {
  getView: () => RoomView
  /** 人类下一条指令（越权/非法指令会被拒绝并写入 error） */
  sendCommand: (cmd: Command) => void
  /** 重开一局（可局部覆盖配置，例如改难度或换出生角） */
  restart: (patch?: Partial<PveConfig>) => void
  dispose: () => void
}

/** 总玩家数收敛到 2–4（地图只有 2 人图与 4 人图） */
export function normalizeConfig(config: PveConfig): PveConfig {
  const opponents = Math.min(3, Math.max(1, Math.floor(config.opponents)))
  const total = opponents + 1
  const humanSeat = Math.min(total - 1, Math.max(0, Math.floor(config.humanSeat)))
  return { ...config, opponents, humanSeat }
}

/** 由配置推导对局参数（座位顺序即 players 数组顺序） */
export function describePveMatch(config: PveConfig, humanId = PVE_HUMAN_ID) {
  const normalized = normalizeConfig(config)
  const total = normalized.opponents + 1
  const seatIds: PlayerId[] = []
  for (let seat = 0; seat < total; seat += 1) {
    seatIds.push(seat === normalized.humanSeat ? humanId : AI_PREFIX + seat)
  }
  return {
    config: normalized,
    total,
    seatIds,
    aiSeats: seatIds.map((id, seat) => ({ id, seat })).filter((s) => s.id !== humanId),
    mapId: defaultMapFor(total),
  }
}

export function createPveSession(options: PveSessionOptions): PveSession {
  const data = options.data ?? DATA
  const humanId = options.humanId ?? PVE_HUMAN_ID
  const humanNickname = options.humanNickname ?? '你'
  const aiNickname = options.aiNickname ?? ((ordinal: number) => AI_NAMES[ordinal] ?? '电脑' + (ordinal + 1))
  const actionDelayMs = options.actionDelayMs ?? DEFAULT_ACTION_DELAY_MS
  const schedule = options.schedule ?? defaultScheduler

  if (!options.config && !options.restore) {
    throw new Error('createPveSession：必须提供 config（新开一局）或 restore（从存档恢复）')
  }

  let config = normalizeConfig(options.restore ? options.restore.config : (options.config as PveConfig))
  let match = describePveMatch(config, humanId)
  let state: GameState = options.restore
    ? options.restore.state
    : createGame(match.mapId, match.seatIds, data)
  let journal: Journal = options.restore ? options.restore.journal : emptyJournal()
  let error: string | null = null
  let disposed = false
  let lastSignature = ''

  let cancelAi: (() => void) | null = null
  let aiRunning = false
  let aiTurnPlayer: PlayerId | null = null
  let aiSteps = 0

  /** AI 在"AI 名单"里的序号（从 0 起）：决定"电脑甲/乙/丙"，与绝对座位无关 */
  function aiOrdinal(seat: number): number {
    let ordinal = 0
    for (let s = 0; s < seat; s += 1) {
      if (match.seatIds[s] !== humanId) ordinal += 1
    }
    return ordinal
  }

  function nicknameFor(seat: number): string {
    return match.seatIds[seat] === humanId ? humanNickname : aiNickname(aiOrdinal(seat))
  }

  /** 座位顺序 → LobbyPlayer（GameScreen 用 players 渲染名单与昵称） */
  function lobbyPlayers(): LobbyPlayer[] {
    return match.seatIds.map((id, seat) => ({
      playerId: id,
      nickname: nicknameFor(seat),
      ready: true,
      isHost: seat === 0,
      connected: true,
    }))
  }

  function nameOfPlayer(playerId: PlayerId): string {
    if (playerId === humanId) return humanNickname
    const seat = match.seatIds.indexOf(playerId)
    return seat >= 0 ? nicknameFor(seat) : playerId
  }

  /**
   * 用函数读取阶段，避免 TS 把 state.phase 窄化后误判：
   * apply() 会整体替换 state 对象，但 TS 的收窄分析看不到这一点。
   */
  function phaseOf(): GameState['phase'] {
    return state.phase
  }

  function buildView(): RoomView {
    const players = lobbyPlayers()
    const role: RoomRole = 'host'
    const status: TransportStatus = 'connected'
    const kind: TransportKind = 'local'
    const strategy: SignalStrategy = 'mqtt'
    const connection: ConnectionState = 'connected'

    return {
      status,
      statusDetail: null,
      kind,
      strategy,
      role,
      roomCode: null,
      selfId: humanId,
      nickname: humanNickname,
      ready: true,
      players,
      // 单人没有"等人齐"的概念，大厅相关字段恒为 false/空
      canStart: false,
      isHost: true,
      hostNickname: humanNickname,
      notice: null,
      error,
      peerCount: 0,
      game: state,
      mapId: match.mapId,
      passwordEnabled: false,
      connection,
      transportStatus: status,
      transportDetail: null,
      manual: null,
      errors: [],
      myTurn: state.phase === 'PLAYING' && currentPlayer(state) === humanId,
      paused: false,
      pausedReason: 'none',
      canSkipTurn: false,
      offlinePlayers: [],
      log: journal.log,
      events: journal.events,
    }
  }

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

  /** 落盘（由上层做节流与清档） */
  function persist(reason: PvePersistReason): void {
    options.onPersist?.({ config, state, journal }, reason)
  }

  /** 应用一条指令（AI 与人类共用）：保证 state 只在 ok 时才推进 */
  function apply(playerId: PlayerId, cmd: Command, reason: PvePersistReason): boolean {
    const before = state
    const result = applyCommand(state, playerId, cmd, data)
    if (!result.ok) {
      error = describeErrorCode(result.code)
      return false
    }
    state = result.state
    journal = appendJournal(journal, result.events, before, state, nameOfPlayer)
    error = null
    // 终局不落盘：上层收到 'ended' 会清档，免得下次进 #/pve 停在旧的结算页
    persist(state.phase === 'GAME_OVER' ? 'ended' : reason)
    return true
  }

  /** 部署阶段：把所有未确认的 AI 一次性部署完（不需要等待，界面直接刷新） */
  function pumpDeploy(): void {
    let guard = 0
    while (!disposed && state.phase === 'DEPLOY' && guard < 300) {
      const pendingSeat = match.aiSeats.find((s) => !state.deploy[s.id]?.done)
      if (!pendingSeat) break
      const cmd = nextCommand(state, pendingSeat.id, config.difficulty, data, aiRng(pendingSeat.id))
      if (!apply(pendingSeat.id, cmd, 'ai')) break
      guard += 1
    }
  }

  /**
   * AI 的随机数：**无状态派生**，每次决策都按"种子 + 当前局面 + 谁在决策"现算一个生成器。
   *
   * 为什么不用"开局建一次、整局复用同一个生成器"：那种写法的内部游标没法序列化，
   * 一旦刷新页面恢复对局，AI 会从随机数序列的头部重来，走出与刷新前不同的分支。
   * 改成纯函数派生后，同一个 (种子, 局面) 必然得到同一个决策 —— 刷新前后逐帧一致。
   */
  function aiRng(playerId: PlayerId): () => number {
    return mulberry32(
      hashSeed(config.seed, state.rev, state.turnSeq, state.turnIndex, playerId, config.difficulty),
    )
  }

  /** 行动阶段：AI 走一步，然后（若还轮到 AI）继续排程 */
  function stepAi(): void {
    if (disposed) return

    if (state.phase === 'DEPLOY') {
      pumpDeploy()
      emit()
      return
    }

    if (state.phase !== 'PLAYING') {
      aiTurnPlayer = null
      aiSteps = 0
      emit()
      return
    }

    const actor = currentPlayer(state)
    if (actor === humanId) {
      // 轮到人类了：停止 AI 链
      aiTurnPlayer = null
      aiSteps = 0
      emit()
      return
    }

    if (actor !== aiTurnPlayer) {
      aiTurnPlayer = actor
      aiSteps = 0
    }

    if (aiSteps >= MAX_AI_STEPS) {
      // 兜底：绝不死循环，强制结束该 AI 的回合
      apply(actor, { type: 'endTurn' }, 'ai')
      aiSteps = 0
      emit()
      scheduleAi()
      return
    }

    const cmd = nextCommand(state, actor, config.difficulty, data, aiRng(actor))
    aiSteps += 1
    apply(actor, cmd, 'ai')
    emit()

    if (cmd.type === 'endTurn' || phaseOf() === 'GAME_OVER') {
      aiSteps = 0
      scheduleAi()
      return
    }
    scheduleAi()
  }

  function scheduleAi(): void {
    if (disposed || aiRunning) return
    if (phaseOf() === 'GAME_OVER') return
    aiRunning = true
    cancelAi = schedule(() => {
      aiRunning = false
      stepAi()
    }, actionDelayMs)
  }

  /** 人类操作之后：决定谁来继续推进 */
  function advanceAfterHuman(): void {
    if (state.phase === 'DEPLOY') {
      pumpDeploy()
      emit()
      return
    }
    if (state.phase === 'PLAYING' && currentPlayer(state) !== humanId) scheduleAi()
    emit()
  }

  function sendCommand(cmd: Command): void {
    if (disposed) return
    if (state.phase === 'GAME_OVER' && cmd.type !== 'resign') return
    if (!apply(humanId, cmd, 'human')) {
      emit()
      return
    }
    advanceAfterHuman()
  }

  function restart(patch?: Partial<PveConfig>): void {
    if (disposed) return
    if (cancelAi) {
      cancelAi()
      cancelAi = null
    }
    aiRunning = false
    aiTurnPlayer = null
    aiSteps = 0

    config = normalizeConfig({ ...config, ...patch })
    match = describePveMatch(config, humanId)
    state = createGame(match.mapId, match.seatIds, data)
    journal = emptyJournal()
    error = null
    lastSignature = ''

    if (state.phase === 'DEPLOY') pumpDeploy()
    scheduleAi()
    persist('system')
    emit()
  }

  function dispose(): void {
    disposed = true
    if (cancelAi) {
      cancelAi()
      cancelAi = null
    }
  }

  /**
   * 把 AI 链重新拉起来。`setTimeout` 活不过页面刷新，所以从存档恢复时
   * 必须重新排程，否则会卡在"轮到 AI 但没人动"的假死状态。
   */
  function resumeScheduling(): void {
    if (state.phase === 'DEPLOY') {
      pumpDeploy()
      persist('system')
      return
    }
    if (state.phase === 'PLAYING' && currentPlayer(state) !== humanId) scheduleAi()
  }

  if (options.restore) {
    resumeScheduling()
  } else if (state.phase === 'DEPLOY') {
    pumpDeploy()
    persist('system')
  }

  return {
    getView: buildView,
    sendCommand,
    restart,
    dispose,
  }
}
