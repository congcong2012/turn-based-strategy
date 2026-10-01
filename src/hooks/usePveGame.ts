/**
 * 单人练习（PVE）的 React 接线。
 *
 * 它把本地会话（pveSession）包装成与联机**完全相同的** `{ view, actions }` 形状，
 * 于是 `GameScreen` 不需要为单人模式写第二套逻辑 —— 只是少了一些联网片段（由 mode="pve" 门控）。
 *
 * 会话只在 `start()` 时创建（而不是挂载时），因此 React StrictMode 的双挂载不会凭空开一局。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPveSession } from '../app/pveSession'
import type { PveConfig, PveSession } from '../app/pveSession'
import type { RoomActions } from './useRoom'
import type { RoomView } from '../net/roomSession'

export interface UsePveGameResult {
  active: boolean
  /** 未开局时为 null */
  view: RoomView | null
  actions: RoomActions
  config: PveConfig | null
  start: (config: PveConfig) => void
  restart: () => void
  exit: () => void
}

/** TS 允许"参数更少"的函数赋值给参数更多的函数类型，因此一个空实现可以填满所有回调 */
const noop = (): void => {}

export function usePveGame(options: { onExit?: () => void } = {}): UsePveGameResult {
  const onExitRef = useRef(options.onExit)
  onExitRef.current = options.onExit

  const sessionRef = useRef<PveSession | null>(null)
  const [view, setView] = useState<RoomView | null>(null)
  const [config, setConfig] = useState<PveConfig | null>(null)

  const disposeSession = useCallback(() => {
    sessionRef.current?.dispose()
    sessionRef.current = null
  }, [])

  // 卸载时释放（含 StrictMode 的重复挂载）
  useEffect(() => disposeSession, [disposeSession])

  const start = useCallback(
    (next: PveConfig) => {
      disposeSession()
      const session = createPveSession({ config: next, onChange: setView })
      sessionRef.current = session
      setConfig(next)
      setView(session.getView())
    },
    [disposeSession],
  )

  const restart = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    session.restart()
    setView(session.getView())
  }, [])

  const exit = useCallback(() => {
    disposeSession()
    setView(null)
    setConfig(null)
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

  return { active: view !== null, view, actions, config, start, restart, exit }
}
