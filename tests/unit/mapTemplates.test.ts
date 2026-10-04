/** 地图工厂与改尺寸：模板必须"开箱可玩"，改尺寸不能悄悄丢内容 */

import { describe, expect, it } from 'vitest'
import { DATA, unregisterMap } from '../../src/game/data'
import { validateMap } from '../../src/game/mapValidation'
import { createBlankMap, resizeMap } from '../../src/game/mapTemplates'
import { newUserMapId, registerMap } from '../../src/app/mapStore'
import { isUserMapId } from '../../src/app/mapStore'

describe('mapTemplates · createBlankMap', () => {
  it('2 / 3 / 4 人模板都能通过校验并可直接开局', () => {
    for (const players of [2, 3, 4]) {
      const map = createBlankMap({ id: 'user_t' + players, name: '模板', width: 24, height: 24, players })
      const result = validateMap(map)
      expect(result.errors, `${players} 人模板：${JSON.stringify(result.errors)}`).toEqual([])
      expect(map.deployZones).toHaveLength(players)
      expect(map.terrain).toHaveLength(24 * 24)
    }
  })

  it('模板的据点格地形统一是「据点」', () => {
    const map = createBlankMap({ id: 'user_tx', name: '模板', width: 24, height: 24, players: 2 })
    for (const b of map.buildings) {
      expect(map.terrain[b.y * map.width + b.x]).toBe('building')
    }
  })

  it('每个玩家都有王城与兵营（不是"能开局但没法造兵"的半成品）', () => {
    for (const players of [2, 3, 4]) {
      const map = createBlankMap({ id: 'user_ty', name: '模板', width: 24, height: 24, players })
      for (let owner = 0; owner < players; owner += 1) {
        const mine = map.buildings.filter((b) => b.owner === owner)
        expect(mine.filter((b) => b.type === 'hq')).toHaveLength(1)
        expect(mine.filter((b) => b.type === 'barracks').length).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('参数越界会被夹到合法范围（尺寸 < 12、玩家数 > 4）', () => {
    const map = createBlankMap({ id: 'user_tz', name: '模板', width: 4, height: 4, players: 9 })
    expect(map.width).toBe(12)
    expect(map.height).toBe(12)
    expect(map.deployZones).toHaveLength(4)
  })

  it('生成的模板注册进运行时表后就能被 getMap 取到（单人局要求）', () => {
    const id = newUserMapId()
    expect(isUserMapId(id)).toBe(true)
    const map = createBlankMap({ id, name: '模板', width: 16, height: 16, players: 2 })
    registerMap(map)
    expect(DATA.maps[id].name).toBe('模板')
    unregisterMap(id)
    expect(DATA.maps[id]).toBeUndefined()
  })
})

describe('mapTemplates · resizeMap', () => {
  it('放大时保留已画的地形，新区域是平原', () => {
    const base = createBlankMap({ id: 'user_r1', name: '图', width: 16, height: 16, players: 2 })
    const painted = base.terrain.slice()
    painted[0] = 'forest'
    const { map } = resizeMap({ ...base, terrain: painted }, 24, 24)
    expect(map.width).toBe(24)
    expect(map.terrain[0]).toBe('forest')
    expect(map.terrain[20 * 24 + 20]).toBe('plain')
  })

  it('缩小时丢弃越界的据点，并报告丢弃数量', () => {
    const base = createBlankMap({ id: 'user_r2', name: '图', width: 24, height: 24, players: 2 })
    const { map, droppedBuildings } = resizeMap(base, 12, 12)
    expect(droppedBuildings).toBeGreaterThan(0)
    for (const b of map.buildings) {
      expect(b.x).toBeLessThan(12)
      expect(b.y).toBeLessThan(12)
    }
  })

  it('部署区跟着尺寸重新吸附，不会跑到界外', () => {
    const base = createBlankMap({ id: 'user_r3', name: '图', width: 24, height: 24, players: 2 })
    const { map } = resizeMap(base, 14, 14)
    for (const zone of map.deployZones) {
      expect(zone.x0).toBeGreaterThanOrEqual(0)
      expect(zone.y0).toBeGreaterThanOrEqual(0)
      expect(zone.x1).toBeLessThan(14)
      expect(zone.y1).toBeLessThan(14)
    }
    // 上方的部署区仍然贴顶，下方的仍然贴底
    expect(map.deployZones[0].y0).toBe(0)
    expect(map.deployZones[1].y1).toBe(13)
  })
})
