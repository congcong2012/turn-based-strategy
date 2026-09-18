import type { LobbyPlayer } from '../net/types'

export interface PlayerListProps {
  players: LobbyPlayer[]
  selfId: string
}

export function PlayerList({ players, selfId }: PlayerListProps) {
  if (players.length === 0) {
    return (
      <p className="muted" data-testid="player-list-empty">
        还没有玩家，等待好友加入…
      </p>
    )
  }

  return (
    <ul className="player-list" data-testid="player-list">
      {players.map((player) => {
        const isSelf = player.playerId === selfId
        return (
          <li
            key={player.playerId}
            className={'player-item' + (isSelf ? ' is-self' : '') + (player.connected ? '' : ' is-offline')}
            data-testid="player-item"
            data-player-id={player.playerId}
            data-host={player.isHost ? 'true' : 'false'}
            data-ready={player.ready ? 'true' : 'false'}
          >
            <span className="player-name">
              {player.nickname}
              {isSelf ? <span className="tag tag-self">你</span> : null}
            </span>
            {player.isHost ? (
              <span className="tag tag-host" data-testid="host-badge">
                👑 房主
              </span>
            ) : null}
            <span className={'tag ' + (player.ready ? 'tag-ready' : 'tag-waiting')} data-testid="ready-badge">
              {player.ready ? '✓ 已准备' : '未准备'}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
