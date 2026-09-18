import { useCallback, useEffect, useMemo, useState } from 'react'
import { DATA, getMap, unitType } from '../game/data'
import { attackableTargets, reachableDestinations } from '../game/movement'
import { buildingAt, unitAt } from '../game/board'
import { scoreOf } from '../game/state'
import type { RoomView } from '../net/roomSession'
import type { RoomActions } from '../hooks/useRoom'
import type { GameState, PlayerId } from '../game/types'
import { BoardCanvas } from './BoardCanvas'
import type { BoardView } from '../render/boardApp'

export interface GameScreenProps {
  view: RoomView
  actions: RoomActions
}

const ROLE_COLORS = ['#c8503c', '#3fa7a0', '#d9a441', '#8a6fd0']

function playerColor(state: GameState, playerId: PlayerId): string {
  const index = state.players.indexOf(playerId)
  return ROLE_COLORS[(index < 0 ? 0 : index) % ROLE_COLORS.length]
}

function nameOf(view: RoomView, playerId: PlayerId): string {
  return view.players.find((p) => p.playerId === playerId)?.nickname ?? playerId.slice(0, 6)
}

export function GameScreen({ view, actions }: GameScreenProps) {
  const game = view.game as GameState
  const [armedType, setArmedType] = useState<string | null>(null)
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null)
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  const myIndex = game.players.indexOf(view.selfId)
  const map = getMap(game.mapId)
  const currentPlayer = game.players[game.turnIndex]
  const isDeploy = game.phase === 'DEPLOY'
  const isOver = game.phase === 'GAME_OVER'
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

  const boardView: BoardView = {
    state: game,
    reachable,
    targets,
    selectedUnitId,
    selectedBuildingId,
    deployZoneIndex: isDeploy && !myDeploy?.done ? myIndex : null,
  }

  const clearSelection = useCallback(() => {
    setSelectedUnitId(null)
    setSelectedBuildingId(null)
  }, [])

  const frozen = view.pausedReason === 'host-offline'

  const onTileClick = useCallback(
    (x: number, y: number) => {
      if (isOver || frozen) return

      if (isDeploy) {
        if (!armedType) {
          setHint('先在右侧选择要部署的兵种')
          return
        }
        if (myDeploy?.done) {
          setHint('你已完成部署')
          return
        }
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

      // 1) 选中自己的单位
      if (unit && unit.owner === view.selfId && !unit.acted) {
        setSelectedUnitId(unit.id)
        setSelectedBuildingId(null)
        setHint(null)
        return
      }

      // 2) 攻击射程内的敌人
      if (selectedUnit && unit && unit.owner !== view.selfId && targets.includes(tile)) {
        actions.sendCommand({ type: 'attack', unitId: selectedUnit.id, targetId: unit.id })
        setHint(null)
        return
      }

      // 3) 移动到可达格
      if (selectedUnit && reachable.includes(tile)) {
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
    [actions, armedType, clearSelection, frozen, game, isDeploy, isOver, myDeploy?.done, reachable, selectedUnit, targets, view.myTurn, view.selfId],
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
        <span className="hud-item muted small">房间 {view.roomCode}</span>
        <button type="button" data-testid="leave-button" onClick={() => actions.leave()}>
          离开
        </button>
      </header>

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

      {!view.paused && view.offlinePlayers.length > 0 ? (
        <div className="pause-banner soft" data-testid="offline-hint">
          <span>{view.offlinePlayers.map((p) => nameOf(view, p)).join('、')} 已断线，等待重连…（席位与部队都已保留）</span>
        </div>
      ) : null}

      <div className="game-body">
        <BoardCanvas
          view={boardView}
          onTileClick={onTileClick}
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
                {myDeploy?.done ? '等待对手…' : '完成部署'}
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
                  {view.myTurn ? '轮到你了：点己方单位 → 蓝格移动 / 红格攻击' : '等待对手行动…'}
                </p>
                <div className="score-rows">
                  {game.players.map((p) => (
                    <div key={p} className="score-row" data-testid={'score-' + p}>
                      <span style={{ color: playerColor(game, p) }}>{nameOf(view, p)}</span>
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
                  <p className="muted small" data-testid="pending-list">
                    {game.pending.map((p) => DATA.units[p.type].name).join('、')}
                  </p>
                </section>
              ) : null}
            </>
          )}

          {hint ? <p className="alert notice small" data-testid="game-hint">{hint}</p> : null}
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
            <button type="button" className="primary" data-testid="back-to-lobby" onClick={() => actions.leave()}>
              返回大厅
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
