/** 单人练习的地图选择：显式指定优先、席位不够要回退、自制地图可用 */

import { afterEach, describe, expect, it } from 'vitest'
import { DATA, unregisterMap } from '../../src/game/data'
import { createBlankMap } from '../../src/game/mapTemplates'
import { describePveMatch, normalizeConfig, resolveMapId } from '../../src/app/pveSession'
import { newUserMapId, registerMap } from '../../src/app/mapStore'

const registered: string[] = []
afterEach(() => {
  while (registered.length > 0) {
    const id = registered.pop()
    if (id) unregisterMap(id)
  }
})

function customMap(players: number): string {
  const id = newUserMapId()
  registerMap(createBlankMap({ id, name: '自制 ' + players + ' 人图', width: 20, height: 20, players }))
  registered.push(id)
  return id
}

describe('resolveMapId', () => {
  it('没指定 → 按人数自动挑内置地图', () => {
    expect(resolveMapId(undefined, 2)).toBe('ancient_01')
    expect(resolveMapId(undefined, 4)).toBe('ancient_04')
  })

  it('指定了席位够用的内置地图 → 就用它', () => {
    expect(resolveMapId('ancient_04', 2)).toBe('ancient_04')
    expect(resolveMapId('ancient_04', 4)).toBe('ancient_04')
  })

  it('指定的地图席位不够 → 回退（否则后两名玩家没有部署区）', () => {
    // 2 人图开 4 人局
    expect(resolveMapId('ancient_01', 4)).toBe('ancient_04')
  })

  it('指定了不存在的地图 id → 回退，不抛错', () => {
    expect(resolveMapId('user_not_exist', 2)).toBe('ancient_01')
  })

  it('自制地图可以被选中（就地开在自己的图上）', () => {
    const id = customMap(2)
    expect(resolveMapId(id, 2)).toBe(id)
    // 自制 2 人图开 4 人局 → 回退
    expect(resolveMapId(id, 4)).toBe('ancient_04')
  })
})

describe('describePveMatch · mapId 流转', () => {
  it('配置里的 mapId 会被带进对局参数', () => {
    const id = customMap(2)
    const match = describePveMatch({ opponents: 1, humanSeat: 0, difficulty: 'normal', seed: 1, mapId: id })
    expect(match.mapId).toBe(id)
    expect(match.total).toBe(2)
    expect(match.seatIds).toHaveLength(2)
  })

  it('normalizeConfig 不会把 mapId 丢掉', () => {
    const id = customMap(2)
    const normalized = normalizeConfig({ opponents: 9, humanSeat: 9, difficulty: 'hard', seed: 2, mapId: id })
    expect(normalized.mapId).toBe(id)
    expect(normalized.opponents).toBe(3)
  })

  it('没写 mapId 的老配置照常工作（向后兼容）', () => {
    const match = describePveMatch({ opponents: 1, humanSeat: 0, difficulty: 'normal', seed: 3 })
    expect(match.mapId).toBe('ancient_01')
  })

  it('地图注册表里存在这张图（开局前置条件）', () => {
    const id = customMap(4)
    expect(DATA.maps[id]).toBeDefined()
  })
})
