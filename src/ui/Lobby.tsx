import { useEffect, useState } from 'react'
import { ROOM_CODE_LENGTH, normalizeRoomCode, randomRoomCode, isValidRoomCode } from '../app/roomCode'
import type { Identity } from '../app/identity'
import type { RoomView } from '../net/roomSession'
import type { SignalStrategy, TransportKind } from '../net/types'
import type { RoomActions } from '../hooks/useRoom'
import { ManualSdpPanel } from './ManualSdpPanel'
import { PlayerList } from './PlayerList'

export interface LobbyProps {
  view: RoomView
  identity: Identity
  initialRoomCode: string | null
  debug: { canUseLocal: boolean; kind: TransportKind; strategy: SignalStrategy }
  actions: RoomActions
}

const STATUS_TEXT: Record<string, string> = {
  idle: '未加入房间',
  connecting: '正在连接信令…',
  connected: '已连接',
  error: '连接出错',
  closed: '已断开',
}

const ROLE_TEXT: Record<string, string> = {
  idle: '未加入',
  joining: '选举房主中…',
  host: '你是房主',
  client: '你是玩家',
}

export function Lobby({ view, identity, initialRoomCode, debug, actions }: LobbyProps) {
  const [nickname, setNickname] = useState(identity.nickname)
  const [code, setCode] = useState(initialRoomCode ?? '')
  const [rename, setRename] = useState(view.nickname)
  const [copied, setCopied] = useState(false)

  const inRoom = view.roomCode !== null && view.role !== 'idle'

  useEffect(() => {
    setRename(view.nickname)
  }, [view.nickname])

  const inviteUrl =
    typeof window === 'undefined' || !view.roomCode
      ? ''
      : window.location.origin + window.location.pathname + '?room=' + view.roomCode

  const copyInvite = () => {
    if (!inviteUrl) return
    void navigator.clipboard?.writeText(inviteUrl).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => setCopied(false),
    )
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>古代战棋 · 联机大厅</h1>
        <p className="muted">
          MVP 里程碑 M1：纯静态站点 + WebRTC P2P 房间。好友打开链接、输入同一房间码即可互相看见。
        </p>
      </header>

      <section className="panel">
        <div className="status-line" data-testid="status-line">
          <span>
            信令：<b data-testid="strategy-label">{view.strategy === 'mqtt' ? 'MQTT' : 'Torrent'}</b>
          </span>
          <span>
            连接：<b data-testid="connection-status">{STATUS_TEXT[view.status] ?? view.status}</b>
          </span>
          <span>
            身份：<b data-testid="role-label">{ROLE_TEXT[view.role] ?? view.role}</b>
          </span>
          <span>
            在线 peer：<b data-testid="peer-count">{view.peerCount}</b>
          </span>
        </div>
        {view.statusDetail ? <p className="muted small">详情：{view.statusDetail}</p> : null}
      </section>

      {!inRoom ? (
        <section className="panel" data-testid="join-panel">
          <h2>加入房间</h2>
          <label className="field">
            <span>昵称</span>
            <input
              data-testid="nickname-input"
              value={nickname}
              maxLength={16}
              placeholder="例如：飞将军"
              onChange={(event) => setNickname(event.target.value)}
            />
          </label>

          <label className="field">
            <span>房间码（{ROOM_CODE_LENGTH} 位）</span>
            <div className="row">
              <input
                data-testid="room-code-input"
                value={code}
                placeholder="ABC23D"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setCode(normalizeRoomCode(event.target.value))}
              />
              <button type="button" data-testid="random-code-button" onClick={() => setCode(randomRoomCode())}>
                随机生成
              </button>
            </div>
          </label>

          <div className="row">
            <button
              type="button"
              className="primary"
              data-testid="join-button"
              disabled={!isValidRoomCode(code) || view.status === 'connecting'}
              onClick={() => actions.join(code, nickname)}
            >
              加入房间
            </button>
            <span className="muted small">
              同一个房间码 = 同一个房间；第一个进入的人自动成为房主。
            </span>
          </div>
        </section>
      ) : (
        <section className="panel" data-testid="room-panel">
          <div className="room-head">
            <div>
              <span className="muted small">房间码</span>
              <div className="room-code" data-testid="room-code-display">
                {view.roomCode}
              </div>
            </div>
            <div className="room-actions">
              <button type="button" data-testid="copy-link-button" onClick={copyInvite}>
                {copied ? '已复制链接' : '复制邀请链接'}
              </button>
              <button type="button" className="danger" data-testid="leave-button" onClick={() => actions.leave()}>
                离开房间
              </button>
            </div>
          </div>

          <h2>玩家列表（{view.players.length}）</h2>
          <PlayerList players={view.players} selfId={view.selfId} />

          <div className="row room-controls">
            <button
              type="button"
              className={view.ready ? '' : 'primary'}
              data-testid="ready-button"
              onClick={() => actions.setReady(!view.ready)}
            >
              {view.ready ? '取消准备' : '准备'}
            </button>

            {view.isHost ? (
              <>
                <button
                  type="button"
                  className="primary"
                  data-testid="start-button"
                  disabled={!view.canStart}
                  onClick={() => actions.startGame()}
                >
                  开始游戏
                </button>
                <span className="muted small" data-testid="start-hint">
                  {view.canStart ? '全员已准备，可以开始' : '等待所有玩家准备'}
                </span>
              </>
            ) : (
              <span className="muted small" data-testid="start-hint">
                房主是 {view.hostNickname ?? '（未知）'}；全员准备后由房主开始
              </span>
            )}
          </div>

          <div className="row room-extra">
            <label className="field inline">
              <span>改名</span>
              <input
                data-testid="rename-input"
                value={rename}
                maxLength={16}
                onChange={(event) => setRename(event.target.value)}
                onBlur={() => rename.trim() && rename !== view.nickname && actions.setNickname(rename)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && rename.trim()) actions.setNickname(rename)
                }}
              />
            </label>

            <label className="field inline">
              <span>信令策略</span>
              <select
                data-testid="strategy-select"
                value={view.strategy}
                onChange={(event) => actions.setStrategy(event.target.value as SignalStrategy)}
              >
                <option value="mqtt">MQTT（默认）</option>
                <option value="torrent">Torrent（备用）</option>
              </select>
            </label>

            {debug.canUseLocal ? (
              <span className="muted small" data-testid="transport-label">
                传输：{view.kind === 'local' ? '本地调试（BroadcastChannel）' : 'Trystero P2P'}
              </span>
            ) : null}
          </div>
        </section>
      )}

      {view.error ? (
        <p className="alert error" data-testid="error">
          {view.error}
        </p>
      ) : null}
      {view.notice ? (
        <p className="alert notice" data-testid="notice">
          {view.notice}
        </p>
      ) : null}

      <ManualSdpPanel />

      <footer className="app-footer muted small">
        纯静态托管 · 无后端 / 无数据库 · 房主权威 · 客户端只发指令
      </footer>
    </div>
  )
}
