/** 把引擎错误码翻译成用户能看懂的中文（M7：完善错误提示） */

import type { ErrorCode } from './types'

const TEXT: Record<ErrorCode, string> = {
  INVALID_PHASE: '当前阶段不能这么做',
  NOT_YOUR_TURN: '还没轮到你行动',
  UNKNOWN_UNIT: '找不到这个单位（可能已被歼灭）',
  UNIT_NOT_YOURS: '这是对方的单位',
  UNIT_ALREADY_ACTED: '该单位本回合已经行动过了',
  UNIT_ALREADY_MOVED: '该单位本回合已经移动过了',
  PATH_BLOCKED: '走不过去：超出移动力或被挡住',
  OUT_OF_RANGE: '目标不在射程内',
  TARGET_INVALID: '目标不合法',
  INDIRECT_MOVED: '投石车移动后不能攻击',
  CANNOT_CAPTURE: '该兵种不能占领据点',
  NOT_A_BUILDING: '这里没有可占领的据点',
  INSUFFICIENT_FUNDS: '军费不足',
  TILE_OCCUPIED: '目标格上已经有单位了',
  UNIT_CAP_REACHED: '已达单位数量上限',
  BUILDING_NOT_OWNED: '这不是你的兵营',
  DEPLOY_BUDGET_EXCEEDED: '部署预算不够',
  DEPLOY_ZONE_INVALID: '只能放在己方部署区内的可通行格',
  DEPLOY_MAX_UNITS: '部署单位数量已达上限',
  ALREADY_DONE: '本回合该兵营已经下过两次生产指令了',
  UNKNOWN_TYPE: '未知兵种',
  NOTHING_TO_DO: '这里不需要这么做',
}

export function describeErrorCode(code: string): string {
  return TEXT[code as ErrorCode] ?? '操作被拒绝（' + code + '）'
}
