/**
 * 结算战绩与「复制战报」（纯函数）。
 *
 * ★ 数据**全部来自终局 GameState**，刻意不依赖事件累积。原因：
 *   联机中途加入/刷新时，房主只补发 `state`、**不补发 events/log**（见 roomSession 的 hello 分支），
 *   因此任何"靠事件累积"的统计（击杀/伤害/占领次数）在刷新后会**少算** ——
 *   那是显示**错误**数据，比不显示更糟。终局状态无论何时都是完整的，
 *   所以本模块在联机与单人间行为一致，且结果可复现（不读时钟、不读随机）。
 *
 * 计分口径与 `scoreOf` 共用 `scoreBreakdown`，避免两处各写一份 5/3/1。
 */

import { DATA, buildingType, getMap, unitType } from './data'
import type { GameData } from './data'
import { scoreBreakdown } from './state'
import type { ScoreBreakdown } from './state'
import type { GameState, PlayerId } from './types'

/** 结算文案里的胜负原因（与内核 winReason 同源，多一个"尚未结束"） */
export type WinReason = NonNullable<GameState['winReason']>

const WIN_REASON_TEXT: Record<WinReason, string> = {
  hq_captured: '攻陷王城',
  annihilation: '全歼敌军',
  score: '回合上限计分',
  resign: '对手投降',
}

/** 战报末尾附带的最近战报条数 */
export const REPORT_LOG_LINES = 8

export interface TallyEntry {
  id: string
  name: string
  count: number
}

export interface PlayerTally {
  playerId: PlayerId
  name: string
  /** 终局得分（含拆解，口径同 scoreOf） */
  score: ScoreBreakdown
  /** 场上存活部队数 */
  unitCount: number
  /** 存活部队的总造价（即"兵力价值"，单位与军费一致） */
  unitValue: number
  /** 部队按兵种明细（数量多的在前） */
  unitsByType: TallyEntry[]
  /** 持有据点数 */
  buildingCount: number
  /** 据点按类型明细（固定顺序：王城 / 兵营 / 村落） */
  buildingsByType: TallyEntry[]
  /** 是否仍持有王城 */
  holdsHq: boolean
  funds: number
  eliminated: boolean
  isWinner: boolean
}

export interface BattleTotals {
  /** 打到的回合数 */
  rounds: number
  /** 累计投入过的部队数（含仍卡在生产队列里的） */
  raised: number
  /**
   * 损失数 = 投入 − 场上 − 队列中。
   * ⚠️ 刻意叫「损失」而不是「阵亡」：玩家被淘汰时（投降 / 王城被占 / 全歼）
   * 其部队会被**整体移出棋盘**（见 state.ts 的 eliminate），这些兵不是战死的。
   * 这个数字衡量的是"从棋盘上消失了多少"，死因无从区分。
   */
  lost: number
  /** 仍在生产队列里、尚未出场的部队数 */
  queued: number
  /** 场上存活部队数 */
  onBoard: number
}

export interface BattleSummary {
  rounds: number
  winner: PlayerId | null
  winReason: WinReason | null
  /**
   * 玩家战绩，**已按展示顺序排好**：胜者置顶，其余按得分降序（同分保持原座位顺序）。
   * 直接照着渲染即可，不需要调用方再排一次。
   */
  players: PlayerTally[]
  totals: BattleTotals
}

const BUILDING_ORDER = ['hq', 'barracks', 'village']

/**
 * 汇总终局战绩。
 *
 * @param nameOf 玩家 id → 昵称（联机用大厅昵称、单人用"电脑甲"这类显示名）
 */
export function summarizeBattle(
  state: GameState,
  nameOf: (playerId: PlayerId) => string,
  data: GameData = DATA,
): BattleSummary {
  const players: PlayerTally[] = state.players.map((playerId) => {    const mine = state.units.filter((u) => u.owner === playerId)

    const byType = new Map<string, number>()
    for (const unit of mine) {
      byType.set(unit.type, (byType.get(unit.type) ?? 0) + 1)
    }
    const unitsByType: TallyEntry[] = [...byType.entries()]
      .map(([id, count]) => ({ id, name: safeUnitName(id, data), count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'))

    const owned = state.buildings.filter((b) => b.owner === playerId)
    const buildingsByType: TallyEntry[] = BUILDING_ORDER.map((id) => ({
      id,
      name: safeBuildingName(id, data),
      count: owned.filter((b) => b.type === id).length,
    })).filter((entry) => entry.count > 0)

    return {
      playerId,
      name: nameOf(playerId),
      score: scoreBreakdown(state, playerId, data),
      unitCount: mine.length,
      unitValue: mine.reduce((sum, u) => sum + safeUnitCost(u.type, data), 0),
      unitsByType,
      buildingCount: owned.length,
      buildingsByType,
      holdsHq: owned.some((b) => b.type === 'hq'),
      funds: state.funds[playerId] ?? 0,
      eliminated: state.eliminated.includes(playerId),
      isWinner: state.winner === playerId,
    }
  })

  // 展示顺序：胜者置顶，其余按得分降序。
  // 不纯按得分排的原因：靠"攻陷王城"获胜的一方未必是全场最高分（据点只值 5 分），
  // 若败者排在首行，结果行与表格会互相打架。
  players.sort((a, b) => {
    if (a.isWinner !== b.isWinner) return a.isWinner ? -1 : 1
    return b.score.total - a.score.total
  })

  // 部队 id 连续发放（nextSeq 从 1 起）：投入数 = nextSeq − 1。
  // 已核实"生产队列出场"复用同一 id（state.ts 的 spawn），不会重复计数。
  const raised = Math.max(0, state.nextSeq - 1)
  const queued = state.pending.length
  const onBoard = state.units.length

  return {
    rounds: state.round,
    winner: state.winner,
    winReason: state.winReason,
    players,
    totals: {
      rounds: state.round,
      raised,
      lost: Math.max(0, raised - onBoard - queued),
      queued,
      onBoard,
    },
  }
}

function safeUnitName(id: string, data: GameData): string {
  try {
    return unitType(id, data).name
  } catch {
    return id
  }
}

function safeBuildingName(id: string, data: GameData): string {
  try {
    return buildingType(id, data).name
  } catch {
    return id
  }
}

function safeUnitCost(id: string, data: GameData): number {
  try {
    return unitType(id, data).cost
  } catch {
    return 0
  }
}

/** 单行结果文案：如「甲将军 获胜（攻陷王城）」 */
export function resultText(summary: BattleSummary, nameOf: (playerId: PlayerId) => string): string {
  if (summary.winner === null) {
    return summary.winReason === 'score' ? '双方同分，和局' : '和局'
  }
  const reason = summary.winReason ? WIN_REASON_TEXT[summary.winReason] : '获胜'
  return nameOf(summary.winner) + ' 获胜（' + reason + '）'
}

export interface ReportOptions {
  /** 地图名（含尺寸），例如「四方争雄 24×24」 */
  mapLabel?: string
  /** 最近的战报行（最新在最后）；只取末尾 REPORT_LOG_LINES 条 */
  log?: string[]
  /** 我方玩家（可选）：给该行加「（我方）」标记，便于分享者自己辨认 */
  selfId?: PlayerId | null
}

/** 战绩单行：得分（拆解）｜据点｜部队｜军费｜状态 */
function tallyLine(tally: PlayerTally, selfId?: PlayerId | null): string {
  const parts: string[] = []
  parts.push(
    tally.score.total +
      ' 分（据点 ' +
      tally.score.buildings +
      ' / 兵力 ' +
      tally.score.units +
      ' / 资金 ' +
      tally.score.funds +
      '）',
  )
  parts.push('据点 ' + tally.buildingCount + (tally.buildingsByType.length > 0 ? '（' + tally.buildingsByType.map((b) => b.name + b.count).join(' ') + '）' : ''))
  parts.push('部队 ' + tally.unitCount + (tally.unitValue > 0 ? '（' + tally.unitValue + '）' : ''))
  parts.push('军费 ' + tally.funds)
  if (tally.eliminated) parts.push('已淘汰')
  else if (tally.isWinner) parts.push('胜')
  const tag = selfId && tally.playerId === selfId ? '（我方）' : ''
  return tally.name + tag + '  ' + parts.join(' ｜ ')
}

/**
 * 生成可复制的纯文本战报（发群里用）。
 * 不含任何"我方"以外的视角信息，因此接收方读到的与他人一致。
 */
export function battleReportText(
  summary: BattleSummary,
  nameOf: (playerId: PlayerId) => string,
  options: ReportOptions = {},
): string {
  const lines: string[] = []
  const mapLabel = options.mapLabel ? ' · ' + options.mapLabel : ''
  lines.push('【古代战棋】对局战报')
  lines.push('共 ' + summary.rounds + ' 回合' + mapLabel)
  lines.push('结果：' + resultText(summary, nameOf))
  lines.push('')

  for (const tally of summary.players) {
    lines.push(tallyLine(tally, options.selfId))
  }

  const t = summary.totals
  lines.push('')
  lines.push('本局投入 ' + t.raised + ' 个部队，损失 ' + t.lost + '，场上 ' + t.onBoard + (t.queued > 0 ? '，待出场 ' + t.queued : '') + '。')

  const log = options.log ?? []
  if (log.length > 0) {
    const tail = log.slice(-REPORT_LOG_LINES)
    lines.push('')
    lines.push('—— 最近战报 ——')
    for (const line of tail) lines.push(line)
  }

  return lines.join('\n')
}

/** 便捷入口：直接从终局状态生成战报文本 */
export function reportTextFromState(
  state: GameState,
  nameOf: (playerId: PlayerId) => string,
  options: ReportOptions & { data?: GameData } = {},
): string {
  const data = options.data ?? DATA
  let mapLabel: string | undefined = options.mapLabel
  if (!mapLabel) {
    const map = getMap(state.mapId, data)
    mapLabel = map.name + ' ' + map.width + '×' + map.height
  }
  return battleReportText(summarizeBattle(state, nameOf, data), nameOf, { ...options, mapLabel })
}
