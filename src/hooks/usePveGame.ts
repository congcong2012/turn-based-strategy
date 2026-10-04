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
  const aiThink = useCallback<AiThinker>((task) => {
    if (!aiClientRef.current) {
      aiClientRef.current = createAiWorkerClient({
        onFallback: (reason) => {
          aiFallbackRef.current = reason
        },
      })
    }
    return aiClientRef.current.think(task)
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
  }, [resumeWhen, persist, aiThink])

  // ---------------------------------------------------------------- 生命周期

  const start = useCallback(
    (next: PveConfig) => {
      disposeSession()
      const session = createPveSession({ config: next, aiThink, onChange: setView, onPersist: persist })
      sessionRef.current = session
      setConfig(next)
      setView(session.getView())
      setHasSave(false)
    },
    [disposeSession, persist, aiThink],
  )

  const restart = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    session.restart()
    setView(session.getView())
  }, [])

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
      setMap: noop,
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
    resuming: resumeWhen && hasSave && view === null,
    start,
    restart,
    exit,
  }
}
