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
import { nextCommand, MAX_AI_STEPS } from '../ai'
import type { Difficulty } from '../ai'
import { mulberry32 } from '../ai/rng'
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
  /** 随机种子：决定"简单"难度的行为，保证同种子可复现 */
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

export interface PveSessionOptions {
  config: PveConfig
  humanId?: string
  humanNickname?: string
  /** 覆盖 AI 昵称（按 AI 序号 0 起）；默认"电脑甲/乙/丙" */
  aiNickname?: (ordinal: number) => string
  data?: GameData
  actionDelayMs?: number
  /** 可注入的调度器：测试可传同步实现，从而不需要 await */
  schedule?: Scheduler
  onChange?: (view: RoomView) => void
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

  let config = normalizeConfig(options.config)
  let match = describePveMatch(config, humanId)
  let state: GameState = createGame(match.mapId, match.seatIds, data)
  let journal = emptyJournal()
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

  /** 应用一条指令（AI 与人类共用）：保证 state 只在 ok 时才推进 */
  function apply(playerId: PlayerId, cmd: Command): boolean {
    const before = state
    const result = applyCommand(state, playerId, cmd, data)
    if (!result.ok) {
      error = describeErrorCode(result.code)
      return false
    }
    state = result.state
    journal = appendJournal(journal, result.events, before, state, nameOfPlayer)
    error = null
    return true
  }

  /** 部署阶段：把所有未确认的 AI 一次性部署完（不需要等待，界面直接刷新） */
  function pumpDeploy(): void {
    let guard = 0
    while (!disposed && state.phase === 'DEPLOY' && guard < 300) {
      const pendingSeat = match.aiSeats.find((s) => !state.deploy[s.id]?.done)
      if (!pendingSeat) break
      const cmd = nextCommand(state, pendingSeat.id, config.difficulty, data, aiRng())
      if (!apply(pendingSeat.id, cmd)) break
      guard += 1
    }
  }

  let aiRandom: (() => number) | null = null
  function aiRng(): () => number {
    if (aiRandom === null) aiRandom = mulberry32(config.seed)
    return aiRandom
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
      apply(actor, { type: 'endTurn' })
      aiSteps = 0
      emit()
      scheduleAi()
      return
    }

    const cmd = nextCommand(state, actor, config.difficulty, data, aiRng())
    aiSteps += 1
    apply(actor, cmd)
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
    if (!apply(humanId, cmd)) {
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
    aiRandom = null

    config = normalizeConfig({ ...config, ...patch })
    match = describePveMatch(config, humanId)
    state = createGame(match.mapId, match.seatIds, data)
    journal = emptyJournal()
    error = null
    lastSignature = ''

    if (state.phase === 'DEPLOY') pumpDeploy()
    scheduleAi()
    emit()
  }

  function dispose(): void {
    disposed = true
    if (cancelAi) {
      cancelAi()
      cancelAi = null
    }
  }

  // 开局：人类不是 0 号座位时，AI 先部署/先行动
  if (state.phase === 'DEPLOY') pumpDeploy()

  return {
    getView: buildView,
    sendCommand,
    restart,
    dispose,
  }
}
