import { useMemo } from 'react'
import { useRoute } from './app/route'
import { useRoom } from './hooks/useRoom'
import { GameScreen } from './ui/GameScreen'
import { HomePage } from './ui/HomePage'
import { Lobby } from './ui/Lobby'
import { RulesPanel } from './ui/RulesPanel'

export default function App() {
  const { route, go } = useRoute()
  const { view, identity, actions, initialRoomCode, debug } = useRoom()

  // 邀请链接里的房间码优先（老链接必须继续直达大厅）
  const roomCode = useMemo(() => route.roomCode ?? initialRoomCode, [route.roomCode, initialRoomCode])

  // 对局优先：一旦开局，无论当前在哪一页都显示对局界面
  if (view.game) return <GameScreen view={view} actions={actions} />

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
