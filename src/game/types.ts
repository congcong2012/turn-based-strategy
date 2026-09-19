/** 游戏领域类型（M2：部署 + 移动 + 攻击 + 占领 + 生产 + 回合流转） */

export type PlayerId = string

export type MoveType = 'foot' | 'horse' | 'siege'
export type AttackKind = 'direct' | 'indirect'
export type GamePhase = 'DEPLOY' | 'PLAYING' | 'GAME_OVER'
/** 单个玩家回合内的阶段（GDD 3.2） */
export type TurnPhase = 'START' | 'ACTION' | 'RESOLVE' | 'HANDOVER'

export type UnitType = {
  id: string
  name: string
  glyph: string
  hp: number
  move: number
  moveType: MoveType
  rangeMin: number
  rangeMax: number
  attack: AttackKind
  counter: boolean
  capture: boolean
  cost: number
}

export type TerrainType = {
  id: string
  name: string
  glyph: string
  moveCost: Record<MoveType, number | null>
  defense: number
  color: string
}

export type BuildingType = {
  id: string
  name: string
  glyph: string
  income: number
  repair: number
  produce: boolean
}

export type Unit = {
  id: string
  type: string
  owner: PlayerId
  x: number
  y: number
  hp: number
  /** 本回合已移动 */
  moved: boolean
  /** 本回合已行动（攻击/占领/待机后为 true，不能再移动） */
  acted: boolean
  /** 正在占领：目标据点与已累计点数 */
  capture: { buildingId: string; points: number } | null
}

export type BuildingState = {
  id: string
  type: string
  x: number
  y: number
  owner: PlayerId | null
  /** 正在被谁占领、累计多少点、由哪个单位发起（易主在回合结算阶段生效） */
  capture: { playerId: PlayerId; points: number; unitId: string } | null
}

export type PendingUnit = {
  id: string
  type: string
  owner: PlayerId
  buildingId: string
  /** 下单时的回合序号（用于限制"每座兵营每回合的下单数"） */
  turnSeq: number
}

export type GameState = {
  rev: number
  mapId: string
  players: PlayerId[]
  units: Unit[]
  buildings: BuildingState[]
  funds: Record<PlayerId, number>
  pending: PendingUnit[]
  turnIndex: number
  round: number
  /** 每进入一个小回合 +1（生产下单配额按它计数） */
  turnSeq: number
  phase: GamePhase
  turnPhase: TurnPhase
  deploy: Record<PlayerId, { budget: number; placed: number; done: boolean }>
  /** 已被淘汰的玩家（王城被占 / 全歼 / 投降） */
  eliminated: PlayerId[]
  /** 最近一次淘汰原因（用于结算文案） */
  lastElimination?: 'hq_captured' | 'annihilation' | 'resign'
  winner: PlayerId | null
  winReason: 'hq_captured' | 'annihilation' | 'score' | 'resign' | null
  nextSeq: number
}

export type GameEvent =
  | { type: 'deploy'; unitId: string; unitType: string; playerId: PlayerId; x: number; y: number; cost: number }
  | { type: 'deployDone'; playerId: PlayerId }
  | {
      type: 'move'
      unitId: string
      playerId: PlayerId
      from: { x: number; y: number }
      to: { x: number; y: number }
      /** 逐格路径（不含起点），供客户端播放移动动画 */
      path: Array<{ x: number; y: number }>
    }
  | { type: 'attack'; attackerId: string; defenderId: string; damage: number; counterDamage: number; destroyed: string[] }
  | { type: 'capture'; unitId: string; buildingId: string; playerId: PlayerId; points: number; captured: boolean }
  | { type: 'produce'; buildingId: string; unitType: string; playerId: PlayerId; cost: number }
  | { type: 'spawn'; unitId: string; unitType: string; playerId: PlayerId; x: number; y: number }
  | { type: 'repair'; unitId: string; amount: number }
  | { type: 'income'; playerId: PlayerId; amount: number }
  | { type: 'turnStart'; playerId: PlayerId; round: number }
  | { type: 'turnEnd'; playerId: PlayerId }
  | { type: 'eliminated'; playerId: PlayerId; reason: 'hq_captured' | 'annihilation' | 'resign' }
  | { type: 'gameOver'; winner: PlayerId | null; reason: 'hq_captured' | 'annihilation' | 'score' | 'resign' }

export type Command =
  | { type: 'deploy'; unitType: string; x: number; y: number }
  | { type: 'deployDone' }
  | { type: 'move'; unitId: string; x: number; y: number }
  | { type: 'attack'; unitId: string; targetId: string }
  | { type: 'capture'; unitId: string }
  | { type: 'produce'; buildingId: string; unitType: string }
  | { type: 'wait'; unitId: string }
  | { type: 'endTurn' }
  | { type: 'resign' }

export type ErrorCode =
  | 'INVALID_PHASE' | 'NOT_YOUR_TURN' | 'UNKNOWN_UNIT' | 'UNIT_NOT_YOURS'
  | 'UNIT_ALREADY_ACTED' | 'UNIT_ALREADY_MOVED' | 'PATH_BLOCKED' | 'OUT_OF_RANGE'
  | 'TARGET_INVALID' | 'INDIRECT_MOVED' | 'CANNOT_CAPTURE' | 'NOT_A_BUILDING'
  | 'INSUFFICIENT_FUNDS' | 'TILE_OCCUPIED' | 'UNIT_CAP_REACHED' | 'BUILDING_NOT_OWNED'
  | 'DEPLOY_BUDGET_EXCEEDED' | 'DEPLOY_ZONE_INVALID' | 'DEPLOY_MAX_UNITS' | 'ALREADY_DONE'
  | 'UNKNOWN_TYPE' | 'NOTHING_TO_DO'

export type CommandResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; code: ErrorCode }
