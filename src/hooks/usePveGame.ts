/**
 * 单人练习（PVE）的 React 接线。
 *
 * 它把本地会话（pveSession）包装成与联机**完全相同的** `{ view, actions }` 形状，
 * 于是 `GameScreen` 不需要为单人模式写第二套逻辑 —— 只是少了一些联网片段（由 mode="pve" 门控）。
 *
 * 两条会话创建路径：
 *  1. `start()`：用户在设置页点「开始对局」（而不是挂载时创建，避开 StrictMode 双挂载凭空开一局）；
 *  2. **恢复**：进入 `#/pve` 时若本地有未完成的存档，直接接着打（联机侧"刷新即回到原局"的同款语义）。
 *
 * 落盘策略（详见 `app/pveStore.ts`）：
 *  - 人类操作与系统事件立即写；
 *  - AI 步进做 250ms 尾部节流（AI 决策是状态的纯函数，丢掉的尾部步会在恢复后重放，安全）；
 *  - 页面隐藏/卸载时补一次 flush；
 *  - **只有"退出对局"才清档**，刷新与关标签页都不清。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPveSession } from '../app/pveSession'
import type { AiThinker, PveConfig, PvePersistReason, PveSaveData, PveSession } from '../app/pveSession'
import { createAiWorkerClient } from '../ai/workerClient'
import type { AiWorkerClient } from '../ai/workerClient'
import { withAdvisor } from '../ai/advisor'
import type { AdvisorStatus } from '../ai/advisor'
import { isAdvisorUsable, loadAdvisorSettings } from '../ai/advisor/settings'
import { PVE_SAVE_VERSION, clearPve, loadPve, savePve } from '../app/pveStore'
import { defaultStorage } from '../net/gameStore'
import type { RoomActions } from './useRoom'
import type { RoomView } from '../net/roomSession'

/** AI 步进的落盘节流窗口：一回合最多 40 步，逐步写会把 localStorage 打爆 */
const PERSIST_THROTTLE_MS = 250

export interface UsePveGameOptions {
  onExit?: () => void
  /** 是否允许"进入 #/pve 时自动恢复存档"。由 App 传 `route.page === 'pve'` */
  resumeWhen?: boolean
}

export interface UsePveGameResult {
  active: boolean
  /** 未开局时为 null */
  view: RoomView | null
  actions: RoomActions
  config: PveConfig | null
  /**
   * 最近一次参谋结果（对局内 HUD 用）。未开启参谋时恒为 null ——
   * 因此"关闭时零变化"这条不变量在渲染层同样成立。
   */
  advisorStatus: AdvisorStatus | null
  /** 正在从存档恢复（首帧占位，避免闪一下设置页） */
  resuming: boolean
  start: (config: PveConfig) => void
  restart: () => void
  exit: () => void
}

/** TS 允许"参数更少"的函数赋值给参数更多的函数类型，因此一个空实现可以填满所有回调 */
const noop = (): void => {}

export function usePveGame(options: UsePveGameOptions = {}): UsePveGameResult {
  const { resumeWhen = false } = options
  const onExitRef = useRef(options.onExit)
  onExitRef.current = options.onExit

  const sessionRef = useRef<PveSession | null>(null)
  const [view, setView] = useState<RoomView | null>(null)
  const [config, setConfig] = useState<PveConfig | null>(null)
  // 首帧就同步读一次存档：这样 `resuming` 在第一帧就是正确的，不会先闪设置页
  const [hasSave, setHasSave] = useState(() => loadPve() !== null)

  const disposeSession = useCallback(() => {
    sessionRef.current?.dispose()
    sessionRef.current = null
  }, [])

  /**
   * AI 计算的执行者：真实应用走 **Web Worker**（单人局的 AI 思考不占主线程），
   * 会话本身仍保留"主线程同步计算"作为默认实现，因此既有单测与评估台不受影响。
   *
   * 懒创建：在线对战根本不会实例化它，也不会起线程。
   */
  const aiClientRef = useRef<AiWorkerClient | null>(null)
  /** 退化到主线程的原因（正常情况下为 null；用于 DEV/E2E 断言与排查） */
  const aiFallbackRef = useRef<string | null>(null)
  /** 最近一次参谋工作结果（仅供 HUD / 观测；没有参谋时恒为 null） */
  const advisorStatusRef = useRef<AdvisorStatus | null>(null)
  /**
   * 参谋状态的可渲染副本。
   *
   * 为什么既要 ref 又要 state：ref 给 DEV/E2E 观测（`__atPve.advisorStatus()`），
   * state 给对局内的「军师提示」用。**只在"回合级结果变化"时更新**：
   * 同一回合内每一步都会回调一次 `onStatus`，但 `plan` 是同一个对象（回合缓存），
   * 因此这里的 `prev.plan === next.plan` 判断会让 React 直接 bail out，不会每步重渲染。
   */
  const [advisorStatus, setAdvisorStatus] = useState<AdvisorStatus | null>(null)
  /** 参谋包装器：与 Worker 客户端同生命周期，只装配一次 */
  const advisorWrappedRef = useRef<AiThinker | null>(null)

  /**
   * ★ 每开一局都必须**重新装配**参谋层。
   *
   * `withAdvisor` 在装配时读一次设置（"一局之内配置稳定"是刻意设计），
   * 于是这个 ref 一旦建立，就会把**当时**的设置一路沿用下去。
   * 不重置的后果是真实踩到的 bug（2026-10-17 用户反馈"开了参谋但 API 没收到任何请求"）：
   *
   *   先不开参谋打一局 → 退出 → 开启参谋再开一局
   *   ⇒ 参谋层仍是"关闭"的那个实例，**一个请求都不会发**。
   *      而 `advisorEnabled()` 是现读 localStorage，所以它显示 `true`，
   *      排查时极具迷惑性（看着是开的，实际这条链根本没接上）。
   *
   * 顺带修掉一个同源问题：缓存 Map 也活在包装器闭包里，
   * 不重置会让上一局的 `playerId:round:turnIndex:phase`（尤其 `0:0:DEPLOY`）
   * 命中共键，把上一局的倾向复用进新的一局。
   */
  const resetAdvisor = useCallback(() => {
    advisorWrappedRef.current = null
    advisorStatusRef.current = null
    setAdvisorStatus(null)
  }, [])

  /**
   * AI 思考的执行链：**参谋（可选）→ Worker → 主线程**。
   *
   * 层次与职责：
   *   1. `withAdvisor`：读设置，若启用就向 LLM 要一次"作战倾向"，
   *      翻成 `AiProfile` 覆盖层塞进 task。**未启用时原样透传**，因此这一层可以
   *      无条件加上去，行为与没有它时逐字一致。
   *   2. `createAiWorkerClient`：把（可能已被参谋改过档案的）task 送到 Worker 算。
   *
   * ⚠️ 设置由 `withAdvisor` 在**装配时**读一次：一局之内参谋配置稳定。
   *    因此**换局时必须调 `resetAdvisor()`**（`start` / `restart` / 恢复存档三处都调了），
   *    否则沿用上一局的旧设置 —— 见 `resetAdvisor` 的注释。
   */
  const aiThink = useCallback<AiThinker>((task) => {
    if (!aiClientRef.current) {
      aiClientRef.current = createAiWorkerClient({
        onFallback: (reason) => {
          aiFallbackRef.current = reason
        },
      })
    }
    if (!advisorWrappedRef.current) {
      const client = aiClientRef.current
      advisorWrappedRef.current = withAdvisor((t) => client.think(t), {
        settings: loadAdvisorSettings(),
        onStatus: (status) => {
          advisorStatusRef.current = status
          // 同回合内 plan 是同一个对象 ⇒ 引用相同就原样返回，React 不会重渲染
          setAdvisorStatus((prev) =>
            prev && prev.result === status.result && prev.plan === status.plan ? prev : status,
          )
        },
      })
    }
    return advisorWrappedRef.current(task)
  }, [])

  /**
   * DEV/E2E：暴露"AI 到底跑在哪"。
   *
   * 为什么必须有这条断言：Worker 是**失败即静默回退**的（起不来的环境改用主线程算，
   * 结果一样所以游戏照常能玩）。没有这个观测点，打包配置写错导致 Worker 从来没生效
   * 也不会有任何症状 —— 只有这里能把它揪出来。
   */
  useEffect(() => {
    const debugEnabled = import.meta.env.DEV || new URLSearchParams(window.location.search).has('debug')
    if (!debugEnabled) return
    ;(globalThis as Record<string, unknown>).__atPve = {
      aiTransport: () => (aiClientRef.current?.usingWorker() ? 'worker' : 'main'),
      aiFallback: () => aiFallbackRef.current,
      aiWorkerStarted: () => aiClientRef.current !== null,
      // 参谋观测点：是否启用、最近一次结果（'none' | 'ok' | 'fallback'）、以及拿到的计划
      advisorEnabled: () => isAdvisorUsable(loadAdvisorSettings()),
      advisorStatus: () => advisorStatusRef.current,
    }
  }, [])

  // 卸载时释放（含 StrictMode 的重复挂载）
  useEffect(() => {
    return () => {
      disposeSession()
      aiClientRef.current?.dispose()
      aiClientRef.current = null
    }
  }, [disposeSession])

  // ---------------------------------------------------------------- 落盘

  const pendingRef = useRef<PveSaveData | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback((data?: PveSaveData) => {
    const payload = data ?? pendingRef.current
    if (!payload) return
    pendingRef.current = null
    savePve(defaultStorage(), {
      version: PVE_SAVE_VERSION,
      savedAt: Date.now(),
      config: payload.config,
      state: payload.state,
      journal: payload.journal,
    })
  }, [])

  const persist = useCallback(
    (data: PveSaveData, reason: PvePersistReason) => {
      // 终局：清档而不是写档，避免下次进 #/pve 停在旧的结算页
      if (reason === 'ended') {
        pendingRef.current = null
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        clearPve(defaultStorage())
        return
      }
      if (reason === 'ai') {
        // AI 连走：尾部节流，只在安静下来后写一次
        pendingRef.current = data
        if (timerRef.current === null) {
          timerRef.current = setTimeout(() => {
            timerRef.current = null
            flush()
          }, PERSIST_THROTTLE_MS)
        }
        return
      }
      flush(data)
    },
    [flush],
  )

  // 页面隐藏/卸载时把节流窗口里没来得及写的那一次补上
  useEffect(() => {
    const onHide = (): void => flush()
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onHide)
      flush()
    }
  }, [flush])

  // ---------------------------------------------------------------- 恢复

  useEffect(() => {
    if (!resumeWhen || sessionRef.current) return
    const snapshot = loadPve()
    if (!snapshot) {
      setHasSave(false)
      return
    }
    // 从存档恢复也是"新的一局"：按当前设置重新装配参谋层
    resetAdvisor()
    const session = createPveSession({
      restore: { config: snapshot.config, state: snapshot.state, journal: snapshot.journal },
      aiThink,
      onChange: setView,
      onPersist: persist,
    })
    sessionRef.current = session
    setConfig(snapshot.config)
    setView(session.getView())
    setHasSave(false)
  }, [resumeWhen, persist, aiThink, resetAdvisor])

  // ---------------------------------------------------------------- 生命周期

  const start = useCallback(
    (next: PveConfig) => {
      disposeSession()
      // ★ 换局必须重新装配参谋层（否则沿用上一局的旧设置，见 resetAdvisor 注释）。
      //   注意要放在 createPveSession 之前：构造函数的 pumpDeploy 会立刻走一次 think。
      resetAdvisor()
      const session = createPveSession({ config: next, aiThink, onChange: setView, onPersist: persist })
      sessionRef.current = session
      setConfig(next)
      setView(session.getView())
      setHasSave(false)
    },
    [disposeSession, persist, aiThink, resetAdvisor],
  )

  const restart = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    // 再来一局同样是新的一局：重置参谋层（同时也清掉上一局的回合缓存）
    resetAdvisor()
    session.restart()
    setView(session.getView())
  }, [resetAdvisor])

  const exit = useCallback(() => {
    // 先取消待写的节流，再清档 —— 否则刚清掉的档会被挂起的 flush 又写回去
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    pendingRef.current = null
    disposeSession()
    clearPve(defaultStorage())
    setView(null)
    setConfig(null)
    setHasSave(false)
    onExitRef.current?.()
  }, [disposeSession])

  const actions = useMemo<RoomActions>(
    () => ({
      // 单人模式只用到 sendCommand 与 leave，其余是联机专属，保持空实现
      join: noop,
      leave: exit,
      setReady: noop,
      setNickname: noop,
      startGame: noop,
      setStrategy: noop,
      sendCommand: (cmd) => {
        sessionRef.current?.sendCommand(cmd)
      },
      skipDisconnectedTurn: noop,
      takeOverDisconnectedTurn: noop,
      setMap: noop,
      setAiSlots: noop,
      setAiDifficulty: noop,
      startManualPairing: noop,
      submitManualCode: noop,
      retryConnection: noop,
    }),
    [exit],
  )

  return {
    active: view !== null,
    view,
    actions,
    config,
    advisorStatus,
    resuming: resumeWhen && hasSave && view === null,
    start,
    restart,
    exit,
  }
}
