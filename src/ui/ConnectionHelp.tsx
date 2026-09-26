import type { RoomView } from '../net/roomSession'
import { recoveryHint } from '../net/connectionState'

export interface ConnectionHelpProps {
  view: RoomView
  onSwitchStrategy: () => void
  onManual?: () => void
}

/** 连不上时给出明确原因 + 下一步动作（切信令 / 手动直连） */
export function ConnectionHelp({ view, onSwitchStrategy, onManual }: ConnectionHelpProps) {
  const hint = recoveryHint(view.connection, view.strategy)
  if (!hint) return null
  return (
    <div className="alert error" data-testid="connection-help">
      <span>{hint}</span>
      {view.transportDetail ? <div className="muted small">原因：{view.transportDetail}</div> : null}
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" data-testid="switch-signal" onClick={onSwitchStrategy}>
          切到 {view.strategy === 'mqtt' ? 'Torrent' : 'MQTT'} 信令
        </button>
        {onManual ? (
          <button type="button" data-testid="help-manual" onClick={onManual}>
            改用手动直连
          </button>
        ) : null}
        <button type="button" data-testid="help-retry" onClick={() => window.location.reload()}>
          重新载入页面
        </button>
      </div>
    </div>
  )
}
