import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DATA, getMap, unitType } from '../game/data'
import { attackableTargets, reachableDestinations } from '../game/movement'
import { buildingAt, unitAt } from '../game/board'
import { scoreOf } from '../game/state'
import type { RoomView } from '../net/roomSession'
import type { RoomActions } from '../hooks/useRoom'
import type { GameState, PlayerId } from '../game/types'
import { BoardCanvas } from './BoardCanvas'
import type { FocusRequest } from './BoardCanvas'
import { ConnectStatusBadge } from './ConnectStatusBadge'
import { ConnectionHelp } from './ConnectionHelp'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { isSoundOn, playSound, setSoundOn, soundForEvent } from './sound'
import { EMPTY_TAP_STATE, isTouchDevice, nextTapState } from './tapConfirm'
import type { TapConfirmState } from './tapConfirm'
import type { BoardView } from '../render/boardApp'

export interface GameScreenProps {
  view: RoomView
  actions: RoomActions
  /**
   * 'online'（默认）= 联机对战，行为与旧版逐字节一致；
   * 'pve' = 纯离线单人练习：隐藏一切联网片段（连接徽章/房间号/暂停横幅/诊断面板）。
   */
  mode?: 'online' | 'pve'
  /** 仅 pve：结算后"再来一局" */
  onRestart?: () => void
}

const ROLE_COLORS = ['#c8503c', '#3fa7a0', '#d9a441', '#8a6fd0']

function playerColor(state: GameState, playerId: PlayerId): string {
  const index = state.players.indexOf(playerId)
  return ROLE_COLORS[(index < 0 ? 0 : index) % ROLE_COLORS.length]
}

function nameOf(view: RoomView, playerId: PlayerId): string {
  return view.players.find((p) => p.playerId === playerId)?.nickname ?? playerId.slice(0, 6)
}

export function GameScreen({ view, actions, mode = 'online', onRestart }: GameScreenProps) {
  const game = view.game as GameState
  const [armedType, setArmedType] = useState<string | null>(null)
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null)
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [tapState, setTapState] = useState<TapConfirmState>(EMPTY_TAP_STATE)
  const touch = useMemo(() => isTouchDevice(), [])
  const [focus, setFocus] = useState<FocusRequest | null>(null)
  const focusNonce = useRef(0)
  const requestFocus = useCallback((x0: number, y0: number, x1: number, y1: number) => {
    focusNonce.current += 1
    setFocus({ x0, y0, x1, y1, nonce: focusNonce.current })
  }, [])

  const myIndex = game.players.indexOf(view.selfId)
  const map = getMap(game.mapId)
  const myZone: { x0: number; y0: number; x1: number; y1: number } | undefined =
    myIndex >= 0 ? map.deployZones[myIndex] : undefined
  const zoneDirection = myZone
    ? myZone.y1 < map.height / 2
      ? '地图上部'
      : myZone.y0 > map.height / 2
        ? '地图下部'
        : myZone.x1 < map.width / 2
          ? '地图左侧'
          : myZone.x0 > map.width / 2
            ? '地图右侧'
            : '地图中部'
    : '地图上'
  const currentPlayer = game.players[game.turnIndex]
  const isDeploy = game.phase === 'DEPLOY'
  const isOver = game.phase === 'GAME_OVER'

  /**
   * 单人模式：轮到电脑时给一条明确反馈。
   *
   * 为什么需要：AI 的每一步之间有 450ms 的动作间隔，高难度档（回合级 rollout）单步还要额外算上百毫秒，
   * 一个回合最坏能到几十秒 —— 没有反馈玩家会以为页面卡死。
   * 只在「行动阶段 + 不是我的回合」出现：部署阶段 AI 是瞬间完成的，弹提示反而多余。
   */
  const aiThinking = mode === 'pve' && game.phase === 'PLAYING' && currentPlayer !== view.selfId
  /** 等待秒数：纯粹为了"它还在动"的可感知性，不参与任何游戏逻辑 */
  const [thinkSeconds, setThinkSeconds] = useState(0)
  useEffect(() => {
    if (!aiThinking) {
      setThinkSeconds(0)
      return
    }
    const startedAt = Date.now()
    setThinkSeconds(0)
    const timer = setInterval(() => {
      setThinkSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [aiThinking])
  const myDeploy = game.deploy[view.selfId]
  const selectedUnit = game.units.find((u) => u.id === selectedUnitId) ?? null
  const selectedBuilding = game.buildings.find((b) => b.id === selectedBuildingId) ?? null

  const reachable = useMemo(() => {
    if (!selectedUnit || !view.myTurn) return []
    return reachableDestinations(game, selectedUnit, DATA).map((d) => d.x + ',' + d.y)
  }, [game, selectedUnit, view.myTurn])

  const targets = useMemo(() => {
    if (!selectedUnit || !view.myTurn) return []
    return attackableTargets(game, selectedUnit, DATA).map((u) => u.x + ',' + u.y)
  }, [game, selectedUnit, view.myTurn])

  // 攻击范围：切比雪夫距离落在 [rangeMin, rangeMax] 的格子（红色边框）
  const { attackRange, attackTooClose } = useMemo(() => {
    const inRange: string[] = []
    const tooClose: string[] = []
    if (!selectedUnit || !view.myTurn) return { attackRange: inRange, attackTooClose: tooClose }
    const type = unitType(selectedUnit.type, DATA)
    const map = getMap(game.mapId)
    for (let dy = -type.rangeMax; dy <= type.rangeMax; dy += 1) {
      for (let dx = -type.rangeMax; dx <= type.rangeMax; dx += 1) {
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        if (d === 0) continue
        const x = selectedUnit.x + dx
        const y = selectedUnit.y + dy
        if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue
        if (d < type.rangeMin) tooClose.push(x + ',' + y)
        else if (d <= type.rangeMax) inRange.push(x + ',' + y)
      }
    }
    // 被单位占据的格子由红色填充表示，这里去掉重复边框
    const occupied = new Set(game.units.map((u) => u.x + ',' + u.y))
    return { attackRange: inRange.filter((k) => !occupied.has(k)), attackTooClose: tooClose }
  }, [game, selectedUnit, view.myTurn])

  // DEV/E2E：把权威状态暴露出去，便于自动化断言（生产构建不生效）
  useEffect(() => {
    const debugEnabled = import.meta.env.DEV || new URLSearchParams(window.location.search).has('debug')
    if (!debugEnabled) return
    ;(globalThis as Record<string, unknown>).__atGame = {
      getState: () => game,
      selfId: view.selfId,
      myTurn: view.myTurn,
    }
  }, [game, view.myTurn, view.selfId])

  // M5：把最近的移动路径交给渲染层，用于逐格播放
  const movePaths = useMemo(() => {
    const paths: Record<string, Array<{ x: number; y: number }>> = {}
    for (const entry of view.events) {
      if (entry.event.type === 'move') paths[entry.event.unitId] = entry.event.path
    }
    return paths
  }, [view.events])

  // M5：事件音效（按序号去重，保证每条事件只响一次）
  const lastSoundSeq = useRef(0)
  useEffect(() => {
    for (const entry of view.events) {
      if (entry.seq <= lastSoundSeq.current) continue
      lastSoundSeq.current = entry.seq
      const name = soundForEvent(entry.event.type)
      if (name) playSound(name)
    }
  }, [view.events])

  const [soundOn, setSoundOnState] = useState(() => isSoundOn())
  const toggleSound = () => {
    const next = !soundOn
    setSoundOn(next)
    setSoundOnState(next)
    if (next) playSound('click')
  }

  const boardView: BoardView = {
    state: game,
    reachable,
    targets,
    selectedUnitId,
    selectedBuildingId,
    deployZoneIndex: isDeploy && !myDeploy?.done ? myIndex : null,
    movePaths,
    attackRange,
    attackTooClose,
  }

  const clearSelection = useCallback(() => {
    setSelectedUnitId(null)
    setSelectedBuildingId(null)
  }, [])

  // 单人模式不存在"房主掉线"，永不冻结
  const frozen = mode === 'online' && view.pausedReason === 'host-offline'

  // 进入部署阶段：自动把镜头对准己方部署区（避免"看不到自己的区域、点了却被告知不在部署区"）
  useEffect(() => {
    if (!isDeploy || !myZone) return
    requestFocus(myZone.x0, myZone.y0, myZone.x1, myZone.y1)
  }, [isDeploy, myZone, requestFocus])

  /** 「定位」：部署阶段对准己方部署区；行动阶段对准自己的部队；都没有就显示全图 */
  const locate = useCallback(() => {
    if (isDeploy && myZone) {
      requestFocus(myZone.x0, myZone.y0, myZone.x1, myZone.y1)
      setHint('已把镜头对准你的部署区（' + zoneDirection + '）')
      return
    }
    const mine = game.units.filter((u) => u.owner === view.selfId)
    if (mine.length > 0) {
      const xs = mine.map((u) => u.x)
      const ys = mine.map((u) => u.y)
      requestFocus(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys))
      setHint('已把镜头对准你的部队')
      return
    }
    requestFocus(0, 0, map.width - 1, map.height - 1)
    setHint('已显示整张地图')
  }, [game.units, isDeploy, map.height, map.width, myZone, requestFocus, view.selfId, zoneDirection])

  const onTileClick = useCallback(
    (x: number, y: number) => {
      if (isOver || frozen) return

      if (isDeploy) {
        if (!armedType) {
          setHint('先在右侧选择要部署的兵种')
          return
        }
        if (myDeploy?.done) {
          setHint('你已完成部署，等待对手确认')
          return
        }
        const insideZone = !!myZone && x >= myZone.x0 && x <= myZone.x1 && y >= myZone.y0 && y <= myZone.y1
        if (!insideZone) {
          // 之前只回一句"不在部署区"，玩家根本不知道区在哪 —— 现在说明方位并把镜头带过去
          setHint('只能放在高亮的部署区（你的区域在' + zoneDirection + '）—— 镜头已对准该区域')
          if (myZone) requestFocus(myZone.x0, myZone.y0, myZone.x1, myZone.y1)
          return
        }
        playSound('click')
        actions.sendCommand({ type: 'deploy', unitType: armedType, x, y })
        setHint(null)
        return
      }

      if (!view.myTurn) {
        setHint('现在不是你的回合')
        return
      }

      const unit = unitAt(game, x, y)
      const tile = x + ',' + y

      // 0) 点到自己已行动过的单位：明确说原因（M7 修复：之前是静默无反应，像"地图坏了"）
      if (unit && unit.owner === view.selfId && unit.acted) {
        setSelectedUnitId(unit.id)
        setSelectedBuildingId(null)
        setHint(unitType(unit.type, DATA).name + ' 本回合已经行动过了（下回合可再行动）')
        return
      }

      // 1) 选中自己的单位
      if (unit && unit.owner === view.selfId && !unit.acted) {
        playSound('click')
        setSelectedUnitId(unit.id)
        setSelectedBuildingId(null)
        setHint(null)
        setTapState(EMPTY_TAP_STATE)
        return
      }

      // 2) 攻击射程内的敌人（触屏需要再点一次确认）
      if (selectedUnit && unit && unit.owner !== view.selfId && targets.includes(tile)) {
        const { state, execute } = nextTapState(tapState, 'attack:' + tile, Date.now(), touch)
        setTapState(state)
        if (!execute) {
          setHint('再点一次确认攻击 ' + DATA.units[unit.type].name)
          return
        }
        actions.sendCommand({ type: 'attack', unitId: selectedUnit.id, targetId: unit.id })
        setHint(null)
        return
      }

      // 3) 移动到可达格（触屏需要再点一次确认）
      if (selectedUnit && reachable.includes(tile)) {
        const { state, execute } = nextTapState(tapState, 'move:' + tile, Date.now(), touch)
        setTapState(state)
        if (!execute) {
          setHint('再点一次确认移动到这里')
          return
        }
        actions.sendCommand({ type: 'move', unitId: selectedUnit.id, x, y })
        setHint(null)
        return
      }

      // 4) 选中己方兵营（用于生产）
      const building = buildingAt(game, x, y)
      if (building && building.owner === view.selfId && DATA.buildings[building.type].produce) {
        setSelectedBuildingId(building.id)
        setSelectedUnitId(null)
        return
      }

      clearSelection()
    },
    // 注意：tapState 必须在依赖里，否则回调会一直闭包着"第一次点击"的状态，双击永远确认不了
    [actions, armedType, clearSelection, frozen, game, isDeploy, isOver, myDeploy?.done, reachable, selectedUnit, tapState, targets, touch, view.myTurn, view.selfId],
  )

  const canCapture =
    !!selectedUnit &&
    view.myTurn &&
    !selectedUnit.acted &&
    unitType(selectedUnit.type, DATA).capture &&
    (() => {
      const b = buildingAt(game, selectedUnit.x, selectedUnit.y)
      return !!b && b.owner !== view.selfId
    })()

  return (
    <div className="game-screen">
      <header className="game-hud">
        <span className="hud-item">
          回合 <b data-testid="round-label">{game.round}</b>
        </span>
        <span className="hud-item">
          阶段 <b data-testid="phase-label">{isDeploy ? '部署' : isOver ? '结束' : '行动'}</b>
        </span>
        <span className="hud-item">
          当前 <b data-testid="current-player" style={{ color: playerColor(game, currentPlayer) }}>
            {nameOf(view, currentPlayer)}
            {currentPlayer === view.selfId ? '（你）' : ''}
          </b>
        </span>
        <span className="hud-item">
          资金 <b data-testid="funds-label">{game.funds[view.selfId] ?? 0}</b>
        </span>
        <button type="button" data-testid="locate-button" onClick={locate} title="把镜头对准我的部署区 / 部队">
          🎯 定位
        </button>
        {mode === 'online' ? (
          <>
            <ConnectStatusBadge view={view} onRetry={() => actions.retryConnection()} />
            <span className="hud-item muted small">房间 {view.roomCode}</span>
          </>
        ) : (
          <span className="hud-item muted small" data-testid="pve-badge">
            单人练习
          </span>
        )}
        <button type="button" data-testid="sound-toggle" onClick={toggleSound} title="音效开关">
          {soundOn ? '🔊 音效' : '🔇 静音'}
        </button>
        <button type="button" data-testid="leave-button" onClick={() => actions.leave()}>
          {mode === 'pve' ? '退出对局' : '离开'}
        </button>
      </header>

      {/* 单人模式：电脑回合进行中的明确反馈（联机模式下"不是我的回合"是另一个人类，不该这么提示） */}
      {mode === 'pve' && aiThinking ? (
        <div className="thinking-banner" data-testid="ai-thinking">
          <span className="thinking-dot" aria-hidden="true" />
          <span>{nameOf(view, currentPlayer)} 正在思考…</span>
          <span className="muted small" data-testid="ai-thinking-elapsed">
            {thinkSeconds > 0 ? `已等待 ${thinkSeconds} 秒` : '请稍候'}
          </span>
        </div>
      ) : null}

      {/* 以下是纯联机片段：单人模式没有房主、没有断线、没有信令可切 */}
      {mode === 'online' ? (
        <>
          {view.paused ? (
            <div className="pause-banner" data-testid="pause-banner">
              <span>
                {view.pausedReason === 'host-offline'
                  ? '房主已断线，游戏暂停，等待其重连…（刷新页面不影响，房主回来后自动继续）'
                  : '对手已断线，等待重连…（对局与你的操作都已保留）'}
              </span>
              {view.canSkipTurn ? (
                <button type="button" data-testid="skip-turn" onClick={() => actions.skipDisconnectedTurn()}>
                  跳过其回合
                </button>
              ) : null}
            </div>
          ) : null}

          <ConnectionHelp view={view} onSwitchStrategy={() => actions.setStrategy(view.strategy === 'mqtt' ? 'torrent' : 'mqtt')} />

          {!view.paused && view.offlinePlayers.length > 0 ? (
            <div className="pause-banner soft" data-testid="offline-hint">
              <span>{view.offlinePlayers.map((p) => nameOf(view, p)).join('、')} 已断线，等待重连…（席位与部队都已保留）</span>
            </div>
          ) : null}
        </>
      ) : null}

      <div className="game-body">
        <BoardCanvas
          view={boardView}
          onTileClick={onTileClick}
          focus={focus}
          exposeDebug={import.meta.env.DEV || new URLSearchParams(window.location.search).has('debug')}
        />

        <aside className="game-panel">
          {isDeploy ? (
            <section>
              <h2>部署阶段</h2>
              <p className="muted small" data-testid="deploy-info">
                预算 {myDeploy?.budget ?? 0} · 已放置 {myDeploy?.placed ?? 0}/4
                {myDeploy?.done ? ' · 已确认' : ''}
              </p>
              <div className="unit-picker">
                {DATA.unitList.map((type) => (
                  <button
                    key={type.id}
                    type="button"
                    data-testid={'deploy-' + type.id}
                    className={armedType === type.id ? 'picked' : ''}
                    disabled={!!myDeploy?.done || (myDeploy?.budget ?? 0) < type.cost || (myDeploy?.placed ?? 0) >= 4}
                    onClick={() => {
                      setArmedType(type.id)
                      setHint('点击己方部署区放置 ' + type.name)
                    }}
                  >
                    <b>{type.glyph}</b> {type.name}
                    <span className="muted small"> {type.cost}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="primary block"
                data-testid="deploy-done"
                disabled={!!myDeploy?.done || (myDeploy?.placed ?? 0) < 1 || frozen}
                onClick={() => actions.sendCommand({ type: 'deployDone' })}
              >
                {myDeploy?.done ? (mode === 'pve' ? '等待 AI…' : '等待对手…') : '完成部署'}
              </button>
              <p className="muted small">
                {view.players.map((p) => (
                  <span key={p.playerId} className="block">
                    {p.nickname}：{game.deploy[p.playerId]?.done ? '已确认' : '部署中'}
                    {p.connected ? '' : '（已断线）'}
                  </span>
                ))}
              </p>
            </section>
          ) : (
            <>
              <section>
                <h2>对局</h2>
                <p className="muted small">
                  {view.myTurn
                    ? '轮到你了：点己方单位 → 蓝格移动 / 红格攻击'
                    : mode === 'pve'
                      ? '等待 AI 行动…'
                      : '等待对手行动…'}
                </p>
                <div className="score-rows">
                  {game.players.map((p) => (
                    <div key={p} className="score-row" data-testid={'score-' + p}>
                      <span style={{ color: playerColor(game, p) }}>
                        {nameOf(view, p)}
                        {game.eliminated.includes(p) ? (
                          <span className="tag tag-waiting" data-testid={'eliminated-' + p}>
                            {' '}
                            已淘汰
                          </span>
                        ) : null}
                      </span>
                      <span className="muted small">
                        据点 {game.buildings.filter((b) => b.owner === p).length} · 单位{' '}
                        {game.units.filter((u) => u.owner === p).length} · 资金 {game.funds[p] ?? 0} · 分{' '}
                        {scoreOf(game, p, DATA)}
                      </span>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="primary block"
                  data-testid="end-turn"
                  disabled={!view.myTurn || frozen}
                  onClick={() => {
                    clearSelection()
                    actions.sendCommand({ type: 'endTurn' })
                  }}
                >
                  结束回合
                </button>
                <button
                  type="button"
                  className="block"
                  data-testid="resign-button"
                  disabled={isOver}
                  onClick={() => actions.sendCommand({ type: 'resign' })}
                >
                  认输
                </button>
              </section>

              {selectedUnit ? (
                <section data-testid="unit-panel">
                  <h2>单位</h2>
                  <p>
                    <b>{unitType(selectedUnit.type, DATA).name}</b>
                    <span className="muted small">
                      {' '}
                      HP {selectedUnit.hp}/{unitType(selectedUnit.type, DATA).hp} · 移动{' '}
                      {unitType(selectedUnit.type, DATA).move} · 射程 {unitType(selectedUnit.type, DATA).rangeMin}–
                      {unitType(selectedUnit.type, DATA).rangeMax}
                    </span>
                  </p>
                  <p className="muted small">
                    {selectedUnit.acted ? '本回合已行动' : selectedUnit.moved ? '已移动，可继续攻击' : '可移动'}
                  </p>
                  {(() => {
                    const b = buildingAt(game, selectedUnit.x, selectedUnit.y)
                    if (!b || !unitType(selectedUnit.type, DATA).capture || b.owner === view.selfId) return null
                    const points = b.capture?.points ?? 0
                    const step = Math.max(1, Math.floor(selectedUnit.hp / 10))
                    const need = Math.max(1, Math.ceil((DATA.capturePoints - points) / step))
                    return (
                      <p className="muted small" data-testid="capture-progress">
                        占领进度 {points}/{DATA.capturePoints} · 本次 +{step} · 还需 {need} 次
                      </p>
                    )
                  })()}
                  <div className="row">
                    <button
                      type="button"
                      data-testid="capture-button"
                      disabled={!canCapture}
                      onClick={() => actions.sendCommand({ type: 'capture', unitId: selectedUnit.id })}
                    >
                      占领
                    </button>
                    <button
                      type="button"
                      data-testid="wait-button"
                      disabled={!view.myTurn || selectedUnit.acted}
                      onClick={() => actions.sendCommand({ type: 'wait', unitId: selectedUnit.id })}
                    >
                      待机
                    </button>
                  </div>
                </section>
              ) : null}

              {selectedBuilding ? (
                <section data-testid="building-panel">
                  <h2>兵营生产</h2>
                  <div className="unit-picker">
                    {DATA.unitList.map((type) => (
                      <button
                        key={type.id}
                        type="button"
                        data-testid={'produce-' + type.id}
                        disabled={!view.myTurn || (game.funds[view.selfId] ?? 0) < type.cost}
                        onClick={() => actions.sendCommand({ type: 'produce', buildingId: selectedBuilding.id, unitType: type.id })}
                      >
                        <b>{type.glyph}</b> {type.name}
                        <span className="muted small"> {type.cost}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              {view.log.length > 0 ? (
                <section data-testid="event-log">
                  <h2>战报</h2>
                  <ol className="log-list">
                    {[...view.log].reverse().slice(0, 12).map((line, index) => (
                      <li key={view.log.length - index}>{line}</li>
                    ))}
                  </ol>
                </section>
              ) : null}

              {game.pending.length > 0 ? (
                <section>
                  <h2>生产队列</h2>
                  <ul className="log-list" data-testid="pending-list">
                    {game.pending.map((item) => {
                      const barracks = game.buildings.find((b) => b.id === item.buildingId)
                      const occupied = barracks ? game.units.some((u) => u.x === barracks.x && u.y === barracks.y) : true
                      const mine = item.owner === view.selfId
                      return (
                        <li key={item.id} data-testid={'pending-' + item.id}>
                          {mine ? '我方' : nameOf(view, item.owner)}：{DATA.units[item.type].name} ·{' '}
                          {barracks ? '兵营(' + barracks.x + ',' + barracks.y + ')' : '兵营已失守'} ·{' '}
                          {!barracks || occupied ? '出战位被占，顺延至下一回合' : '下一回合出场'}
                        </li>
                      )
                    })}
                  </ul>
                </section>
              ) : null}
            </>
          )}

          {hint ? <p className="alert notice small" data-testid="game-hint">{hint}</p> : null}
          {view.error ? (
            <p className="alert error small" data-testid="game-error">
              {view.error}
            </p>
          ) : null}
          {mode === 'online' ? <DiagnosticsPanel view={view} /> : null}
          <p className="muted small">
            地图：{map.name}（{map.width}×{map.height}） · 拖拽平移，滚轮缩放
          </p>
        </aside>
      </div>

      {isOver ? (
        <div className="overlay" data-testid="game-over">
          <div className="overlay-card">
            <h2>
              {game.winner === null ? '和局' : game.winner === view.selfId ? '胜利！' : '败北'}
            </h2>
            <p className="muted">
              结果：
              {game.winner === null ? '双方同分' : nameOf(view, game.winner) + ' 获胜'}
              （{game.winReason === 'hq_captured' ? '攻陷王城' : game.winReason === 'annihilation' ? '全歼敌军' : game.winReason === 'score' ? '回合上限计分' : '对手投降'}）
            </p>
            {mode === 'pve' ? (
              <>
                <button type="button" className="primary block" data-testid="pve-again" onClick={() => onRestart?.()}>
                  再来一局
                </button>
                <button type="button" className="block" data-testid="pve-home" onClick={() => actions.leave()}>
                  返回主页
                </button>
              </>
            ) : (
              <button type="button" className="primary" data-testid="back-to-lobby" onClick={() => actions.leave()}>
                返回大厅
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}