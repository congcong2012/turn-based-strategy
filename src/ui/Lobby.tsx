import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ROOM_CODE_LENGTH, normalizeRoomCode, randomRoomCode, isValidRoomCode } from '../app/roomCode'
import { defaultMapFor } from '../game/data'
import { listLobbyMaps } from '../app/mapStore'
import type { Identity } from '../app/identity'
import type { RoomView } from '../net/roomSession'
import type { SignalStrategy, TransportKind } from '../net/types'
import type { RoomActions } from '../hooks/useRoom'
import type { Page } from '../app/route'
import { AppFooter } from './AppFooter'
import { ConnectStatusBadge } from './ConnectStatusBadge'
import { ConnectionHelp } from './ConnectionHelp'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { useAppSettings } from '../app/settings'
import { ManualSdpPanel } from './ManualSdpPanel'
import { PlayerList } from './PlayerList'
import { difficultyOptionLabel } from './difficultyCopy'
import { DEEP_DIFFICULTY, PLAYABLE_DIFFICULTIES, isDifficultyUsable } from '../ai'
import type { Difficulty } from '../ai'

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

/**
 * 设置项容器：房主看到的是可操作控件（→ `<label>`）；其他人看到的是只读文案（→ `<span>`）。
 *
 * 起因（2026-10-10 加 lint 时暴露）：这几项原来是"两种分支都包在同一个 `<label>` 里" ——
 * 房主那条分支里是 `<select>`（合法），非房主那条只有一段 `<span>`，
 * 于是生成了**不含任何表单控件的 `<label>`**。HTML 规范要求 label 必须关联控件，
 * 对屏幕阅读器也只是噪音。这里按"这一项此刻是不是真的可操作"来选标签名，
 * 语义更准，也不再报警。
 *
 * ★ 注意：**不要**把它写成"自动判断子节点里有没有控件"的通用组件 ——
 *   试过，Biome 的静态分析看不穿 `children`，照样报 `noLabelWithoutControl`，
 *   还得再补一堆 lint 豁免，得不偿失。就按调用方自己知道的那个布尔量选，最直白。
 */
function Field({ editable, children }: { editable: boolean; children: ReactNode }) {
  return editable ? (
    // biome-ignore lint/a11y/noLabelWithoutControl: children 里就是那个 <select>（由调用方按 editable 传入），静态分析看不穿透传的 children
    <label className="field inline">{children}</label>
  ) : (
    <span className="field inline">{children}</span>
  )
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
  /**
   * 可选地图：内置 + **本机已导入的自制图**。
   * 自制图没有随产物分发，所以选它之前要确认所有人都导入了同一张（界面上会提示）。
   */
  const mapOptions = useMemo(() => listLobbyMaps(), [])
  const selectedMap = mapOptions.find((m) => m.id === view.mapId)

  /**
   * 本局预计几方：房主选了 AI 补位就按那个数，否则按"真人（非观战、在线）数"。
   * 与 `lobbyReducer` 的口径一致（那边是权威值，这里只是给 UI 判断"深推演能不能选"）。
   */
  const expectedTotal =
    view.aiSlotCount > 0 ? view.aiSlotCount : view.players.filter((p) => p.connected && !p.spectator).length
  /** 「深推演」只在两人局可选 —— 规则本身在 AI 层（`isDifficultyUsable`） */
  const deepAllowed = isDifficultyUsable(DEEP_DIFFICULTY, expectedTotal)
  const [nickname, setNickname] = useState(identity.nickname)
  const [code, setCode] = useState(initialRoomCode ?? '')
  const [password, setPassword] = useState(initialRoomKey ?? '')
  const [showPassword, setShowPassword] = useState(false)
  const [rename, setRename] = useState(view.nickname)
  const [copied, setCopied] = useState(false)
  const [mode, setMode] = useState<'p2p' | 'manual'>('p2p')

  const { devMode } = useAppSettings()
  const inRoom = view.roomCode !== null && view.role !== 'idle' && (!view.manual || view.manual.phase === 'connected')
  /** 输入框里有没有内容（留空 = 想开新房，这是"创建房间"的唯一判据） */
  const codeFilled = code.trim().length > 0
  const codeValid = isValidRoomCode(code)

  /**
   * 留空时点主按钮 = **创建房间**：随机码 + 直接进房。
   *
   * 为什么要这么改（走查 F6）：原来的面板叫「加入房间」，想当房主得先点「随机生成」
   * 再点「加入房间」—— 第一次来的人不知道"我得先造一个码"。
   * 但**只有留空时**才创建：如果已经输入了几位（例如只打了 4 位），
   * 静默改成创建会让人以为连上了朋友那一房，所以那时按钮保持禁用并提示位数。
   */
  const createRoom = () => {
    const next = randomRoomCode()
    setCode(next)
    actions.join(next, nickname, password.trim() || undefined)
  }

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
          2–4 人回合制战棋（可 2v2 组队）：第一个进房的人是房主，全员准备后由房主开局（可给房间设密码）。
          手机浏览器同样可玩，掉线或刷新都能回到原对局。
        </p>
      </header>

      <section className="panel">
        {/*
          分三档：
          1. 未入房 → 不显示任何状态（走查 F7：第一眼应该是"我要做什么"）；
          2. 已入房 / 正在连接 → 常驻「身份 + 连接徽章」——"你是房主""掉线了"都是游玩信息；
          3. 开发者模式额外加：信令类型、连接细节、peer 数量。
        */}
        {inRoom || view.status !== 'idle' ? (
          <div className="status-line" data-testid="status-line">
            <span>
              身份：<b data-testid="role-label">{ROLE_TEXT[view.role] ?? view.role}</b>
            </span>
            <ConnectStatusBadge view={view} onRetry={() => actions.retryConnection()} />
            {devMode ? (
              <>
                <span>
                  信令：<b data-testid="strategy-label">{view.strategy === 'mqtt' ? 'MQTT' : 'Torrent'}</b>
                </span>
                <span>
                  连接：<b data-testid="connection-status">{STATUS_TEXT[view.status] ?? view.status}</b>
                </span>
                <span>
                  在线 peer：<b data-testid="peer-count">{view.peerCount}</b>
                </span>
              </>
            ) : null}
          </div>
        ) : (
          <p className="muted small" data-testid="lobby-idle-hint">
            还没加入房间：填一个 6 位房间码加入朋友的局，或直接点下面的「创建房间」开一局 —— 你会是房主。
          </p>
        )}
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
          <h2>加入 / 创建房间</h2>
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
            <>
              <div className="row">
                <button
                  type="button"
                  className="primary"
                  data-testid="join-button"
                  // 留空 = 创建房间（随机码 + 进房）；填了码但位数不对 = 禁用 + 提示
                  disabled={view.status === 'connecting' || (codeFilled && !codeValid)}
                  onClick={() =>
                    codeValid
                      ? actions.join(code, nickname, password.trim() || undefined)
                      : createRoom()
                  }
                >
                  {/*
                    填了码也是「加入 / 创建」二义：房里已经有人就是加入，没人你进去就是房主（创建）。
                    只写「加入房间」会让"自己起个码建房"的人以为走错了路。
                  */}
                  {codeFilled ? '加入 / 创建房间' : '创建房间'}
                </button>
                <button
                  type="button"
                  data-testid="spectate-button"
                  disabled={!codeValid || view.status === 'connecting'}
                  onClick={() => actions.join(code, nickname, password.trim() || undefined, true)}
                >
                  👁 观战
                </button>
                <span className="muted small">
                  {codeValid
                    ? '同一个房间码 = 同一个房间；第一个进入的人自动成为房主，2–4 人均可开局。'
                    : '留空直接点「创建房间」（你会是房主）；要加入朋友的局就填他给的 6 位房间码。'}
                  「观战」不占席位、不能操作，只是看（房间满员时也能进）。
                </span>
              </div>
              {codeFilled && !codeValid ? (
                <p className="muted small warn-text" data-testid="room-code-hint">
                  房间码需要 {ROOM_CODE_LENGTH} 位（清空则可以创建新房间）
                </p>
              ) : null}
            </>
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
                    ? '全员已准备，可以开始（' + (mapOptions.find((m) => m.id === (view.mapId ?? defaultMapFor(view.players.length)))?.name ?? '地图') + '）'
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

            {/* 信令策略是技术项：只在开发者模式下露出（出问题时另有「手动直连」兜底） */}
            {devMode ? (
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
            ) : null}

            <Field editable={view.isHost}>
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
                  {mapOptions.filter((m) => !m.custom).map((map) => (
                    <option key={map.id} value={map.id}>
                      {map.name}（{map.width}×{map.height} · {map.players} 人）
                    </option>
                  ))}
                  {mapOptions.some((m) => m.custom) ? (
                    <optgroup label="我的自制地图（需所有人都导入同一张）">
                      {mapOptions.filter((m) => m.custom).map((map) => (
                        <option key={map.id} value={map.id}>
                          {map.name}（{map.width}×{map.height} · {map.players} 人）
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
              ) : (
                <span className="muted small" data-testid="map-label">
                  {view.mapId ? (mapOptions.find((m) => m.id === view.mapId)?.name ?? view.mapId) : '由房主决定'}
                </span>
              )}
            </Field>
            <Field editable={view.isHost}>
              <span>AI 补位</span>
              {view.isHost ? (
                <select
                  data-testid="ai-slots-select"
                  value={view.aiSlotCount}
                  onChange={(event) => actions.setAiSlots(Number(event.target.value))}
                >
                  <option value={0}>不补位（只和真人打）</option>
                  {[2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      本局共 {n} 方（不足的用 AI 补）
                    </option>
                  ))}
                </select>
              ) : (
                <span className="muted small" data-testid="ai-slots-label">
                  {view.aiSlotCount > 0 ? `共 ${view.aiSlotCount} 方（不足的用 AI 补）` : '不补位'}
                </span>
              )}
            </Field>

            <Field editable={view.isHost}>
              <span>模式</span>
              {view.isHost ? (
                <>
                  <select
                    data-testid="team-mode-select"
                    value={view.teamMode}
                    onChange={(event) => actions.setTeamMode(event.target.value as 'ffa' | '2v2')}
                  >
                    <option value="ffa">混战（各自为战）</option>
                    <option value="2v2">2v2（两队对战）</option>
                  </select>
                  {view.teamMode === '2v2' ? (
                    <span className="muted small" data-testid="team-mode-hint">
                      需要 <b>4 个席位</b>（真人在座 + AI 补位凑满）。<b>对角同队</b>：
                      第 1&amp;4 位一队、第 2&amp;3 位一队；队友之间不能攻击，也不能抢对方据点。
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="muted small" data-testid="team-mode-label">
                  {view.teamMode === '2v2' ? '2v2（两队对战）' : '混战（各自为战）'}
                </span>
              )}
            </Field>

            {/*
              AI 用哪一档：**AI 补位 + 掉线托管共用**这个设置，所以即使「不补位」也有意义
              （对局中有人掉线、房主点「AI 代打」时用的就是它）。
            */}
            <Field editable={view.isHost}>
              <span>AI 难度</span>
              {view.isHost ? (
                <select
                  data-testid="ai-difficulty-select"
                  value={view.aiDifficulty}
                  onChange={(event) => actions.setAiDifficulty(event.target.value as Difficulty)}
                >
                  {PLAYABLE_DIFFICULTIES.map((d) => (
                    <option key={d} value={d} disabled={!isDifficultyUsable(d, expectedTotal)}>
                      {difficultyOptionLabel(d)}
                      {isDifficultyUsable(d, expectedTotal) ? '' : '（仅两人局）'}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="muted small" data-testid="ai-difficulty-label">
                  {difficultyOptionLabel(view.aiDifficulty)}
                </span>
              )}
            </Field>

            {view.isHost && view.aiSlotCount > 0 ? (
              <p className="muted small" data-testid="ai-slots-hint">
                当前 {view.players.filter((p) => p.connected).length} 名真人 →
                开局会补 {Math.max(0, view.aiSlotCount - view.players.filter((p) => p.connected).length)} 个 AI。
                AI 用「{difficultyOptionLabel(view.aiDifficulty)}」、与真人同规则（不加资源）。
              </p>
            ) : null}
            {view.isHost && !deepAllowed ? (
              <p className="muted small" data-testid="ai-deep-scope-hint">
                「{difficultyOptionLabel(DEEP_DIFFICULTY)}」暂时只在<b>两人局</b>可选：
                它要"把对手的整个回合推演一遍"，而 3 人以上是多方混战，这个前提不成立
                （会退回同档的「快棋」，选它反而名不副实）。
              </p>
            ) : null}
            {view.isHost ? (
              <p className="muted small" data-testid="ai-difficulty-hint">
                这一档也用于对局中<b>掉线托管</b>（房主点「AI 代打」时跑的档）。
              </p>
            ) : null}

            {view.isHost && selectedMap?.custom ? (
              <p className="muted small" data-testid="map-custom-hint">
                这是自制地图：其他玩家必须先导入同一张图（把编辑器里的「分享码」发给他们粘贴），
                否则他们那边没有这张地图、进不了这一局。
              </p>
            ) : null}

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

      {devMode ? <DiagnosticsPanel view={view} /> : null}

      <AppFooter onNavigate={onNavigate} />
    </div>
  )
}
