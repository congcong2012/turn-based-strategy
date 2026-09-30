import { useEffect, useState } from 'react'
import { ROOM_CODE_LENGTH, normalizeRoomCode, randomRoomCode, isValidRoomCode } from '../app/roomCode'
import { MAP_LIST, defaultMapFor } from '../game/data'
import type { Identity } from '../app/identity'
import type { RoomView } from '../net/roomSession'
import type { SignalStrategy, TransportKind } from '../net/types'
import type { RoomActions } from '../hooks/useRoom'
import type { Page } from '../app/route'
import { AppFooter } from './AppFooter'
import { ConnectStatusBadge } from './ConnectStatusBadge'
import { ConnectionHelp } from './ConnectionHelp'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { ManualSdpPanel } from './ManualSdpPanel'
import { PlayerList } from './PlayerList'

export interface LobbyProps {
  view: RoomView
  identity: Identity
  initialRoomCode: string | null
  /** 邀请链接里带的房间密码（?key=），用于预填 */
  initialRoomKey: string | null
  debug: { canUseLocal: boolean; kind: TransportKind; strategy: SignalStrategy }
  actions: RoomActions
  onNavigate: (page: Page) => void
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

export function Lobby({
  view,
  identity,
  initialRoomCode,
  initialRoomKey,
  debug,
  actions,
  onNavigate,
}: LobbyProps) {
  const [nickname, setNickname] = useState(identity.nickname)
  const [code, setCode] = useState(initialRoomCode ?? '')
  const [password, setPassword] = useState(initialRoomKey ?? '')
  const [showPassword, setShowPassword] = useState(false)
  const [rename, setRename] = useState(view.nickname)
  const [copied, setCopied] = useState(false)
  const [mode, setMode] = useState<'p2p' | 'manual'>('p2p')

  const inRoom = view.roomCode !== null && view.role !== 'idle' && (!view.manual || view.manual.phase === 'connected')

  useEffect(() => {
    setRename(view.nickname)
  }, [view.nickname])

  // 邀请链接：房间码 + （若是加密房）房间密码。链接等于钥匙，只发给好友。
  const inviteKey = view.passwordEnabled ? password.trim() : ''
  const inviteUrl =
    typeof window === 'undefined' || !view.roomCode
      ? ''
      : window.location.origin +
        window.location.pathname +
        '?room=' +
        view.roomCode +
        (inviteKey ? '&key=' + encodeURIComponent(inviteKey) : '')

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
        <div className="row head-row">
          <h1>联机大厅</h1>
          <button
            type="button"
            className="link-button"
            data-testid="back-home"
            onClick={() => onNavigate('home')}
          >
            ← 返回主页
          </button>
        </div>
        <p className="muted small">
          2–4 人回合制战棋：第一个进房的人是房主，全员准备后由房主开局（可给房间设密码）。
          手机浏览器同样可玩，掉线或刷新都能回到原对局。
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
          <ConnectStatusBadge view={view} onRetry={() => actions.retryConnection()} />
          <span>
            在线 peer：<b data-testid="peer-count">{view.peerCount}</b>
          </span>
        </div>
        {view.statusDetail ? <p className="muted small">详情：{view.statusDetail}</p> : null}
      </section>

      <ConnectionHelp
        view={view}
        onSwitchStrategy={() => actions.setStrategy(view.strategy === 'mqtt' ? 'torrent' : 'mqtt')}
        onManual={!inRoom ? () => setMode('manual') : undefined}
      />

      {view.manual && view.manual.phase !== 'connected' ? (
        <ManualSdpPanel view={view} onSubmitCode={actions.submitManualCode} onCancel={() => actions.leave()} />
      ) : null}

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

          <label className="field">
            <span>房间密码（可选，房主设了就必填）</span>
            <div className="row">
              <input
                data-testid="room-password-input"
                type={showPassword ? 'text' : 'password'}
                value={password}
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                placeholder="没有密码就留空"
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                data-testid="toggle-password"
                onClick={() => setShowPassword((prev) => !prev)}
              >
                {showPassword ? '隐藏' : '显示'}
              </button>
            </div>
          </label>
          <p className="muted small">
            密码只在你们的设备之间用于连接校验，不会发到任何服务器。密码不同的两个人会互相看不见（不会报错，所以两边务必一致）。
          </p>

          <div className="row mode-row">
            <button
              type="button"
              data-testid="mode-p2p"
              className={mode === 'p2p' ? 'picked' : ''}
              onClick={() => setMode('p2p')}
            >
              公共信令（默认）
            </button>
            <button
              type="button"
              data-testid="mode-manual"
              className={mode === 'manual' ? 'picked' : ''}
              onClick={() => setMode('manual')}
            >
              手动直连（备用）
            </button>
          </div>

          {mode === 'p2p' ? (
            <div className="row">
              <button
                type="button"
                className="primary"
                data-testid="join-button"
                disabled={!isValidRoomCode(code) || view.status === 'connecting'}
                onClick={() => actions.join(code, nickname, password.trim() || undefined)}
              >
                加入房间
              </button>
              <span className="muted small">
                同一个房间码 = 同一个房间；第一个进入的人自动成为房主，2–4 人均可开局。
              </span>
            </div>
          ) : (
            <>
              <div className="row">
                <button
                  type="button"
                  className="primary"
                  data-testid="manual-host"
                  disabled={!isValidRoomCode(code)}
                  onClick={() => actions.startManualPairing(code, 'host', nickname)}
                >
                  我是房主：生成邀请码
                </button>
                <button
                  type="button"
                  data-testid="manual-guest"
                  disabled={!isValidRoomCode(code)}
                  onClick={() => actions.startManualPairing(code, 'guest', nickname)}
                >
                  我是加入方：粘贴邀请码
                </button>
              </div>
              <p className="muted small">
                双方用同一个房间码；连接码通过微信/QQ 互发。仅支持 2 人，公共信令恢复后建议改回默认方式。
              </p>
            </>
          )}
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
              {view.passwordEnabled ? <span className="tag tag-host" data-testid="password-badge">已加密</span> : null}
              <button type="button" className="danger" data-testid="leave-button" onClick={() => actions.leave()}>
                离开房间
              </button>
            </div>
          </div>

          {view.passwordEnabled ? (
            <p className="muted small" data-testid="password-hint">
              房间已设密码：邀请链接里已带上密码，请只发给好友。对方若手动输密码，必须与这里完全一致（大小写敏感）；密码不一致会一直「连接中 / 等待对手」，不会有报错。
            </p>
          ) : null}

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
                  {view.canStart
                    ? '全员已准备，可以开始（' + MAP_LIST.find((m) => m.id === (view.mapId ?? defaultMapFor(view.players.length)))?.name + '）'
                    : '等待所有玩家准备（2–4 人）'}
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

            <label className="field inline">
              <span>地图</span>
              {view.isHost ? (
                <select
                  data-testid="map-select"
                  value={view.mapId ?? ''}
                  onChange={(event) => actions.setMap(event.target.value === '' ? null : event.target.value)}
                >
                  <option value="">
                    自动（按人数：{view.players.filter((p) => p.connected).length <= 2 ? '古道渡口 2 人' : '四战之地 4 人'}）
                  </option>
                  {MAP_LIST.map((map) => (
                    <option key={map.id} value={map.id}>
                      {map.name}（{map.width}×{map.height} · {map.players} 人）
                    </option>
                  ))}
                </select>
              ) : (
                <span className="muted small" data-testid="map-label">
                  {view.mapId ? (MAP_LIST.find((m) => m.id === view.mapId)?.name ?? view.mapId) : '由房主决定'}
                </span>
              )}
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

      <DiagnosticsPanel view={view} />

      <AppFooter onNavigate={onNavigate} />
    </div>
  )
}
