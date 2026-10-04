/** 地图校验：合法地图通过、各种结构性错误被准确指出、可疑设计只给提示 */

import { describe, expect, it } from 'vitest'
import { BUILTIN_MAPS, DATA } from '../../src/game/data'
import type { MapDef } from '../../src/game/data'
import { validateMap } from '../../src/game/mapValidation'
import { createBlankMap } from '../../src/game/mapTemplates'

/** 校验结果的错误码集合，便于断言"错在哪一类"而不是去匹配文案 */
function codes(map: unknown, level: 'error' | 'warning'): string[] {
  const result = validateMap(map)
  return (level === 'error' ? result.errors : result.warnings).map((issue) => issue.code)
}

function template(players = 2): MapDef {
  return createBlankMap({ id: 'user_test', name: '测试图', width: 24, height: 24, players })
}

describe('mapValidation · 合法地图', () => {
  it('两张内置地图都通过校验', () => {
    for (const map of Object.values(BUILTIN_MAPS)) {
      const result = validateMap(map)
      expect(result.errors, map.id + ' 的报错：' + JSON.stringify(result.errors)).toEqual([])
      expect(result.ok).toBe(true)
    }
  })

  it('模板地图（2 / 3 / 4 人）都通过校验，且没有"王城不在部署区"这类提示', () => {
    for (const players of [2, 3, 4]) {
      const result = validateMap(template(players))
      expect(result.errors, `${players} 人模板报错：${JSON.stringify(result.errors)}`).toEqual([])
      expect(result.warnings.map((w) => w.code)).not.toContain('hq-outside-zone')
    }
  })

  it('非对象输入直接判非法，不抛异常', () => {
    expect(validateMap(null).ok).toBe(false)
    expect(validateMap('x').ok).toBe(false)
    expect(validateMap(42).ok).toBe(false)
  })
})

describe('mapValidation · 结构性错误', () => {
  it('地形数组长度必须等于 宽 × 高', () => {
    const map = template()
    expect(codes({ ...map, terrain: map.terrain.slice(0, 10) }, 'error')).toContain('terrain-size')
  })

  it('未知地形 id 要报出来（而不是等到开局渲染时抛错）', () => {
    const map = template()
    const terrain = map.terrain.slice()
    terrain[0] = 'lava'
    expect(codes({ ...map, terrain }, 'error')).toContain('terrain-unknown')
  })

  it('整张图没有可通行格 → 报错（否则谁都动不了）', () => {
    const map = template()
    const buildings = map.buildings.map((b) => ({ ...b, x: 1, y: 1 })).slice(0, 1)
    expect(codes({ ...map, width: 12, height: 12, terrain: new Array(144).fill('river'), buildings, deployZones: [{ x0: 0, y0: 0, x1: 3, y1: 3 }, { x0: 8, y0: 8, x1: 11, y1: 11 }] }, 'error')).toEqual(
      expect.arrayContaining(['no-passable', 'zone-unusable']),
    )
  })

  it('部署区数量必须是 2–4（一个区 = 一个玩家席位）', () => {
    const map = template()
    expect(codes({ ...map, deployZones: map.deployZones.slice(0, 1) }, 'error')).toContain('zones-count')
  })

  it('部署区越界或起止颠倒 → 报错', () => {
    const map = template()
    const bad = [{ ...map.deployZones[0] }, { x0: 3, y0: 3, x1: 1, y1: 6 }]
    expect(codes({ ...map, deployZones: bad }, 'error')).toContain('zone-bounds')
  })

  it('据点 id 重复 / 同一格压两个据点 → 报错', () => {
    const map = template()
    const [first, second] = map.buildings
    const dupId = map.buildings.map((b, i) => (i === 1 ? { ...b, id: first.id } : b))
    expect(codes({ ...map, buildings: dupId }, 'error')).toContain('building-id-dup')
    const dupCell = map.buildings.map((b, i) => (i === 1 ? { ...second, x: first.x, y: first.y } : b))
    expect(codes({ ...map, buildings: dupCell }, 'error')).toContain('building-cell-dup')
  })

  it('据点类型未知 / 坐标越界 → 报错', () => {
    const map = template()
    expect(codes({ ...map, buildings: [{ ...map.buildings[0], type: 'castle' }] }, 'error')).toContain('building-type')
    expect(codes({ ...map, buildings: [{ ...map.buildings[0], x: 999 }] }, 'error')).toContain('building-bounds')
  })

  it('每个玩家必须有且只有一个王城', () => {
    const map = template(2)
    const noHq = map.buildings.filter((b) => b.owner !== 0)
    expect(codes({ ...map, buildings: noHq }, 'error')).toContain('hq-missing')

    const twoHq = [...map.buildings, { id: 'bx', type: 'hq', x: 3, y: 2, owner: 0 }]
    expect(codes({ ...map, buildings: twoHq }, 'error')).toContain('hq-dup')
  })

  it('据点归属玩家序号越界 → 报错', () => {
    const map = template(2)
    const buildings = map.buildings.map((b, i) => (i === 0 ? { ...b, owner: 5 } : b))
    expect(codes({ ...map, buildings }, 'error')).toContain('building-owner')
  })

  it('据点压在不可通行的地形上 → 报错', () => {
    const map = template(2)
    const hq = map.buildings.find((b) => b.type === 'hq')!
    const terrain = map.terrain.slice()
    terrain[hq.y * map.width + hq.x] = 'river'
    expect(codes({ ...map, terrain }, 'error')).toContain('building-terrain')
  })
})

describe('mapValidation · 提示（不拦保存）', () => {
  it('某玩家没有兵营 → 提示（造不了兵）', () => {
    const map = template(2)
    const buildings = map.buildings.filter((b) => !(b.type === 'barracks' && b.owner === 1))
    const result = validateMap({ ...map, buildings })
    expect(result.ok).toBe(true)
    expect(result.warnings.map((w) => w.code)).toContain('barracks-missing')
  })

  it('没有中立村落 → 提示（没有可抢的收入点）', () => {
    const map = template(2)
    const buildings = map.buildings.filter((b) => b.type !== 'village')
    expect(codes({ ...map, buildings }, 'warning')).toContain('no-village')
  })

  it('王城不在自己的部署区内 → 提示（能开局，但体验奇怪）', () => {
    const map = template(2)
    const buildings = map.buildings.map((b) => (b.type === 'hq' && b.owner === 0 ? { ...b, y: 12 } : b))
    expect(codes({ ...map, buildings }, 'warning')).toContain('hq-outside-zone')
  })

  it('据点格地形不是「据点」→ 提示（保存时会自动补上）', () => {
    const map = template(2)
    const hq = map.buildings.find((b) => b.type === 'hq')!
    const terrain = map.terrain.slice()
    terrain[hq.y * map.width + hq.x] = 'plain'
    const result = validateMap({ ...map, terrain })
    expect(result.ok).toBe(true)
    expect(result.warnings.map((w) => w.code)).toContain('building-terrain-mismatch')
  })

  it('地图名称过长 → 提示', () => {
    expect(codes({ ...template(), name: '一二三四五六七八九十一二三四五六七八九十一二三四五' }, 'warning')).toContain('name-long')
  })
})

describe('mapValidation · 数据集可注入', () => {
  it('用同一份 DATA 时，内置地图 id 与地形表都来自数据文件（不是硬编码）', () => {
    expect(Object.keys(DATA.terrain).length).toBeGreaterThan(0)
    const map = template()
    // 把地形表换成空表 → 所有地形都成了"未知"
    const empty = { ...DATA, terrain: {} }
    const result = validateMap(map, empty)
    expect(result.errors.map((e) => e.code)).toContain('terrain-unknown')
  })
})
