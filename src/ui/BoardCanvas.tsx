import { useEffect, useRef, useState } from 'react'
import { BoardApp } from '../render/boardApp'
import type { BoardView } from '../render/boardApp'

export interface FocusRequest {
  x0: number
  y0: number
  x1: number
  y1: number
  /** 每次请求换一个 nonce，组件据此判断是否需要重新聚焦 */
  nonce: number
}

export interface BoardCanvasProps {
  view: BoardView
  onTileClick: (x: number, y: number) => void
  /** 把镜头对准某个区域（「定位」按钮 / 进入部署阶段自动聚焦） */
  focus?: FocusRequest | null
  /** DEV/E2E：把投影函数暴露出去，便于自动化点中具体格子（生产仅 ?debug=1 时开启） */
  exposeDebug?: boolean
}

export function BoardCanvas({ view, onTileClick, focus, exposeDebug = false }: BoardCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const appRef = useRef<BoardApp | null>(null)
  const handlerRef = useRef(onTileClick)
  const viewRef = useRef(view)
  const focusRef = useRef<FocusRequest | null>(focus ?? null)
  const [error, setError] = useState<string | null>(null)
  handlerRef.current = onTileClick
  viewRef.current = view
  focusRef.current = focus ?? null

  useEffect(() => {
    let disposed = false
    const app = new BoardApp()
    appRef.current = app
    const host = hostRef.current
    if (!host) return
    app
      .mount(host)
      .then(() => {
        if (disposed) {
          app.destroy()
          return
        }
        app.setTileHandler((x, y) => handlerRef.current(x, y))
        app.setView(viewRef.current)
        // 棋盘就绪后若已有聚焦请求，立即应用（例如进入部署阶段）
        const pending = focusRef.current
        if (pending) app.focusTiles(pending.x0, pending.y0, pending.x1, pending.y1)
        if (exposeDebug) {
          ;(globalThis as Record<string, unknown>).__atBoard = {
            project: (x: number, y: number) => app.project(x, y),
            scale: () => app.getScale(),
            camera: () => app.getCamera(),
          }
        }
      })
      .catch((err: unknown) => {
        if (disposed) return
        setError(String((err as Error)?.message ?? err))
      })
    return () => {
      disposed = true
      appRef.current = null
      app.destroy()
    }
  }, [exposeDebug])

  useEffect(() => {
    appRef.current?.setView(view)
  }, [view])

  const lastFocusNonce = useRef(-1)
  useEffect(() => {
    if (!focus || focus.nonce === lastFocusNonce.current) return
    lastFocusNonce.current = focus.nonce
    appRef.current?.focusTiles(focus.x0, focus.y0, focus.x1, focus.y1)
  }, [focus])

  return (
    <div className="board-host" data-testid="board" ref={hostRef}>
      {error ? (
        <p className="alert error" data-testid="board-error">
          棋盘渲染初始化失败（{error}）。请更新浏览器或改用支持 WebGL 的设备。
        </p>
      ) : null}
    </div>
  )
}
