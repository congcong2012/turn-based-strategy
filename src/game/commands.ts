/** 指令校验与执行：所有客户端指令都必须先过这里（房主权威，GDD 8.3） */

import { DATA, buildingType, getMap, moveCost, unitType } from './data'
import type { GameData } from './data'
import { buildingAt, buildingById, clone, inDeployZone, unitById, unitsOf } from './board'
import { canCounter, computeDamage } from './combat'
import { chebyshevDistance, pathTo } from './movement'
import { currentPlayer, endTurn, makeUnit, resign, startTurn } from './state'
import type { Command, CommandResult, ErrorCode, GameEvent, GameState, PlayerId } from './types'

function ok(state: GameState, events: GameEvent[] = []): CommandResult {
  return { ok: true, state, events }
}
function fail(code: ErrorCode): CommandResult {
  return { ok: false, code }
}

export function applyCommand(state: GameState, playerId: PlayerId, cmd: Command, data: GameData = DATA): CommandResult {
  if (!state.players.includes(playerId)) return fail('TARGET_INVALID')
  if (state.phase === 'GAME_OVER' && cmd.type !== 'resign') return fail('INVALID_PHASE')

  // 部署阶段的指令
  if (state.phase === 'DEPLOY') {
    if (cmd.type === 'resign') {
      const r = resign(state, playerId)
      return ok(r.state, r.events)
    }
    if (cmd.type === 'deploy') return deploy(state, playerId, cmd.unitType, cmd.x, cmd.y, data)
    if (cmd.type === 'deployDone') return deployDone(state, playerId, data)
    return fail('INVALID_PHASE')
  }

  // 投降不受回合归属限制
  if (cmd.type === 'resign') {
    const r = resign(state, playerId)
    return ok(r.state, r.events)
  }

  // 行动阶段：只有当前玩家可以下指令
  if (currentPlayer(state) !== playerId) return fail('NOT_YOUR_TURN')

  switch (cmd.type) {
    case 'move':
      return moveUnit(state, playerId, cmd.unitId, cmd.x, cmd.y, data)
    case 'attack':
      return attackUnit(state, playerId, cmd.unitId, cmd.targetId, data)
    case 'capture':
      return captureBuilding(state, playerId, cmd.unitId, data)
    case 'produce':
      return produceUnit(state, playerId, cmd.buildingId, cmd.unitType, data)
    case 'wait': {
      const unit = unitById(state, cmd.unitId)
      if (!unit) return fail('UNKNOWN_UNIT')
      if (unit.owner !== playerId) return fail('UNIT_NOT_YOURS')
      const s = clone(state)
      const target = unitById(s, cmd.unitId) as NonNullable<ReturnType<typeof unitById>>
      target.acted = true
      return ok(s)
    }
    case 'endTurn': {
      const r = endTurn(state, data)
      return ok(r.state, r.events)
    }
    default:
      return fail('INVALID_PHASE')
  }
}

function deploy(state: GameState, playerId: PlayerId, unitTypeId: string, x: number, y: number, data: GameData): CommandResult {
  const entry = state.deploy[playerId]
  if (!entry) return fail('TARGET_INVALID')
  if (entry.done) return fail('ALREADY_DONE')
  const type = data.units[unitTypeId]
  if (!type) return fail('UNKNOWN_TYPE')
  if (entry.placed >= data.rules.deployMaxUnits) return fail('DEPLOY_MAX_UNITS')
  if (entry.budget < type.cost) return fail('DEPLOY_BUDGET_EXCEEDED')

  const map = getMap(state.mapId, data)
  const playerIndex = state.players.indexOf(playerId)
  if (!inDeployZone(map, playerIndex, x, y)) return fail('DEPLOY_ZONE_INVALID')
  if (moveCost(map, x, y, type.moveType, data) === null) return fail('DEPLOY_ZONE_INVALID')
  if (state.units.some((u) => u.x === x && u.y === y)) return fail('TILE_OCCUPIED')

  const s = clone(state)
  const unit = makeUnit(s, unitTypeId, playerId, x, y, data)
  s.units.push(unit)
  s.deploy[playerId] = { budget: entry.budget - type.cost, placed: entry.placed + 1, done: false }
  s.rev += 1
  return ok(s, [{ type: 'deploy', unitId: unit.id, unitType: unitTypeId, playerId, x, y, cost: type.cost }])
}

function deployDone(state: GameState, playerId: PlayerId, data: GameData): CommandResult {
  const entry = state.deploy[playerId]
  if (!entry) return fail('TARGET_INVALID')
  if (entry.done) return fail('ALREADY_DONE')
  if (unitsOf(state, playerId).length < 1) return fail('NOTHING_TO_DO')

  const s = clone(state)
  s.deploy[playerId] = { ...entry, done: true }
  const events: GameEvent[] = [{ type: 'deployDone', playerId }]

  const allDone = s.players.every((p) => s.deploy[p].done)
  if (allDone) {
    s.phase = 'PLAYING'
    s.turnIndex = 0
    s.round = 1
    s.rev += 1
    const started = startTurn(s, data)
    return ok(started.state, [...events, ...started.events])
  }
  s.rev += 1
  return ok(s, events)
}

function moveUnit(state: GameState, playerId: PlayerId, unitId: string, x: number, y: number, data: GameData): CommandResult {
  const unit = unitById(state, unitId)
  if (!unit) return fail('UNKNOWN_UNIT')
  if (unit.owner !== playerId) return fail('UNIT_NOT_YOURS')
  if (unit.acted) return fail('UNIT_ALREADY_ACTED')
  if (unit.moved) return fail('UNIT_ALREADY_MOVED')
  if (state.units.some((u) => u.x === x && u.y === y)) return fail('TILE_OCCUPIED')
  const path = pathTo(state, unit, x, y, data)
  if (!path) return fail('PATH_BLOCKED')

  const s = clone(state)
  const target = unitById(s, unitId) as NonNullable<ReturnType<typeof unitById>>
  const from = { x: target.x, y: target.y }
  target.x = x
  target.y = y
  target.moved = true
  if (target.capture) target.capture = null // 移动打断占领
  s.rev += 1
  return ok(s, [{ type: 'move', unitId, playerId, from, to: { x, y } }])
}

function attackUnit(state: GameState, playerId: PlayerId, unitId: string, targetId: string, data: GameData): CommandResult {
  const attacker = unitById(state, unitId)
  const defender = unitById(state, targetId)
  if (!attacker || !defender) return fail('UNKNOWN_UNIT')
  if (attacker.owner !== playerId) return fail('UNIT_NOT_YOURS')
  if (defender.owner === playerId) return fail('TARGET_INVALID')
  if (attacker.acted) return fail('UNIT_ALREADY_ACTED')

  const type = unitType(attacker.type, data)
  if (type.attack === 'indirect' && attacker.moved) return fail('INDIRECT_MOVED')
  const distance = chebyshevDistance(attacker, defender)
  if (distance < type.rangeMin || distance > type.rangeMax) return fail('OUT_OF_RANGE')

  const s = clone(state)
  const atk = unitById(s, unitId) as NonNullable<ReturnType<typeof unitById>>
  const def = unitById(s, targetId) as NonNullable<ReturnType<typeof unitById>>
  const destroyed: string[] = []

  const damage = computeDamage(s, atk, def, data)
  def.hp -= damage
  if (def.hp <= 0) {
    destroyed.push(def.id)
    s.units = s.units.filter((u) => u.id !== def.id)
  }

  let counterDamage = 0
  if (def.hp > 0 && canCounter(atk, def, data)) {
    counterDamage = computeDamage(s, def, atk, data)
    atk.hp -= counterDamage
    if (atk.hp <= 0) {
      destroyed.push(atk.id)
      s.units = s.units.filter((u) => u.id !== atk.id)
    }
  }
  const stillAlive = unitById(s, unitId)
  if (stillAlive) {
    stillAlive.acted = true
    if (stillAlive.capture) stillAlive.capture = null
  }
  s.rev += 1
  return ok(s, [{ type: 'attack', attackerId: unitId, defenderId: targetId, damage, counterDamage, destroyed }])
}

function captureBuilding(state: GameState, playerId: PlayerId, unitId: string, data: GameData): CommandResult {
  const unit = unitById(state, unitId)
  if (!unit) return fail('UNKNOWN_UNIT')
  if (unit.owner !== playerId) return fail('UNIT_NOT_YOURS')
  if (unit.acted) return fail('UNIT_ALREADY_ACTED')
  if (!unitType(unit.type, data).capture) return fail('CANNOT_CAPTURE')
  const building = buildingAt(state, unit.x, unit.y)
  if (!building) return fail('NOT_A_BUILDING')
  if (building.owner === playerId) return fail('NOTHING_TO_DO')

  const s = clone(state)
  const target = buildingById(s, building.id) as NonNullable<ReturnType<typeof buildingById>>
  const carried = target.capture && target.capture.playerId === playerId ? target.capture.points : 0
  const points = carried + Math.floor(unit.hp / 10)
  target.capture = { playerId, points, unitId }
  const capturer = unitById(s, unitId) as NonNullable<ReturnType<typeof unitById>>
  capturer.acted = true
  s.rev += 1
  return ok(s, [
    {
      type: 'capture',
      unitId,
      buildingId: building.id,
      playerId,
      points,
      captured: points >= data.rules.capturePoints,
    },
  ])
}

function produceUnit(state: GameState, playerId: PlayerId, buildingId: string, unitTypeId: string, data: GameData): CommandResult {
  const building = buildingById(state, buildingId)
  if (!building) return fail('NOT_A_BUILDING')
  if (!buildingType(building.type, data).produce) return fail('NOT_A_BUILDING')
  if (building.owner !== playerId) return fail('BUILDING_NOT_OWNED')
  const type = data.units[unitTypeId]
  if (!type) return fail('UNKNOWN_TYPE')
  if ((state.funds[playerId] ?? 0) < type.cost) return fail('INSUFFICIENT_FUNDS')
  const orderedThisTurn = state.pending.filter(
    (p) => p.buildingId === buildingId && p.owner === playerId && p.turnSeq === state.turnSeq,
  ).length
  if (orderedThisTurn >= data.rules.unitsPerBarracksPerTurn) return fail('ALREADY_DONE')
  const total = unitsOf(state, playerId).length + state.pending.filter((p) => p.owner === playerId).length
  if (total >= data.rules.unitCap) return fail('UNIT_CAP_REACHED')

  const s = clone(state)
  s.funds[playerId] = (s.funds[playerId] ?? 0) - type.cost
  s.pending.push({ id: 'u' + s.nextSeq, type: unitTypeId, owner: playerId, buildingId, turnSeq: s.turnSeq })
  s.nextSeq += 1
  s.rev += 1
  return ok(s, [{ type: 'produce', buildingId, unitType: unitTypeId, playerId, cost: type.cost }])
}
