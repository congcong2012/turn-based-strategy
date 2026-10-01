/**
 * 合法指令枚举（纯函数）。
 *
 * 用途：给 AI 提供"当前能做什么"的候选集，也便于测试与调试。
 *
 * **核心不变量**：本模块返回的每一条指令，都必须能被
 * `applyCommand(state, playerId, cmd, data)` 以 `ok: true` 接受。
 * 因此这里的每条校验都与 commands.ts 的处理器一一对应（改规则时两边要一起改）；
 * `tests/unit/game/legalCommands.test.ts` 会逐条断言这个不变量。
 *
 * 注意：**不包含 `resign`** —— 它是玩家的逃生口，AI 永不投降
 * （否则"枚举候选"会顺带枚举出"自杀"）。
 */

import { DATA, buildingType, getMap, moveCost, unitType } from './data'
import type { GameData } from './data'
import { buildingAt, inDeployZone, unitsOf } from './board'
import { attackableTargets, reachableDestinations } from './movement'
import { currentPlayer } from './state'
import type { Command, GameState, PlayerId } from './types'

/**
 * 部署阶段：当前可下的全部部署指令（含 deployDone）。
 * 与 commands.ts 的 deploy / deployDone 校验一致：
 * 未确认、预算够、未超单位上限、落在己方部署区、该兵种可通行、格子无人。
 */
export function deployCommandsFor(state: GameState, playerId: PlayerId, data: GameData = DATA): Command[] {
  const entry = state.deploy[playerId]
  if (!entry || entry.done) return []

  const map = getMap(state.mapId, data)
  const playerIndex = state.players.indexOf(playerId)
  const out: Command[] = []

  if (entry.placed < data.rules.deployMaxUnits) {
    for (const type of data.unitList) {
      if (entry.budget < type.cost) continue
      for (let y = 0; y < map.height; y += 1) {
        for (let x = 0; x < map.width; x += 1) {
          if (!inDeployZone(map, playerIndex, x, y)) continue
          if (moveCost(map, x, y, type.moveType, data) === null) continue
          if (state.units.some((u) => u.x === x && u.y === y)) continue
          out.push({ type: 'deploy', unitType: type.id, x, y })
        }
      }
    }
  }

  // 必须先有至少 1 个单位才能确认（否则内核返回 NOTHING_TO_DO）
  if (unitsOf(state, playerId).length >= 1) out.push({ type: 'deployDone' })
  return out
}

/**
 * 行动阶段：当前玩家的全部可执行指令（末尾恒含 `endTurn`）。
 * 非当前玩家返回空数组（对应内核的 NOT_YOUR_TURN）。
 */
export function playCommandsFor(state: GameState, playerId: PlayerId, data: GameData = DATA): Command[] {
  if (currentPlayer(state) !== playerId) return []
  const out: Command[] = []

  for (const unit of unitsOf(state, playerId)) {
    if (unit.acted) continue

    // 移动（每单位每回合至多一次）
    if (!unit.moved) {
      for (const dest of reachableDestinations(state, unit, data)) {
        out.push({ type: 'move', unitId: unit.id, x: dest.x, y: dest.y })
      }
    }

    // 攻击（attackableTargets 已排除友军，并处理"间接单位移动后不可攻击"）
    for (const target of attackableTargets(state, unit, data)) {
      out.push({ type: 'attack', unitId: unit.id, targetId: target.id })
    }

    // 占领：兵种可占领 + 脚下有据点 + 据点不属于自己
    if (unitType(unit.type, data).capture) {
      const building = buildingAt(state, unit.x, unit.y)
      if (building && building.owner !== playerId) out.push({ type: 'capture', unitId: unit.id })
    }

    // 给每个单位一个终结动作：否则"无事可做"的单位会让回合卡住
    out.push({ type: 'wait', unitId: unit.id })
  }

  // 生产：己方兵营、本回合配额未满、未达单位上限、资金足够
  for (const building of state.buildings) {
    if (building.owner !== playerId) continue
    if (!buildingType(building.type, data).produce) continue

    const orderedThisTurn = state.pending.filter(
      (p) => p.buildingId === building.id && p.owner === playerId && p.turnSeq === state.turnSeq,
    ).length
    if (orderedThisTurn >= data.rules.unitsPerBarracksPerTurn) continue

    const total = unitsOf(state, playerId).length + state.pending.filter((p) => p.owner === playerId).length
    if (total >= data.rules.unitCap) continue

    for (const type of data.unitList) {
      if ((state.funds[playerId] ?? 0) < type.cost) continue
      out.push({ type: 'produce', buildingId: building.id, unitType: type.id })
    }
  }

  out.push({ type: 'endTurn' })
  return out
}

/** 按当前阶段分派；非本局玩家或对局已结束返回空数组 */
export function legalCommandsFor(state: GameState, playerId: PlayerId, data: GameData = DATA): Command[] {
  if (!state.players.includes(playerId)) return []
  if (state.phase === 'GAME_OVER') return []
  if (state.phase === 'DEPLOY') return deployCommandsFor(state, playerId, data)
  return playCommandsFor(state, playerId, data)
}
