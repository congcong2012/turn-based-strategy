/** 自制地图的存储层：往返、过滤、注册进运行时表、导入导出 */

import { afterEach, describe, expect, it } from 'vitest'
import { DATA, hasMap, unregisterMap } from '../../src/game/data'
import type { MapDef } from '../../src/game/data'
import { createBlankMap } from '../../src/game/mapTemplates'
import type { GameStorage } from '../../src/net/gameStore'
import {
  MAPS_SAVE_VERSION,
  MAPS_STORAGE_KEY,
  deleteUserMap,
  exportMapJson,
  installUserMaps,
  isBuiltinMapId,
  isUserMapId,
  listPveMaps,
  loadUserMaps,
  newUserMapId,
  normalizeMap,
  parseMapJson,
  removeUserMapEverywhere,
  upsertUserMap,
} from '../../src/app/mapStore'

interface MemoryStorage extends GameStorage {
  data: Map<string, string>
}

function memoryStorage(): MemoryStorage {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
    removeItem: (key) => {
      data.delete(key)
    },
  }
}

function freshMap(overrides: Partial<MapDef> = {}): MapDef {
  return { ...createBlankMap({ id: newUserMapId(), name: '自制图', width: 24, height: 24, players: 2 }), ...overrides }
}

const registered: string[] = []
function track<T extends MapDef>(map: T): T {
  registered.push(map.id)
  return map
}

afterEach(() => {
  while (registered.length > 0) {
    const id = registered.pop()
    if (id) unregisterMap(id)
  }
})

describe('mapStore · id 约定', () => {
  it('自制地图 id 带 user_ 前缀，内置地图能识别', () => {
    const id = newUserMapId()
    expect(isUserMapId(id)).toBe(true)
    expect(isBuiltinMapId('ancient_01')).toBe(true)
    expect(isBuiltinMapId(id)).toBe(false)
  })

  it('连续生成的 id 不重复', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newUserMapId()))
    expect(ids.size).toBe(200)
  })
})

describe('mapStore · 往返', () => {
  it('存进去再读出来，内容一致', () => {
    const storage = memoryStorage()
    const map = track(freshMap({ name: '渡口改' }))
    upsertUserMap(map, storage)

    const loaded = loadUserMaps(storage)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe(map.id)
    expect(loaded[0].name).toBe('渡口改')
    expect(loaded[0].terrain).toEqual(map.terrain)
    expect(loaded[0].buildings).toEqual(map.buildings)
    expect(loaded[0].deployZones).toEqual(map.deployZones)
  })

  it('同一 id 再存一次是覆盖，不是追加', () => {
    const storage = memoryStorage()
    const map = track(freshMap())
    upsertUserMap(map, storage)
    upsertUserMap({ ...map, name: '改过名字' }, storage)
    const loaded = loadUserMaps(storage)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].name).toBe('改过名字')
  })

  it('删除后读不到', () => {
    const storage = memoryStorage()
    const map = track(freshMap())
    upsertUserMap(map, storage)
    deleteUserMap(map.id, storage)
    expect(loadUserMaps(storage)).toHaveLength(0)
  })

  it('storage 不可用（隐私模式）时静默失败，不抛错', () => {
    expect(() => upsertUserMap(freshMap(), null)).not.toThrow()
    expect(loadUserMaps(null)).toEqual([])
  })
})

describe('mapStore · 读回时的过滤（坏数据不能拖垮全部）', () => {
  it('版本号不符 → 当作没有地图', () => {
    const storage = memoryStorage()
    storage.setItem(MAPS_STORAGE_KEY, JSON.stringify({ version: MAPS_SAVE_VERSION + 1, maps: [freshMap()] }))
    expect(loadUserMaps(storage)).toEqual([])
  })

  it('坏 JSON → 返回空数组且不抛错', () => {
    const storage = memoryStorage()
    storage.setItem(MAPS_STORAGE_KEY, '{ not json')
    expect(loadUserMaps(storage)).toEqual([])
  })

  it('单张不合法只丢那一张，其它照常读出', () => {
    const storage = memoryStorage()
    const good = track(freshMap())
    const broken = { ...freshMap(), terrain: ['plain'] } // 长度不对
    storage.setItem(MAPS_STORAGE_KEY, JSON.stringify({ version: MAPS_SAVE_VERSION, maps: [broken, good] }))
    const loaded = loadUserMaps(storage)
    expect(loaded.map((m) => m.id)).toEqual([good.id])
  })

  it('把内置地图的副本塞进存储 → 被丢弃（避免 id 冲突）', () => {
    const storage = memoryStorage()
    storage.setItem(
      MAPS_STORAGE_KEY,
      JSON.stringify({ version: MAPS_SAVE_VERSION, maps: [{ ...DATA.maps.ancient_01, savedAt: 0 }] }),
    )
    expect(loadUserMaps(storage)).toEqual([])
  })

  it('id 重复的条目只保留第一条', () => {
    const storage = memoryStorage()
    const map = track(freshMap())
    storage.setItem(
      MAPS_STORAGE_KEY,
      JSON.stringify({ version: MAPS_SAVE_VERSION, maps: [{ ...map, savedAt: 1 }, { ...map, savedAt: 2 }] }),
    )
    expect(loadUserMaps(storage)).toHaveLength(1)
  })
})

describe('mapStore · 注册进运行时地图表', () => {
  it('保存即注册：刚存的地图马上就能被 getMap 取到（否则设置页能选、一点就抛错）', () => {
    const storage = memoryStorage()
    const map = track(freshMap())
    upsertUserMap(map, storage)
    expect(hasMap(map.id)).toBe(true)
    expect(DATA.maps[map.id].name).toBe(map.name)
  })

  it('installUserMaps 负责"重开页面"那条路径：清空运行时表后再装载能复原', () => {
    const storage = memoryStorage()
    const map = track(freshMap())
    upsertUserMap(map, storage)

    // 模拟重新打开页面：运行时表是空的，靠 installUserMaps 从本地读回
    unregisterMap(map.id)
    expect(hasMap(map.id)).toBe(false)

    installUserMaps(storage)
    expect(hasMap(map.id)).toBe(true)
    expect(DATA.maps[map.id].name).toBe(map.name)
  })

  it('删除时同时从运行时表摘掉（否则同一页面还能选到已删的图）', () => {
    const storage = memoryStorage()
    const map = track(freshMap())
    upsertUserMap(map, storage)
    expect(hasMap(map.id)).toBe(true)

    removeUserMapEverywhere(map.id, storage)
    expect(hasMap(map.id)).toBe(false)
    expect(loadUserMaps(storage)).toHaveLength(0)
  })
})

describe('mapStore · 规范化与导入导出', () => {
  it('normalizeMap 把据点所在格补成「据点」地形', () => {
    const map = freshMap()
    const hq = map.buildings[0]
    const broken: MapDef = { ...map, terrain: map.terrain.map((t, i) => (i === hq.y * map.width + hq.x ? 'plain' : t)) }
    const fixed = normalizeMap(broken)
    expect(fixed.terrain[hq.y * map.width + hq.x]).toBe('building')
  })

  it('导出再导入得到等价地图', () => {
    const map = freshMap({ name: '往返图' })
    const parsed = parseMapJson(exportMapJson(map))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.map.id).toBe(map.id)
    expect(parsed.map.name).toBe('往返图')
    expect(parsed.map.terrain).toEqual(map.terrain)
    expect(parsed.map.buildings).toEqual(map.buildings)
    expect(parsed.map.deployZones).toEqual(map.deployZones)
  })

  it('导出的是干净 JSON（不含本机的 savedAt 之类字段）', () => {
    const text = exportMapJson(freshMap())
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(
      ['buildings', 'deployZones', 'height', 'id', 'name', 'terrain', 'width'].sort(),
    )
  })

  it('导入非 JSON / 不合法地图 → 返回具体原因', () => {
    const notJson = parseMapJson('{oops')
    expect(notJson.ok).toBe(false)

    const invalid = parseMapJson(JSON.stringify({ ...freshMap(), terrain: ['plain'] }))
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.errors.join()).toContain('地形数组长度')
  })
})

describe('mapStore · 单人练习可选地图', () => {
  it('按所需玩家数过滤：席位不够的地图不出现', () => {
    const storage = memoryStorage()
    const two = track(freshMap())
    upsertUserMap(two, storage)

    const forTwo = listPveMaps(2, storage)
    expect(forTwo.some((m) => m.id === two.id && m.custom)).toBe(true)

    const forFour = listPveMaps(4, storage)
    expect(forFour.some((m) => m.id === two.id)).toBe(false)
  })

  it('列表里既有内置也有自制，且自制带标记', () => {
    const storage = memoryStorage()
    const custom = track(freshMap())
    upsertUserMap(custom, storage)
    const list = listPveMaps(2, storage)
    expect(list.some((m) => m.id === 'ancient_01' && !m.custom)).toBe(true)
    expect(list.some((m) => m.id === custom.id && m.custom)).toBe(true)
  })
})
