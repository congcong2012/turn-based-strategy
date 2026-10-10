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

import { DATA, defaultMapFor, getMap, hasMap } from '../game/data'
import type { GameData } from '../game/data'
import { createGame, currentPlayer } from '../game/state'
import { applyCommand } from '../game/commands'
import { describeErrorCode } from '../game/errorText'
import { appendJournal, emptyJournal } from '../game/journal'
import type { Journal } from '../game/journal'
import { nextCommand, nextCommandWith, MAX_AI_STEPS } from '../ai'
import type { AiProfile, Difficulty } from '../ai'
import { hashSeed, mulberry32 } from '../ai/rng'
import type { AiTask } from '../ai/workerProtocol'
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
  /**
   * 指定用哪张地图（可选）。留空 = 按人数自动挑内置地图。
   * 可以是**自制地图**（id 形如 `user_*`）；席位不够（部署区少于玩家数）时会自动回退。
   */
  mapId?: string
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

/** 区分"同步返回的指令"与"异步（Worker）返回的指令" */
function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === 'function'
}

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

/**
 * "AI 思考"的可注入实现。
 * 同步实现 = 主线程直接算（默认）；异步实现 = 送到 Web Worker。
 * 两种实现的**入参相同、结果必然相同**（`nextCommand` 是纯函数）。
 */
export type AiThinker = (task: AiTask) => Command | Promise<Command>

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
  /**
   * 可注入的"AI 思考"实现。**默认在主线程同步计算**（与改造前逐字一致），
   * 真实应用由 `usePveGame` 注入 Web Worker 版本。
   *
   * 之所以把默认值留在主线程：单测与评估台大量依赖"调用后立刻可见"的同步语义；
   * 而 Worker 只是把**同样的纯函数计算**挪到另一个线程，结果不会变。
   * 返回 Promise 时，本会话会等它回来再推进（并在等待期间丢弃过期结果）。
   */
  aiThink?: AiThinker
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

/**
 * 由配置推导对局参数（座位顺序即 players 数组顺序）。
 *
 * `mapId` 的优先级：配置里显式指定的地图（含**自制地图**）→ 按人数自动挑内置地图。
 * 指定的地图必须"席位够用"（`deployZones.length >= total`），否则回退到自动挑，
 * 免得选了 2 人图却开 4 人局，导致后两名玩家没有部署区。
 */
export function describePveMatch(config: PveConfig, humanId = PVE_HUMAN_ID, data: GameData = DATA) {
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
    mapId: resolveMapId(normalized.mapId, total, data),
  }
}

/** 选地图：显式指定且席位够用就用它，否则按人数自动挑 */
export function resolveMapId(requested: string | undefined, total: number, data: GameData = DATA): string {
  if (requested && hasMap(requested, data) && getMap(requested, data).deployZones.length >= total) {
    return requested
  }
  const fallback = defaultMapFor(total)
  return hasMap(fallback, data) ? fallback : Object.keys(data.maps)[0]
}

export function createPveSession(options: PveSessionOptions): PveSession {
  const data = options.data ?? DATA
  const humanId = options.humanId ?? PVE_HUMAN_ID
  const humanNickname = options.humanNickname ?? '你'
  const aiNickname = options.aiNickname ?? ((ordinal: number) => AI_NAMES[ordinal] ?? '电脑' + (ordinal + 1))
  const actionDelayMs = options.actionDelayMs ?? DEFAULT_ACTION_DELAY_MS
  const schedule = options.schedule ?? defaultScheduler
  /** 如果走 Worker，这里存着"在途的那次思考"，用来丢弃过期结果 */
  let pendingThink: Promise<Command> | null = null

  /**
   * 部署阶段被"AI 先行闸门"排队的人类指令 —— 等 AI 部署完再按序重放。
   *
   * 只在"部署阶段 + 异步 AI 思考在途"这个窗口里会被用到；
   * 同步路径（默认主线程 AI）永远不会进这里，因此**改造前行为零变化**。
   */
  const deferredHumanCommands: Command[] = []
  /** 防重入旗标：见 `drainDeferredHumanCommands` 的注释 */
  let draining = false

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
      // 单人练习的对手本来就是 AI（它们直接在 match.seatIds 里），不存在"补位"概念
      aiSlotCount: 0,
      // 单人练习的对手本来就是 AI，没有"按房间配 AI 档"这回事（难度在 config.difficulty 里）
      aiDifficulty: config.difficulty,
      spectating: false,
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
      canTakeOver: false,
      takeoverPlayerId: null,
      offlinePlayers: [],
      log: journal.log,
      rounds: journal.rounds,
      fullLog: journal.fullLog,
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

  /**
   * 部署阶段：把所有未确认的 AI 依次部署完。
   *
   * ⚠️ **已改造为走 `think`（可能异步）** —— 因为 LLM 参谋在部署阶段也要给一次倾向。
   *
   * 两条路径，**同步那条与改造前逐字一致**：
   *
   * - **同步 `think`**（默认主线程实现）：保持原来的 `while` 循环语义 —— 一口气把所有
   *   AI 席位部署完，循环内**不 emit**（调用方负责在末尾 emit）。这样"构造阶段不回调
   *   onChange"等既有契约原样成立。
   * - **异步 `think`**（Worker / LLM 参谋）：一次只推进一步，由 Promise 回调续推下一个席位。
   *   途中把 `aiRunning` 置位，避免与 `stepAi` 的排程互相打架。
   *
   * 为什么异步时不能继续用 `while`：`while` 里拿到的是待定的 Promise，`apply` 无从下手；
   * 且"发出请求即返回"意味着循环必须由回调驱动。
   *
   * 兜底：`think` 抛错时**退回默认实现**（主线程按难度直接算）——
   * 部署阶段绝不能因为"参谋炸了"而把整局卡死；退回默认实现恰恰就是"没开参谋"的行为。
   */
  function pumpDeploy(): void {
    if (disposed || state.phase !== 'DEPLOY') return

    // ── 同步快路径：与改造前的 while 循环逐字一致 ────────────────────────
    // 先探一次：若 think 同步返回，就整段跑完（不 emit，交给调用方）
    let guard = 0
    while (!disposed && state.phase === 'DEPLOY' && guard < 300) {
      const pendingSeat = match.aiSeats.find((s) => !state.deploy[s.id]?.done)
      if (!pendingSeat) break

      const actor = pendingSeat.id
      let result: Command | Promise<Command>
      try {
        result = think(aiTaskFor(actor))
      } catch {
        // 思考抛错（例如参谋层/Worker 出问题）：退回默认实现 ——
        // 这正是"没开参谋"的行为，保证部署一定能走完。
        result = defaultAiThink(aiTaskFor(actor))
      }

      if (isPromiseLike(result)) {
        // ── 命中异步：交给回调续推（下面的 while 立刻退出） ──────────────
        const rev = state.rev
        aiRunning = true
        pendingThink = result
        result.then(
          (cmd) => {
            if (pendingThink !== result) return // 已被 dispose / 重开作废
            pendingThink = null
            aiRunning = false
            if (disposed) return
            if (state.rev !== rev || state.phase !== 'DEPLOY') {
              // 等待期间局面变了（人类确认部署 / 重开…）：这一步作废，交还给当前该动的人
              if (state.phase === 'DEPLOY') pumpDeploy()
              emit()
              return
            }
            apply(actor, cmd, 'ai')
            emit()
            // 继续推进下一个 AI 的部署；若已全部部署完，放行被闸门拦下的人类指令
            if (state.phase === 'DEPLOY') pumpDeploy()
            else nudgeDeferredIfIdle()
          },
          () => {
            if (pendingThink !== result) return
            pendingThink = null
            aiRunning = false
            // 失败静默：这个席位退回默认实现部署（绝不死循环重试，也绝不卡死整局）
            if (disposed) return
            if (state.phase === 'DEPLOY') {
              const seat = match.aiSeats.find((s) => !state.deploy[s.id]?.done)
              if (seat) apply(seat.id, defaultAiThink(aiTaskFor(seat.id)), 'ai')
            }
            emit()
            if (state.phase === 'DEPLOY') pumpDeploy()
            else nudgeDeferredIfIdle()
          },
        )
        return
      }

      if (!apply(actor, result, 'ai')) break
      guard += 1
    }

    // ── AI 部署已全部完成：放行被闸门拦下的人类指令 ──────────────────────
    // 注意判据是"还有没有待部署的 AI 席位"，**不是** `phase !== 'DEPLOY'` ——
    // AI 部署完时人类可能还没部署，phase 仍是 DEPLOY，但闸门此时就该开了。
    // 同步路径下队列恒为空 ⇒ 这一步是无操作，改造前行为零变化。
    nudgeDeferredIfIdle()
  }

  /** AI 部署已收尾（没有未完成席位、也没有在途思考）时，放行被拦下的人类指令 */
  function nudgeDeferredIfIdle(): void {
    if (disposed || aiRunning) return
    if (match.aiSeats.some((s) => !state.deploy[s.id]?.done)) return
    drainDeferredHumanCommands()
  }

  /**
   * AI 的随机数种子：**无状态派生**，每次决策都按"种子 + 当前局面 + 谁在决策"现算。
   *
   * 为什么不用"开局建一次、整局复用同一个生成器"：那种写法的内部游标没法序列化，
   * 一旦刷新页面恢复对局，AI 会从随机数序列的头部重来，走出与刷新前不同的分支。
   * 改成纯函数派生后，同一个 (种子, 局面) 必然得到同一个决策 —— 刷新前后逐帧一致。
   *
   * 抽成 `aiSeed` 是为了跨线程：**函数没法 structured-clone，种子可以** ——
   * Worker 侧用同一个种子还原出逐位相同的随机序列。
   */
  function aiSeed(playerId: PlayerId): number {
    return hashSeed(config.seed, state.rev, state.turnSeq, state.turnIndex, playerId, config.difficulty)
  }

  // 注：这里曾经有个 `aiRng(playerId)`，供 `pumpDeploy` 的同步 while 循环直接建 RNG。
  // 部署阶段改为走 `think` 之后，随机数由 `defaultAiThink` 一律用 `mulberry32(task.seed)`
  // 现造 —— 与 `stepAi` 完全同源（同一粒种子、同一构造方式），因此该函数已被移除。
  // 保留 `aiSeed` 是因为它仍是**跨线程载荷**（Worker 侧要拿它还原随机序列）。

  /**
   * 组装一次"AI 思考"任务（默认实现与 Worker 实现用的是同一份入参）。
   *
   * `profile` 可选：由 LLM 参谋层（`withAdvisor`）在**装饰 `think` 时**注入。
   * **不传时任务里没有这个字段** —— 于是 `defaultAiThink` / `handleAiRequest`
   * 都走"按难度取档"的老路，与改造前逐字一致。
   */
  function aiTaskFor(playerId: PlayerId, profile?: AiProfile): AiTask {
    const task: AiTask = {
      state,
      playerId,
      difficulty: config.difficulty,
      seed: aiSeed(playerId),
      map: getMap(state.mapId, data),
    }
    if (profile) task.profile = profile
    return task
  }

  /**
   * 默认实现：主线程同步计算（与加 Worker 之前逐字一致）。
   *
   * 有 `profile` 时改用 `nextCommandWith`（同样的纯函数，只是档案由外部给定）；
   * 没有时调用 `nextCommand` —— **两条路径共用同一个 `mulberry32(task.seed)`**，
   * 因此"参谋只改档案、不改随机数"这条承诺在代码里是显式的。
   */
  function defaultAiThink(task: AiTask): Command {
    const random = mulberry32(task.seed)
    return task.profile
      ? nextCommandWith(task.state, task.playerId, task.profile, data, random)
      : nextCommand(task.state, task.playerId, task.difficulty, data, random)
  }

  const think: AiThinker = options.aiThink ?? defaultAiThink

  /** 该 AI 的回合走不动了（思考抛错/失败）时的兜底：交出手，别把整局卡死 */
  function abortAiTurn(actor: PlayerId): void {
    apply(actor, { type: 'endTurn' }, 'ai')
    aiSteps = 0
    emit()
    scheduleAi()
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

    // 记下"请求发出时"的局面版本：Worker 是异步的，回来时局面可能已经变了
    const rev = state.rev
    let result: Command | Promise<Command>
    try {
      result = think(aiTaskFor(actor))
    } catch {
      // 连思考都抛错（例如地图数据异常）：结束这个 AI 的回合，别把整局卡死
      abortAiTurn(actor)
      return
    }

    if (isPromiseLike(result)) {
      // 等 Worker 期间不再排程（复用 aiRunning 这个"已有在途推进"的开关）
      aiRunning = true
      pendingThink = result
      result.then(
        (cmd) => {
          if (pendingThink !== result) return // 已被 dispose / 重开作废
          pendingThink = null
          aiRunning = false
          if (disposed) return
          if (state.rev !== rev || state.phase !== 'PLAYING') {
            // 等待期间局面变了（人类认输/退出/重开…）：这次的指令作废，
            // 但要把 AI 链交还给"现在该动的人"，否则会停在假死状态。
            if (state.phase === 'PLAYING' && currentPlayer(state) !== humanId) scheduleAi()
            return
          }
          finishAiStep(actor, cmd)
        },
        () => {
          if (pendingThink !== result) return
          pendingThink = null
          aiRunning = false
          if (disposed || state.rev !== rev) return
          abortAiTurn(actor)
        },
      )
      return
    }

    finishAiStep(actor, result)
  }

  /** 拿到 AI 的指令之后：落子、广播、继续排程 */
  function finishAiStep(actor: PlayerId, cmd: Command): void {
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

    // ── 部署阶段的"AI 先行闸门" ────────────────────────────────────────
    // 保持"所有 AI 先部署完，人类再落子"这条**顺序不变量**：
    // 改造前 `pumpDeploy` 是同步的，构造期间就把 AI 部署完了，因此人类指令必然排在其后；
    // 走异步 `think` 后 AI 的部署会延迟到回调，若不拦，人类就会"插队"，
    // 导致 state.rev 序列不同 ⇒ 后续 AI 决策的派生种子不同 ⇒ 与同步路径分叉。
    // 故：只要还有 AI 未部署完（且正有在途思考），就把人类**部署类**指令排队，
    // 等 AI 部署收尾后按原顺序重放。
    //
    // ⚠️ `resign` 是控制类指令，**绝不排队** —— 认输必须立刻生效，
    // 否则"等待期间人类认输"的语义会被破坏（迟到的 AI 部署会污染已结束的局面）。
    if (state.phase === 'DEPLOY' && cmd.type !== 'resign' && aiRunning && pendingThink !== null) {
      deferredHumanCommands.push(cmd)
      return
    }

    if (!apply(humanId, cmd, 'human')) {
      emit()
      return
    }
    advanceAfterHuman()
  }

  /**
   * 部署阶段被"AI 先行闸门"排队的人类指令 —— 等 AI 部署完再按序重放。
   * （队列本体在最上面声明；这里只放放行函数。）
   *
   * ⚠️ **必须防重入**：`advanceAfterHuman()` 会调 `pumpDeploy()`，后者收尾时又会
   * 调 `nudgeDeferredIfIdle()` → 回到本函数。若不防重入，外层 `while` 的 `shift()`
   * 会与内层递归交错，导致"只重放了一条"这种诡异结果。
   * 用 `draining` 旗标：只有最外层那次真正在驱动队列。
   */
  function drainDeferredHumanCommands(): void {
    if (draining) return
    draining = true
    try {
      while (deferredHumanCommands.length > 0 && !disposed) {
        // 又出现了新的在途 AI 思考（例如人类部署触发了 AI 排程）：交给它，稍后再放行
        if (aiRunning) return
        const cmd = deferredHumanCommands.shift() as Command
        if (state.phase === 'GAME_OVER' && cmd.type !== 'resign') continue
        if (!apply(humanId, cmd, 'human')) {
          emit()
          continue
        }
        advanceAfterHuman()
      }
    } finally {
      draining = false
    }
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
    pendingThink = null // 在途的思考作废（重开一局后旧局面的指令不能落子）

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
    pendingThink = null
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
