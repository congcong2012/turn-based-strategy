/**
 * 战报与最近事件的纯函数累积器。
 *
 * 联机（roomSession）与单人（pveSession）共用同一份实现，保证：
 *  - 同一批 GameEvent 得到**逐字一致**的中文战报；
 *  - 裁剪语义一致（最近事件留 12 条、最近战报留 60 条）；
 *  - seq 单调递增，渲染层据此"每条事件只播一次动画/音效"。
 *
 * ★ **两套战报，别搞混**（2026-10-10 引入完整战报时分开）：
 *  - `log`：**滚动窗口**，只留最近 `LOG_LIMIT` 条。给屏幕边角的"最近战报"用 ——
 *    那里要的是"刚刚发生了什么"，越短越好。
 *  - `fullLog` / `rounds`：**整局完整战报**（`rounds` 是按回合分组的同一份内容）。
 *    给"完整战斗日志"面板用 —— 玩家要的是"回看整局怎么打的"。
 *
 *  ★ 完整战报必须由**房主**权威维护、并随 `state` 一起广播，不能让各端自己攒：
 *    中途加入 / 刷新时房主只补发 `state`（见 roomSession 的 hello 分支），
 *    客户端手上的事件流**本来就不完整** —— 自己攒一定会少算。
 *    房主从头在跑，它手里的才是全的；随 `state` 下发，任何人任何时候都是完整的。
 */

import { buildingType, unitType } from './data'
import { describeEvent } from './logText'
import type { LogContext } from './logText'
import type { GameEvent, GameState, PlayerId } from './types'

export type LoggedEvent = { seq: number; event: GameEvent }

/**
 * 按回合分组的一段战报。
 *
 * ★ 用 `type` 而不是 `interface`：它会随 `Wire` 消息经 Trystero 序列化（WebRTC 数据通道），
 *   而 Trystero 的载荷类型要求能赋给 `{ [key: string]: JsonValue }` ——
 *   **interface 没有隐式索引签名**，会被判不兼容（踩过）。type 别名是结构化类型，可以直接过。
 */
export type LogRound = {
  /** 回合号（0 = 开局部署） */
  round: number
  /** 该回合内的战报（按时间顺序） */
  lines: string[]
}

export interface Journal {
  /** 最近战报（滚动窗口，最多 LOG_LIMIT 条） */
  log: string[]
  /** ★ 整局完整战报（不裁剪，仅受 FULL_LOG_LIMIT 防御性封顶） */
  fullLog: string[]
  /** ★ 整局战报按回合分组（与 fullLog 同源，只是加了回合边界） */
  rounds: LogRound[]
  events: LoggedEvent[]
  /** 已分配的最大事件序号 */
  seq: number
}

/** 最近战报保留条数（给角标小列表用） */
export const LOG_LIMIT = 60
/** 原始事件保留条数 */
export const EVENT_LIMIT = 12
/**
 * 完整战报的安全上限。
 *
 * 不是"只想留这么多"，而是"正常不可能碰到" —— 一局几十回合也就几百条。
 * 设上限纯为防御异常（比如某个 bug 导致无限追加）把广播消息撑爆。
 */
export const FULL_LOG_LIMIT = 2000
/** 分组上限（同理，纯防御） */
export const ROUND_LIMIT = 200

export function emptyJournal(): Journal {
  return { log: [], fullLog: [], rounds: [], events: [], seq: 0 }
}

/**
 * 追加一批事件，返回新的 Journal（不修改入参）。
 *
 * @param before 变更前的状态：用于解析"已被歼灭的单位 / 已易主据点"的名字
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

  // 逐事件求文案（而不是 describeEvents 那种"先 map 再 filter"）：
  // 分组要"事件 → 文案"一一对应，不能让空文案把下标错开。
  const fresh: string[] = []
  const roundOfLine: number[] = []
  let cursor = journal.rounds.length > 0 ? journal.rounds[journal.rounds.length - 1].round : 0
  for (const event of events) {
    if (event.type === 'turnStart') cursor = event.round
    const text = describeEvent(event, ctx)
    if (text.length === 0) continue
    fresh.push(text)
    roundOfLine.push(cursor)
  }

  const log = [...journal.log, ...fresh].slice(-LOG_LIMIT)
  const fullLog = [...journal.fullLog, ...fresh].slice(-FULL_LOG_LIMIT)

  // 分组：按上面的"每行所属回合"归并；同一回合的行追加到同一组
  const rounds: LogRound[] = journal.rounds.map((r) => ({ round: r.round, lines: [...r.lines] }))
  for (let i = 0; i < fresh.length; i += 1) {
    const round = roundOfLine[i]
    const last = rounds[rounds.length - 1]
    if (!last || last.round !== round) rounds.push({ round, lines: [fresh[i]] })
    else last.lines.push(fresh[i])
  }

  let seq = journal.seq
  const logged: LoggedEvent[] = events.map((event) => {
    seq += 1
    return { seq, event }
  })

  return {
    log,
    fullLog,
    rounds: rounds.slice(-ROUND_LIMIT),
    events: [...journal.events, ...logged].slice(-EVENT_LIMIT),
    seq,
  }
}
