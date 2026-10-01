/**
 * 战报与最近事件的纯函数累积器。
 *
 * 联机（roomSession）与单人（pveSession）共用同一份实现，保证：
 *  - 同一批 GameEvent 得到**逐字一致**的中文战报；
 *  - 裁剪语义一致（战报留最近 60 条、原始事件留最近 12 条）；
 *  - seq 单调递增，渲染层据此"每条事件只播一次动画/音效"。
 */

import { buildingType, unitType } from './data'
import { describeEvents } from './logText'
import type { LogContext } from './logText'
import type { GameEvent, GameState, PlayerId } from './types'

export type LoggedEvent = { seq: number; event: GameEvent }

export interface Journal {
  log: string[]
  events: LoggedEvent[]
  /** 已分配的最大事件序号 */
  seq: number
}

/** 战报保留条数（与旧 roomSession 行为一致） */
export const LOG_LIMIT = 60
/** 原始事件保留条数（与旧 roomSession 行为一致） */
export const EVENT_LIMIT = 12

export function emptyJournal(): Journal {
  return { log: [], events: [], seq: 0 }
}

/**
 * 追加一批事件，返回新的 Journal（不修改入参）。
 *
 * @param before 变更前的状态：用于解析"已被歼灭的单位 / 已易主的据点"的名字
 * @param nameOf 玩家 id → 昵称
 */
export function appendJournal(
  journal: Journal,
  events: GameEvent[],
  before: GameState | null,
  after: GameState,
  nameOf: (playerId: PlayerId) => string,
): Journal {
  if (events.length === 0) return journal

  const ctx: LogContext = {
    unitName: (unitId) => {
      const unit = before?.units.find((u) => u.id === unitId) ?? after.units.find((u) => u.id === unitId)
      if (!unit) return '某部队'
      return unitType(unit.type).name + '·' + nameOf(unit.owner)
    },
    buildingName: (buildingId) => {
      const building =
        before?.buildings.find((b) => b.id === buildingId) ?? after.buildings.find((b) => b.id === buildingId)
      return building ? buildingType(building.type).name : '据点'
    },
    playerName: nameOf,
  }

  const log = [...journal.log, ...describeEvents(events, ctx)].slice(-LOG_LIMIT)

  let seq = journal.seq
  const logged: LoggedEvent[] = events.map((event) => {
    seq += 1
    return { seq, event }
  })

  return { log, events: [...journal.events, ...logged].slice(-EVENT_LIMIT), seq }
}
