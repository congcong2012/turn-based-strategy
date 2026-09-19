/** 回合状态机与经济（GDD 3.2 / 6 / 9）——全部为纯函数：输入状态 → 新状态 + 事件 */

import { DATA, buildingType, getMap, initialBuildings, moveCost, unitType } from './data'
import type { GameData } from './data'
import { buildingById, clone, mapOf } from './board'
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
    turnSeq: 0,
    phase: 'DEPLOY',
    turnPhase: 'ACTION',
    deploy,
    eliminated: [],
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
  s.turnSeq += 1
  s.turnPhase = 'START'

  // 1) 生产队列出场
  //    出兵位：优先兵营格本身，其次兵营四邻的空格（这样一座兵营一回合能出 2 个兵）；
  //    都不可用则顺延到下一回合。
  const remaining: typeof s.pending = []
  for (const item of s.pending) {
    if (item.owner !== player) {
      remaining.push(item)
      continue
    }
    const building = buildingById(s, item.buildingId)
    if (!building || building.owner !== player) {
      remaining.push(item)
      continue
    }
    const type = unitType(item.type, data)
    const occupied = (x: number, y: number) => s.units.some((u) => u.x === x && u.y === y)
    const candidates = [
      { x: building.x, y: building.y },
      { x: building.x, y: building.y - 1 },
      { x: building.x + 1, y: building.y },
      { x: building.x, y: building.y + 1 },
      { x: building.x - 1, y: building.y },
    ]
    const spot = candidates.find((c) => {
      if (occupied(c.x, c.y)) return false
      return moveCost(mapOf(s, data), c.x, c.y, type.moveType, data) !== null
    })
    if (!spot) {
      remaining.push(item)
      continue
    }
    const unit: Unit = {
      id: item.id,
      type: item.type,
      owner: item.owner,
      x: spot.x,
      y: spot.y,
      hp: type.hp,
      moved: false,
      acted: false,
      capture: null,
    }
    s.units.push(unit)
    events.push({ type: 'spawn', unitId: unit.id, unitType: unit.type, playerId: item.owner, x: spot.x, y: spot.y })
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

export function survivors(state: GameState): PlayerId[] {
  return state.players.filter((p) => !state.eliminated.includes(p))
}

/** 淘汰一名玩家：部队撤离、据点归中立（便于他人接管） */
function eliminate(s: GameState, playerId: PlayerId, reason: 'hq_captured' | 'annihilation' | 'resign', events: GameEvent[]): void {
  if (s.eliminated.includes(playerId)) return
  s.eliminated = [...s.eliminated, playerId]
  s.units = s.units.filter((u) => u.owner !== playerId)
  s.buildings = s.buildings.map((b) => (b.owner === playerId ? { ...b, owner: null, capture: null } : b))
  s.pending = s.pending.filter((p) => p.owner !== playerId)
  events.push({ type: 'eliminated', playerId, reason })
  s.lastElimination = reason
}

function finishGame(s: GameState, events: GameEvent[]): void {
  const alive = survivors(s)
  const reason = (s.lastElimination ?? 'annihilation') as 'hq_captured' | 'annihilation' | 'resign'
  s.phase = 'GAME_OVER'
  s.winner = alive.length === 1 ? alive[0] : null
  s.winReason = alive.length === 1 ? reason : 'score'
  events.push({ type: 'gameOver', winner: s.winner, reason: s.winReason })
}

/**
 * 胜负判定（支持 2–4 人）：
 *  - 王城被敌方占领 → 原主被淘汰（其部队撤离、其余据点归中立）
 *  - 场上无任何部队 → 该玩家被淘汰
 *  - 只剩一名存活者 → 该玩家获胜；回合上限时按幸存者计分
 */
function applyWinCheck(s: GameState, events: GameEvent[], data: GameData = DATA): void {
  if (s.phase === 'GAME_OVER') return

  const map = getMap(s.mapId, data)
  for (const b of s.buildings) {
    if (b.type !== 'hq' || b.owner === null) continue
    const originalIndex = map.buildings.find((x) => x.id === b.id)?.owner
    const originalPlayer = originalIndex === null || originalIndex === undefined ? null : s.players[originalIndex]
    if (originalPlayer && originalPlayer !== b.owner) eliminate(s, originalPlayer, 'hq_captured', events)
  }

  for (const p of s.players) {
    if (s.eliminated.includes(p)) continue
    if (s.units.every((u) => u.owner !== p)) eliminate(s, p, 'annihilation', events)
  }

  if (survivors(s).length <= 1) finishGame(s, events)
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

  // 找下一个存活玩家（跳过已淘汰者），并判断是否绕回第一个玩家
  let nextIndex = s.turnIndex
  let wrapped = false
  for (let step = 1; step <= s.players.length; step += 1) {
    const candidate = (s.turnIndex + step) % s.players.length
    if (candidate <= s.turnIndex) wrapped = true
    if (!s.eliminated.includes(s.players[candidate])) {
      nextIndex = candidate
      break
    }
  }
  if (wrapped) {
    s.round += 1
    if (s.round > data.rules.roundLimit) {
      const scored = survivors(s).map((p) => ({ p, score: scoreOf(s, p, data) }))
      scored.sort((a, b) => b.score - a.score)
      const top = scored[0]
      const tied = scored.filter((x) => x.score === top.score).length > 1
      s.phase = 'GAME_OVER'
      s.winner = tied || !top ? null : top.p
      s.winReason = 'score'
      events.push({ type: 'gameOver', winner: s.winner, reason: 'score' })
      return { state: s, events }
    }
  }
  s.turnIndex = nextIndex
  const started = startTurn(s, data)
  return { state: started.state, events: [...events, ...started.events] }
}

/** 投降：该玩家被淘汰；若只剩一名存活者则其获胜，否则对局继续 */
export function resign(state: GameState, playerId: PlayerId, data: GameData = DATA): { state: GameState; events: GameEvent[] } {
  const s = clone(state)
  const events: GameEvent[] = []
  if (!s.eliminated.includes(playerId)) {
    s.eliminated = [...s.eliminated, playerId]
    s.units = s.units.filter((u) => u.owner !== playerId)
    s.buildings = s.buildings.map((b) => (b.owner === playerId ? { ...b, owner: null, capture: null } : b))
    s.pending = s.pending.filter((p) => p.owner !== playerId)
    events.push({ type: 'eliminated', playerId, reason: 'resign' })
  }
  const alive = survivors(s)
  if (alive.length <= 1) {
    s.phase = 'GAME_OVER'
    s.winner = alive[0] ?? null
    s.winReason = 'resign'
    events.push({ type: 'gameOver', winner: s.winner, reason: 'resign' })
    return { state: s, events }
  }
  // 还有多人存活：如果轮到的正是投降者，把回合交给下一位
  if (s.players[s.turnIndex] === playerId) {
    return endTurn(s, data)
  }
  return { state: s, events }
}

export function makeUnit(state: GameState, typeId: string, owner: PlayerId, x: number, y: number, data: GameData = DATA): Unit {
  const type = unitType(typeId, data)
  return { id: nextUnitId(state), type: typeId, owner, x, y, hp: type.hp, moved: false, acted: false, capture: null }
}
