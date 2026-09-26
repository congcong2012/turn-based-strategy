import type { RoomView } from '../net/roomSession'
import { connectionLabel } from '../net/connectionState'

const CLASSES: Record<RoomView['connection'], string> = {
  idle: 'st-idle',
  connecting: 'st-connecting',
  connected: 'st-connected',
  waiting: 'st-waiting',
  reconnecting: 'st-reconnecting',
  failed: 'st-failed',
}

export interface ConnectStatusBadgeProps {
  view: RoomView
  onRetry: () => void
}

/** 连接状态指示：连接中 / 已连接 / 等待对手 / 重连中 / 失败（附带一键重试） */
export function ConnectStatusBadge({ view, onRetry }: ConnectStatusBadgeProps) {
  const cls = CLASSES[view.connection]
  const busy = view.connection === 'failed' || view.connection === 'reconnecting'
  return (
    <span className={'conn-badge ' + cls} data-testid="connection-badge" data-state={view.connection}>
      <i className="conn-dot" />
      <span data-testid="connection-text">{connectionLabel(view.connection)}</span>
      {view.connection === 'connected' ? <span className="muted small">（{view.peerCount} 条连接）</span> : null}
      {busy ? (
        <button type="button" data-testid="retry-connection" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </span>
  )
}
