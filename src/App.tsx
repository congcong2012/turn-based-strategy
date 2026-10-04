import { useMemo, useState } from 'react'
import { useRoute } from './app/route'
import { hasMap } from './game/data'
import { useRoom } from './hooks/useRoom'
import { usePveGame } from './hooks/usePveGame'
import { GameScreen } from './ui/GameScreen'
import { HomePage } from './ui/HomePage'
import { Lobby } from './ui/Lobby'
import { MapEditor } from './ui/MapEditor'
import { MissingMapNotice } from './ui/MissingMapNotice'
import { PveSetup } from './ui/PveSetup'
import { RulesPanel } from './ui/RulesPanel'

export default function App() {
  const { route, go } = useRoute()
  const { view, identity, actions, initialRoomCode, debug } = useRoom()
  // 单人模式：完全离线，不走 useRoom/transport
  // resumeWhen：只有落在 #/pve 时才尝试从存档恢复（刷新/重开标签页接着打）
  const pve = usePveGame({ onExit: () => go('home'), resumeWhen: route.page === 'pve' })
  // 地图编辑器 → 单人练习设置页的"预选地图"（一次性的，不写进路由，免得链接里带一堆参数）
  const [preferredMapId, setPreferredMapId] = useState<string | null>(null)
  // 联机时补装了缺失的自制地图后，用它触发一次重渲染（地图表是模块级的，React 看不见变化）
  const [mapRevision, setMapRevision] = useState(0)

  // 邀请链接里的房间码优先（老链接必须继续直达大厅）
  const roomCode = useMemo(() => route.roomCode ?? initialRoomCode, [route.roomCode, initialRoomCode])

  // 单人局优先级最高：一旦开局，联机会话与路由都不再影响画面
  // （这也是为什么单人模式不需要先 leave 联机会话 —— 它永远抢不到渲染权）
  if (pve.active && pve.view) {
    return <GameScreen view={pve.view} actions={pve.actions} mode="pve" onRestart={pve.restart} />
  }

  // 有存档正在恢复：先占位，避免闪一下设置页（存档是同步读的，所以这只是一帧的事）
  if (pve.resuming) {
    return (
      <div className="app pve-setup" data-testid="pve-resuming">
        <p className="muted">正在恢复上一局…</p>
      </div>
    )
  }

  // 对局优先：一旦开局，无论当前在哪一页都显示对局界面
  // ⚠️ 但先要确认"这张地图本机有"：房主可以选自制地图，其他玩家没导入的话，
  //    直接渲染棋盘会 getMap 抛错（白屏）。这里给一条明确的出路：粘贴分享码。
  if (view.game && !hasMap(view.game.mapId)) {
    return (
      <MissingMapNotice
        mapId={view.game.mapId}
        roomCode={view.roomCode}
        onLoaded={() => setMapRevision((n) => n + 1)}
      />
    )
  }
  if (view.game) return <GameScreen key={mapRevision} view={view} actions={actions} mode="online" />

  if (route.page === 'pve') {
    return <PveSetup onStart={pve.start} onNavigate={go} preferredMapId={preferredMapId ?? undefined} />
  }
  if (route.page === 'editor') {
    return (
      <MapEditor
        onNavigate={go}
        onPlaytest={(mapId) => {
          setPreferredMapId(mapId)
          go('pve')
        }}
      />
    )
  }
  if (route.page === 'rules') return <RulesPanel onNavigate={go} />
  if (route.page === 'home') return <HomePage onNavigate={go} roomCode={roomCode} />

  return (
    <Lobby
      view={view}
      identity={identity}
      initialRoomCode={roomCode}
      initialRoomKey={route.roomKey}
      debug={debug}
      actions={actions}
      onNavigate={go}
    />
  )
}
