/**
 * 局面摘要：把内部 `GameState` 压成一份**给大模型看的短文本数据**。
 *
 * ## 为什么要单独一层"摘要"而不是直接把 state 丢给 LLM
 *
 * 1. **省 token**：完整 state 是几千行的嵌套结构（每个单位、每个据点、每格地形），
 *    直接喂过去又贵又慢，还容易让模型抓不住重点。
 * 2. **防越权**：摘要里**只有聚合数字与短枚举**，没有坐标、没有单位 id、
 *    没有任何可以被当作指令的文本 —— 从源头堵死"LLM 直接指挥部队"这条路。
 * 3. **可测**：纯函数，能完全单测（含镜像对称性）。
 *
 * ## 对称性约束
 *
 * 敌我两边的数字**必须用同一套函数计算**，否则摘要会泄漏"哪边是我"之外的信息
 * （例如"我方兵力用造价、敌方用个数"），让 LLM 的倾向建立在不对称的数据上。
 * `digest.test.ts` 有一条镜像断言守着这条。
 *
 * ⚠️ 本文件严禁调用 `applyCommand`（会深克隆整个状态）；必须是纯读。
 */

import { unitType } from '../../game/data'
import type { GameData } from '../../game/data'
import { chebyshevDistance } from '../../game/movement'
import { scoreOf } from '../../game/state'
import type { GameState, PlayerId } from '../../game/types'

/** 兵力对比的定性结论 */
export type Balance = 'ahead' | 'behind' | 'even'

export interface AdvisorDigest {
  /** 当前回合数 */
  round: number
  /** 距回合上限还剩几回合（兜底计分触发点） */
  roundsLeft: number
  /** 当前阶段（部署 / 行动） */
  phase: 'deploy' | 'action'
  /** 我方 */
  mine: SideDigest
  /** 敌方（多方局取"合计"） */
  foes: SideDigest
  /** 兵力对比（按兵力值） */
  balance: Balance
  /** 我方王城是否安全（false = 正被占领或已失去） */
  hqSafe: boolean
  /** 我方处于"会被打死"险境的单位数 */
  exposedUnits: number
  /** 敌方单位到我方王城的最近距离（无王城时为 -1） */
  foeDistanceToMyHq: number
  /** 我方单位到敌方王城的最近距离（无敌方王城时为 -1） */
  myDistanceToFoeHq: number
  /** 比分态势（按终局计分口径） */
  scoreLead: Balance
}

/** 单方的聚合数字（敌我共用同一套计算，保证对称） */
export interface SideDigest {
  /** 单位数 */
  units: number
  /** 兵力值：兵力 = Σ 单位造兵价 × (当前HP / 满HP) */
  power: number
  /** 军费 */
  funds: number
  /** 据点：村 / 兵营 / 王城 的个数 */
  villages: number
  barracks: number
  hq: number
  /** 正在占领的据点进度合计（点数） */
  capturePressure: number
}

/** 难度用的"回合上限"来自数据集；这里只读，不硬编码 */
const NEAR_HQ_RANGE = 12

function emptySide(): SideDigest {
  return { units: 0, power: 0, funds: 0, villages: 0, barracks: 0, hq: 0, capturePressure: 0 }
}

/** 统计一方（一个或多个 playerId）的聚合数字 */
function summarize(state: GameState, owners: readonly PlayerId[], data: GameData): SideDigest {
  const side = emptySide()
  const isMine = (id: PlayerId | null): boolean => id !== null && owners.includes(id)

  for (const unit of state.units) {
    if (!isMine(unit.owner)) continue
    const type = unitType(unit.type, data)
    side.units += 1
    side.power += type.cost * (unit.hp / type.hp)
  }

  for (const owner of owners) side.funds += state.funds[owner] ?? 0
  for (const order of state.pending) {
    if (!isMine(order.owner)) continue
    // 已付款未出场：算进兵力（否则"钱变兵"的过程在 LLM 眼里是凭空消失）
    side.power += unitType(order.type, data).cost
  }

  for (const building of state.buildings) {
    if (!isMine(building.owner)) continue
    if (building.type === 'hq') side.hq += 1
    else if (building.type === 'barracks') side.barracks += 1
    else side.villages += 1
    if (building.capture && building.capture.playerId !== null && owners.includes(building.capture.playerId)) {
      side.capturePressure += building.capture.points
    }
  }

  return side
}

function compare(mine: number, foes: number, epsilon = 1): Balance {
  if (mine > foes + epsilon) return 'ahead'
  if (foes > mine + epsilon) return 'behind'
  return 'even'
}

/** 一组单位里，能被敌方"乐观够到且致死"的个数（与评估器 E4 同口径的粗略版） */
function countExposed(state: GameState, playerId: PlayerId, foes: readonly PlayerId[], data: GameData): number {
  let count = 0
  for (const unit of state.units) {
    if (unit.owner !== playerId) continue
    let incoming = 0
    for (const foe of state.units) {
      if (!foes.includes(foe.owner)) continue
      const foeType = unitType(foe.type, data)
      if (chebyshevDistance(foe, unit) > foeType.move + foeType.rangeMax) continue
      // 粗略：按攻击力估算（精确伤害需要地形与克制表，这里只要"像要死"）
      incoming += foeType.cost * 0.25
    }
    if (incoming >= unit.hp) count += 1
  }
  return count
}

/** 到最近一座"指定归属"王城的距离（没有则该方向取 -1） */
function nearestHqDistance(state: GameState, from: PlayerId, hqOwner: 'mine' | 'foes', foes: readonly PlayerId[]): number {
  // "我方的单位 → 敌方王城" 或 "敌方单位 → 我方王城"
  const targets = state.buildings.filter((b) =>
    b.type === 'hq' && (hqOwner === 'mine' ? b.owner === from : b.owner !== null && foes.includes(b.owner)),
  )
  if (targets.length === 0) return -1
  const movers = state.units.filter((u) => (hqOwner === 'mine' ? u.owner === from : foes.includes(u.owner)))
  if (movers.length === 0) return -1
  let best = Infinity
  for (const unit of movers) {
    for (const hq of targets) best = Math.min(best, chebyshevDistance(unit, hq))
  }
  return Number.isFinite(best) ? best : -1
}

export interface DigestInput {
  state: GameState
  playerId: PlayerId
  data: GameData
}

/**
 * 构造摘要。`foes` = 除自己以外的全部玩家（多方局即"其余所有人合计"）。
 *
 * 注意：多方局里"敌方"是**合并统计**的 —— 这符合本作 3–4 人即多方混战的语义，
 * 也避免摘要长度随人数膨胀。
 */
export function digest({ state, playerId, data }: DigestInput): AdvisorDigest {
  const foes = state.players.filter((id) => id !== playerId)

  const mine = summarize(state, [playerId], data)
  const foeSide = summarize(state, foes, data)

  const myHq = state.buildings.find((b) => b.type === 'hq' && b.owner === playerId)
  const hqSafe = myHq !== undefined && !(myHq.capture && myHq.capture.playerId !== playerId)

  const myScore = scoreOf(state, playerId, data)
  let bestFoeScore = -Infinity
  for (const foe of foes) {
    if (state.eliminated.includes(foe)) continue
    bestFoeScore = Math.max(bestFoeScore, scoreOf(state, foe, data))
  }
  const scoreLead: Balance =
    bestFoeScore === -Infinity ? 'ahead' : compare(myScore, bestFoeScore, 5)

  return {
    round: state.round,
    roundsLeft: Math.max(0, data.rules.roundLimit - state.round),
    phase: state.phase === 'DEPLOY' ? 'deploy' : 'action',
    mine,
    foes: foeSide,
    balance: compare(mine.power, foeSide.power, Math.max(50, (mine.power + foeSide.power) * 0.05)),
    hqSafe,
    exposedUnits: countExposed(state, playerId, foes, data),
    foeDistanceToMyHq: nearestHqDistance(state, playerId, 'mine', foes),
    myDistanceToFoeHq: nearestHqDistance(state, playerId, 'foes', foes),
    scoreLead,
  }
}

/** 供 prompt 层复用：把定性结论翻成中文（避免 prompt 里散落 switch） */
export const BALANCE_TEXT: Record<Balance, string> = {
  ahead: '领先',
  behind: '落后',
  even: '均势',
}

export { NEAR_HQ_RANGE }
