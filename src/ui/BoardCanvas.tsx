import { useEffect, useRef, useState } from 'react'
import { BoardApp } from '../render/boardApp'
import type { BoardView } from '../render/boardApp'

export interface BoardCanvasProps {
  view: BoardView
  onTileClick: (x: number, y: number) => void
  /** DEV/E2E：把投影函数暴露出去，便于自动化点中具体格子（生产仅 ?debug=1 时开启） */
  exposeDebug?: boolean
}

export function BoardCanvas({ view, onTileClick, exposeDebug = false }: BoardCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const appRef = useRef<BoardApp | null>(null)
  const handlerRef = useRef(onTileClick)
  const viewRef = useRef(view)
  const [error, setError] = useState<string | null>(null)
  handlerRef.current = onTileClick
  viewRef.current = view

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
      if (exposeDebug) {
        ;(globalThis as Record<string, unknown>).__atBoard = {
          project: (x: number, y: number) => app.project(x, y),
          scale: () => app.getScale(),
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
