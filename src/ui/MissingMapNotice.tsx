/**
 * 「本机缺少这张地图」提示。
 *
 * 为什么需要：房主可以选**自制地图**开局，而自制图没有随产物分发 ——
 * 其他玩家手里没有这份数据。如果不拦，客户端渲染棋盘时 `getMap()` 会直接抛错（白屏）。
 * 这里给一条明确出路：把房主发来的**分享码**粘进来即可继续这一局。
 */

import { useState } from 'react'
import { decodeShareCode, upsertUserMap } from '../app/mapStore'

export interface MissingMapNoticeProps {
  /** 本局需要的地图 id（显示出来方便找房主核对） */
  mapId: string
  roomCode: string | null
  /** 导入成功后通知上层重渲染 —— 地图已在运行时表里，对局可以继续 */
  onLoaded: () => void
}

export function MissingMapNotice({ mapId, roomCode, onLoaded }: MissingMapNoticeProps) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = (): void => {
    const result = decodeShareCode(text)
    if (!result.ok) {
      setError(result.errors.join('；'))
      return
    }
    if (result.map.id !== mapId) {
      setError(`这张图的 id 是「${result.map.id}」，而本局需要的是「${mapId}」—— 请找房主要对应的那张分享码`)
      return
    }
    upsertUserMap(result.map) // 存到本机并注册进运行时地图表
    setError(null)
    onLoaded()
  }

  return (
    <div className="app pve-setup" data-testid="missing-map">
      <header className="app-header">
        <h1>缺少这张地图</h1>
        <p className="muted">
          房主选了一张<b>自制地图</b>（<code>{mapId}</code>），而你这台设备上还没有它
          {roomCode ? <>（房间 {roomCode}）</> : null}。
        </p>
        <p className="muted small">
          自制地图不随游戏分发。请让房主在<b>地图编辑器</b>里点「复制分享码」发给你，
          粘到下面即可进入这一局；或者请房主改选一张内置地图。
        </p>
      </header>

      <section className="panel">
        <h2>粘贴房主的分享码</h2>
        <textarea
          data-testid="missing-map-input"
          rows={5}
          value={text}
          placeholder="ATM1:..."
          onChange={(event) => setText(event.target.value)}
        />
        <button type="button" className="primary" data-testid="missing-map-load" onClick={load}>
          载入并继续
        </button>
        {error ? (
          <p className="muted small warn-text" data-testid="missing-map-error">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  )
}
