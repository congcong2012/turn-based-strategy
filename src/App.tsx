import { useRoom } from './hooks/useRoom'
import { GameScreen } from './ui/GameScreen'
import { Lobby } from './ui/Lobby'

export default function App() {
  const { view, identity, actions, initialRoomCode, debug } = useRoom()
  if (view.game) {
    return <GameScreen view={view} actions={actions} />
  }
  return (
    <Lobby
      view={view}
      identity={identity}
      initialRoomCode={initialRoomCode}
      debug={debug}
      actions={actions}
    />
  )
}
