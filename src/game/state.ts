/** 回合状态机与经济（GDD 3.2 / 6 / 9）——全部为纯函数：输入状态 → 新状态 + 事件 */

import { DATA, buildingType, getMap, initialBuildings, unitType } from './data'
import type { GameData } from './data'
import { buildingById, clone } from './board'
import type { GameEvent, GameState, PlayerId, Unit } from './types'

function nextUnitId(state: GameState): string {
  const id = 'u' + state.nextSeq
  state.nextSeq += 1
  return id
}

export function createGame(mapId: string, players: PlayerId[], data: GameData = DATA): GameState {
  const map = getMap(mapId, data)
  const deploy: GameState['deploy'] = {}
  const funds: Record<PlayerId, number> = {}
  for (const p of players) {
    deploy[p] = { budget: data.rules.deployBudget, placed: 0, done: false }
    funds[p] = data.rules.startFunds
  }
  return {
    rev: 0,
    mapId,
    players,
    units: [],
    buildings: initialBuildings(map, players),
    funds,
    pending: [],
    turnIndex: 0,
    round: 1,
    phase: 'DEPLOY',
    turnPhase: 'ACTION',
    deploy,
    winner: null,
    winReason: null,
    nextSeq: 1,
  }
}

export function currentPlayer(state: GameState): PlayerId {
  return state.players[state.turnIndex]
}

export function incomeOf(state: GameState, playerId: PlayerId, data: GameData = DATA): number {
  let total = 0
  for (const b of state.buildings) {
    if (b.owner === playerId) total += buildingType(b.type, data).income
  }
  return total
}

/** START 阶段：生产出场 → 收入 → 据点维修 → 复位行动标记 */
export function startTurn(state: GameState, data: GameData = DATA): { state: GameState; events: GameEvent[] } {
  const s = clone(state)
  const events: GameEvent[] = []
  const player = s.players[s.turnIndex]
  s.turnPhase = 'START'

  // 1) 生产队列出场（出兵格被占则顺延）
  const remaining: typeof s.pending = []
  for (const item of s.pending) {
    if (item.owner !== player) {
      remaining.push(item)
      continue
    }
    const building = buildingById(s, item.buildingId)
    const blocked = !building || building.owner !== player || s.units.some((u) => u.x === building.x && u.y === building.y)
    if (blocked) {
      remaining.push(item)
      continue
    }
    const type = unitType(item.type, data)
    const unit: Unit = {
      id: item.id,
      type: item.type,
      owner: item.owner,
      x: building.x,
      y: building.y,
      hp: type.hp,
      moved: false,
      acted: false,
      capture: null,
    }
    s.units.push(unit)
    events.push({ type: 'spawn', unitId: unit.id, unitType: unit.type, playerId: item.owner, x: building.x, y: building.y })
  }
  s.pending = remaining

  // 2) 收入
  const income = incomeOf(s, player, data)
  s.funds[player] = (s.funds[player] ?? 0) + income
  events.push({ type: 'income', playerId: player, amount: income })

  // 3) 据点维修（站在己方据点上回血）
  for (const unit of s.units) {
    if (unit.owner !== player) continue
    const building = s.buildings.find((b) => b.x === unit.x && b.y === unit.y && b.owner === player)
    if (!building) continue
    const type = unitType(unit.type, data)
    const amount = Math.min(buildingType(building.type, data).repair, type.hp - unit.hp)
    if (amount > 0) {
      unit.hp += amount
      events.push({ type: 'repair', unitId: unit.id, amount })
    }
  }

  // 4) 复位本回合行动标记
  for (const unit of s.units) {
    if (unit.owner === player) {
      unit.moved = false
      unit.acted = false
    }
  }

  s.turnPhase = 'ACTION'
  events.push({ type: 'turnStart', playerId: player, round: s.round })
  return { state: s, events }
}

export function scoreOf(state: GameState, playerId: PlayerId, data: GameData = DATA): number {
  let total = 0
  for (const b of state.buildings) {
    if (b.owner !== playerId) continue
    total += b.type === 'hq' ? 5 : b.type === 'barracks' ? 3 : 1
  }
  const unitCost = state.units
    .filter((u) => u.owner === playerId)
    .reduce((sum, u) => sum + unitType(u.type, data).cost, 0)
  return total + Math.floor(unitCost / 1000) + Math.floor((state.funds[playerId] ?? 0) / 1000)
}

/** 胜负判定：斩首 → 歼灭 → （回合上限时另行计分） */
function applyWinCheck(s: GameState, events: GameEvent[], data: GameData = DATA): void {
  if (s.phase === 'GAME_OVER') return
  for (const b of s.buildings) {
    if (b.type === 'hq' && b.owner !== null && s.players.length > 1) {
      const original = getMap(s.mapId, data).buildings.find((x) => x.id === b.id)?.owner
      const originalPlayer = original === null || original === undefined ? null : s.players[original]
      if (originalPlayer && originalPlayer !== b.owner) {
        s.phase = 'GAME_OVER'
        s.winner = b.owner
        s.winReason = 'hq_captured'
        events.push({ type: 'gameOver', winner: b.owner, reason: 'hq_captured' })
        return
      }
    }
  }
  for (const p of s.players) {
    if (s.units.every((u) => u.owner !== p)) {
      const winner = s.players.find((x) => x !== p) ?? null
      s.phase = 'GAME_OVER'
      s.winner = winner
      s.winReason = 'annihilation'
      events.push({ type: 'gameOver', winner, reason: 'annihilation' })
      return
    }
  }
}

/** RESOLVE 阶段：清理阵亡 → 占领易主 → 胜负判定 */
export function resolveTurn(state: GameState, data: GameData = DATA): { state: GameState; events: GameEvent[] } {
  const s = clone(state)
  const events: GameEvent[] = []
  s.turnPhase = 'RESOLVE'
  s.units = s.units.filter((u) => u.hp > 0)

  for (const building of s.buildings) {
    const capture = building.capture
    if (!capture || capture.points < data.rules.capturePoints) continue
    const previous = building.owner
    building.owner = capture.playerId
    building.capture = null
    events.push({
      type: 'capture',
      unitId: capture.unitId,
      buildingId: building.id,
      playerId: capture.playerId,
      points: capture.points,
      captured: true,
    })
    void previous
  }

  applyWinCheck(s, events, data)
  return { state: s, events }
}

/** HANDOVER + 下一回合 START */
export function endTurn(state: GameState, data: GameData = DATA): { state: GameState; events: GameEvent[] } {
  const resolved = resolveTurn(state, data)
  const events = [...resolved.events]
  let s = resolved.state
  if (s.phase === 'GAME_OVER') return { state: s, events }

  s.turnPhase = 'HANDOVER'
  events.push({ type: 'turnEnd', playerId: s.players[s.turnIndex] })

  const nextIndex = (s.turnIndex + 1) % s.players.length
  if (nextIndex === 0) {
    s.round += 1
    if (s.round > data.rules.roundLimit) {
      const scored = s.players.map((p) => ({ p, score: scoreOf(s, p, data) }))
      scored.sort((a, b) => b.score - a.score)
      const top = scored[0]
      const tied = scored.filter((x) => x.score === top.score).length > 1
      s.phase = 'GAME_OVER'
      s.winner = tied ? null : top.p
      s.winReason = 'score'
      events.push({ type: 'gameOver', winner: s.winner, reason: 'score' })
      return { state: s, events }
    }
  }
  s.turnIndex = nextIndex
  const started = startTurn(s, data)
  return { state: started.state, events: [...events, ...started.events] }
}

export function resign(state: GameState, playerId: PlayerId): { state: GameState; events: GameEvent[] } {
  const s = clone(state)
  const winner = s.players.find((p) => p !== playerId) ?? null
  s.phase = 'GAME_OVER'
  s.winner = winner
  s.winReason = 'resign'
  return { state: s, events: [{ type: 'gameOver', winner, reason: 'resign' }] }
}

export function makeUnit(state: GameState, typeId: string, owner: PlayerId, x: number, y: number, data: GameData = DATA): Unit {
  const type = unitType(typeId, data)
  return { id: nextUnitId(state), type: typeId, owner, x, y, hp: type.hp, moved: false, acted: false, capture: null }
}
