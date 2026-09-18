/** 游戏内核测试夹具：8×8 小地图，规则与正式地图一致，便于手算验证 */

import { DATA } from '../../../src/game/data'
import type { GameData, MapDef } from '../../../src/game/data'
import { createGame } from '../../../src/game/state'
import { applyCommand } from '../../../src/game/commands'
import type { Command, CommandResult, GameState, PlayerId } from '../../../src/game/types'

export const P1: PlayerId = 'A'
export const P2: PlayerId = 'B'

/**
 * 8×8 测试地图（y=0 在上方）：
 *   (4,0) 中立村落   (5,0) B 的王城   (6,0) B 的兵营
 *   (1,1) 森林       (2,1) 山地       (3,1) 河流
 *   (2,7) A 的王城   (1,7) A 的兵营   (4,3) 中立村落
 */
export function testData(): GameData {
  const rows = [
    '....B B.', // 占位，下面按坐标覆盖
  ]
  void rows
  const width = 8
  const height = 8
  const terrain: string[] = new Array(width * height).fill('plain')
  const set = (x: number, y: number, t: string) => {
    terrain[y * width + x] = t
  }
  set(1, 1, 'forest')
  set(2, 1, 'mountain')
  set(3, 1, 'river')

  const buildings = [
    { id: 'v-mid', type: 'village', x: 4, y: 0, owner: null },
    { id: 'hq-B', type: 'hq', x: 5, y: 0, owner: 1 },
    { id: 'bk-B', type: 'barracks', x: 6, y: 0, owner: 1 },
    { id: 'hq-A', type: 'hq', x: 2, y: 7, owner: 0 },
    { id: 'bk-A', type: 'barracks', x: 1, y: 7, owner: 0 },
    { id: 'v-south', type: 'village', x: 4, y: 3, owner: null },
  ]
  for (const b of buildings) set(b.x, b.y, 'building')

  const map: MapDef = {
    id: 'test',
    name: '测试地图',
    width,
    height,
    terrain,
    buildings,
    deployZones: [
      { x0: 0, y0: 6, x1: 7, y1: 7 },
      { x0: 0, y0: 0, x1: 7, y1: 1 },
    ],
  }
  return { ...DATA, maps: { ...DATA.maps, test: map } }
}

export function newGame(data: GameData): GameState {
  return createGame('test', [P1, P2], data)
}

export function must(result: CommandResult, data?: GameData): GameState {
  void data
  if (!result.ok) throw new Error('指令被拒绝: ' + result.code)
  return result.state
}

export function run(state: GameState, player: PlayerId, cmd: Command, data: GameData): CommandResult {
  return applyCommand(state, player, cmd, data)
}

/** 走完部署阶段进入 PLAYING（A 在 (2,7)、B 在 (5,0) 各放一个刀盾兵） */
export function startPlaying(state: GameState, data: GameData): GameState {
  let s = state
  s = must(run(s, P1, { type: 'deploy', unitType: 'sword', x: 2, y: 7 }, data))
  s = must(run(s, P2, { type: 'deploy', unitType: 'sword', x: 5, y: 0 }, data))
  s = must(run(s, P1, { type: 'deployDone' }, data))
  s = must(run(s, P2, { type: 'deployDone' }, data))
  return s
}

/** 测试辅助：直接往状态里塞单位（绕过部署校验） */
export function addUnit(state: GameState, data: GameData, typeId: string, owner: PlayerId, x: number, y: number): GameState {
  const s: GameState = JSON.parse(JSON.stringify(state))
  const type = data.units[typeId]
  s.units.push({ id: 't' + s.nextSeq, type: typeId, owner, x, y, hp: type.hp, moved: false, acted: false, capture: null })
  s.nextSeq += 1
  return s
}

export function unitsAt(state: GameState, x: number, y: number) {
  return state.units.filter((u) => u.x === x && u.y === y)
}
