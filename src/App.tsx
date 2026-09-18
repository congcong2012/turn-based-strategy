import { useRoom } from './hooks/useRoom'
import { Lobby } from './ui/Lobby'

export default function App() {
  const { view, identity, actions, initialRoomCode, debug } = useRoom()
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
