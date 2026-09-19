/** 把内核的 GameEvent 翻译成中文战报（纯函数，便于单测） */

import { DATA } from './data'
import type { GameEvent } from './types'

export interface LogContext {
  /** 单位名（找不到时返回兜底文案，例如已被歼灭的单位） */
  unitName: (unitId: string) => string
  buildingName: (buildingId: string) => string
  playerName: (playerId: string) => string
  /** 回合数（用于 turnStart） */
  round?: number
}

const WIN_REASON: Record<string, string> = {
  hq_captured: '攻陷王城',
  annihilation: '全歼敌军',
  score: '回合上限计分',
  resign: '对手投降',
}

export function describeEvent(event: GameEvent, ctx: LogContext): string {
  switch (event.type) {
    case 'deploy':
      return ctx.playerName(event.playerId) + ' 部署了 ' + (DATA.units[event.unitType]?.name ?? event.unitType) + '（-' + event.cost + '）'
    case 'deployDone':
      return ctx.playerName(event.playerId) + ' 完成部署'
    case 'move':
      return ctx.unitName(event.unitId) + ' 移动 (' + event.from.x + ',' + event.from.y + ') → (' + event.to.x + ',' + event.to.y + ')'
    case 'attack': {
      const parts = [ctx.unitName(event.attackerId) + ' 攻击 ' + ctx.unitName(event.defenderId) + '：-' + event.damage]
      if (event.counterDamage > 0) parts.push('反击 -' + event.counterDamage)
      if (event.destroyed.length > 0) parts.push('歼灭 ' + event.destroyed.map((id) => ctx.unitName(id)).join('、'))
      return parts.join('，')
    }
    case 'capture':
      return event.captured
        ? ctx.playerName(event.playerId) + ' 占领了 ' + ctx.buildingName(event.buildingId)
        : ctx.playerName(event.playerId) + ' 占领 ' + ctx.buildingName(event.buildingId) + ' 进度 ' + event.points + '/' + DATA.capturePoints
    case 'produce':
      return ctx.playerName(event.playerId) + ' 生产 ' + (DATA.units[event.unitType]?.name ?? event.unitType) + '（-' + event.cost + '）'
    case 'spawn':
      return (DATA.units[event.unitType]?.name ?? event.unitType) + ' 在 (' + event.x + ',' + event.y + ') 出场'
    case 'repair':
      return ctx.unitName(event.unitId) + ' 补给回复 ' + event.amount + ' HP'
    case 'income':
      return ctx.playerName(event.playerId) + ' 征收军费 +' + event.amount
    case 'turnStart':
      return '第 ' + event.round + ' 回合 · 轮到 ' + ctx.playerName(event.playerId)
    case 'turnEnd':
      return ctx.playerName(event.playerId) + ' 结束回合'
    case 'eliminated':
      return (
        ctx.playerName(event.playerId) +
        ' 被淘汰（' +
        (event.reason === 'hq_captured' ? '王城失守' : event.reason === 'annihilation' ? '全军覆没' : '投降') +
        '）'
      )
    case 'gameOver':
      return '对局结束：' + (event.winner ? ctx.playerName(event.winner) + ' 获胜' : '和局') + '（' + (WIN_REASON[event.reason] ?? event.reason) + '）'
    default:
      return ''
  }
}

export function describeEvents(events: GameEvent[], ctx: LogContext): string[] {
  return events.map((e) => describeEvent(e, ctx)).filter((text) => text.length > 0)
}
