import { useMemo } from 'react'
import { useRoute } from './app/route'
import { useRoom } from './hooks/useRoom'
import { usePveGame } from './hooks/usePveGame'
import { GameScreen } from './ui/GameScreen'
import { HomePage } from './ui/HomePage'
import { Lobby } from './ui/Lobby'
import { PveSetup } from './ui/PveSetup'
import { RulesPanel } from './ui/RulesPanel'

export default function App() {
  const { route, go } = useRoute()
  const { view, identity, actions, initialRoomCode, debug } = useRoom()
  // 单人模式：完全离线，不走 useRoom/transport
  // resumeWhen：只有落在 #/pve 时才尝试从存档恢复（刷新/重开标签页接着打）
  const pve = usePveGame({ onExit: () => go('home'), resumeWhen: route.page === 'pve' })

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
  if (view.game) return <GameScreen view={view} actions={actions} mode="online" />

  if (route.page === 'pve') return <PveSetup onStart={pve.start} onNavigate={go} />
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
