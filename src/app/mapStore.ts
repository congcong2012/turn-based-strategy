/**
 * 自制地图的持久化与导入导出。
 *
 * 设计约束（来自项目原则"纯静态、零服务器"）：
 *  - 地图**存浏览器本地**（localStorage 单槽），不依赖任何后端；
 *  - 想分享 / 想让别人也玩到 → **导出 JSON**，把文件放进 `src/data/maps/` 并登记，
 *    它就变成内置地图（所有人的大厅里都能选）。
 *
 * 与 `net/gameStore`、`app/pveStore` 同款风格：读回时**逐张校验**，
 * 任何一张不合法就**单独丢弃**（不影响其它地图），宁可少一张也不要崩。
 */

import { BUILTIN_MAPS, DATA, hasMap, registerMap, unregisterMap } from '../game/data'
import type { GameData, MapDef } from '../game/data'
import { validateMap } from '../game/mapValidation'
import { defaultStorage } from '../net/gameStore'
import type { GameStorage } from '../net/gameStore'

export const MAPS_STORAGE_KEY = 'ancient-tactics.maps'
export const MAPS_SAVE_VERSION = 1

/** 自制地图的 id 前缀：与内置地图（ancient_*）区分开，便于"大厅只列内置图"这类判断 */
export const USER_MAP_PREFIX = 'user_'

export interface UserMap extends MapDef {
  savedAt: number
}

export function isUserMapId(id: string): boolean {
  return id.startsWith(USER_MAP_PREFIX)
}

export function isBuiltinMapId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_MAPS, id)
}

/**
 * 生成一个不会撞的自制地图 id。
 *
 * 三段拼起来：时间戳（跨会话不撞）+ **会话内自增序号**（同一毫秒内连点也不会撞）
 * + 4 位随机（两个标签页同时新建时有区分度）。
 * 只用时间戳 + 2 位随机是不够的：同一毫秒里建 200 张图几乎必然重号。
 */
let idSeq = 0

export function newUserMapId(): string {
  idSeq += 1
  const random = Math.floor(Math.random() * 1679616)
    .toString(36)
    .padStart(4, '0')
  return USER_MAP_PREFIX + Date.now().toString(36) + idSeq.toString(36) + random
}

/**
 * 规范化：把"压在据点下面的格子"补成「据点」地形。
 *
 * 内置地图手工维护时就是这么做，但手工编辑很容易漏 —— 漏了会导致
 * 据点格按平原/森林算移动消耗与防御，**数值和看起来的不一样**。
 * 编辑器保存与导入时都过一遍，把这类错误消灭在写入前。
 */
export function normalizeMap(map: MapDef): MapDef {
  const terrain = map.terrain.slice()
  for (const b of map.buildings) {
    const idx = b.y * map.width + b.x
    if (idx >= 0 && idx < terrain.length) terrain[idx] = 'building'
  }
  return { ...map, terrain }
}

/** 从任意来源（存档 / 剪贴板 / 文件）解析出一张合法地图；不合法返回原因 */
export function parseMapJson(
  text: string,
  data: GameData = DATA,
): { ok: true; map: MapDef } | { ok: false; errors: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, errors: ['不是合法的 JSON 文本'] }
  }
  const result = validateMap(raw, data)
  if (!result.ok) return { ok: false, errors: result.errors.map((e) => e.message) }
  return { ok: true, map: normalizeMap(raw as MapDef) }
}

/** 导出为可读 JSON（去掉本地保存时间等只属于本机的字段） */
export function exportMapJson(map: MapDef): string {
  const clean: MapDef = {
    id: map.id,
    name: map.name,
    width: map.width,
    height: map.height,
    terrain: map.terrain,
    buildings: map.buildings,
    deployZones: map.deployZones,
  }
  return JSON.stringify(clean, null, 2)
}

// ------------------------------------------------------------------ 读写

interface StoredPayload {
  version: number
  maps: UserMap[]
}

/** 读出所有合法的自制地图（不注册，纯读） */
export function loadUserMaps(storage: GameStorage | null = defaultStorage(), data: GameData = DATA): UserMap[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(MAPS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Partial<StoredPayload>
    if (parsed?.version !== MAPS_SAVE_VERSION || !Array.isArray(parsed.maps)) return []
    const out: UserMap[] = []
    const seen = new Set<string>()
    for (const item of parsed.maps) {
      if (!item || typeof item !== 'object') continue
      const map = item as UserMap
      // 只接受自制地图（防止有人把内置图的副本塞进来造成 id 冲突）
      if (typeof map.id !== 'string' || !isUserMapId(map.id) || seen.has(map.id)) continue
      if (!validateMap(map, data).ok) continue
      seen.add(map.id)
      out.push({ ...normalizeMap(map), savedAt: typeof map.savedAt === 'number' ? map.savedAt : 0 })
    }
    return out
  } catch {
    return []
  }
}

/** 写回（隐私模式/配额不足时静默失败，不影响当前编辑） */
export function saveUserMaps(maps: UserMap[], storage: GameStorage | null = defaultStorage()): void {
  if (!storage) return
  try {
    const payload: StoredPayload = { version: MAPS_SAVE_VERSION, maps }
    storage.setItem(MAPS_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    /* ignore */
  }
}

/**
 * 新增或覆盖一张自制地图，**并立即注册进运行时地图表**，返回写入后的完整列表。
 *
 * 为什么保存时就要注册：运行时的 `getMap` / 存档校验都只看 `DATA.maps`。
 * 如果只写 localStorage，会出现"刚保存的地图在设置页里能选、但一点就抛「未知地图」"
 * （或者单人局静默回退到内置图）——保存与注册必须是同一个动作。
 */
export function upsertUserMap(
  map: MapDef,
  storage: GameStorage | null = defaultStorage(),
  data: GameData = DATA,
): UserMap[] {
  const maps = loadUserMaps(storage, data)
  const record: UserMap = { ...normalizeMap(map), savedAt: Date.now() }
  const next = maps.some((m) => m.id === record.id)
    ? maps.map((m) => (m.id === record.id ? record : m))
    : [...maps, record]
  saveUserMaps(next, storage)
  registerMap(record, data)
  return next
}

/** 删除一张自制地图，并同步从运行时地图表摘掉 */
export function deleteUserMap(id: string, storage: GameStorage | null = defaultStorage(), data: GameData = DATA): UserMap[] {
  const next = loadUserMaps(storage, data).filter((m) => m.id !== id)
  saveUserMaps(next, storage)
  unregisterMap(id, data)
  return next
}

/**
 * 启动时装载：把本机所有合法自制地图注册进 `DATA.maps`。
 *
 * 必须在**任何对局创建/存档读取之前**调用（`src/main.tsx` 里做的），
 * 否则"以前用自制地图开的局"会因为在 `DATA.maps` 里查不到而被判为非法存档、直接清掉。
 */
export function installUserMaps(storage: GameStorage | null = defaultStorage(), data: GameData = DATA): UserMap[] {
  const maps = loadUserMaps(storage, data)
  for (const map of maps) registerMap(map, data)
  return maps
}

/** 删除时同时从运行时表里摘掉（`deleteUserMap` 已经做了，这个名字表达调用方意图） */
export function removeUserMapEverywhere(
  id: string,
  storage: GameStorage | null = defaultStorage(),
  data: GameData = DATA,
): UserMap[] {
  return deleteUserMap(id, storage, data)
}

/**
 * 单人练习可选的地图：**内置 + 自制**，且席位够用（`players >= 需要的玩家数`）。
 *
 * 为什么联机大厅不用这个列表：自制地图没有随产物分发，其他玩家手里没有这张图，
 * 房主选了它别人会渲染不出来。要联机玩，请导出 JSON 放进 `src/data/maps/` 变成内置图。
 */
export function listPveMaps(playerCount: number, storage: GameStorage | null = defaultStorage()): Array<{
  id: string
  name: string
  width: number
  height: number
  players: number
  custom: boolean
}> {
  const builtin = Object.values(BUILTIN_MAPS).map((m) => ({
    id: m.id,
    name: m.name,
    width: m.width,
    height: m.height,
    players: m.deployZones.length,
    custom: false,
  }))
  const custom = loadUserMaps(storage).map((m) => ({
    id: m.id,
    name: m.name,
    width: m.width,
    height: m.height,
    players: m.deployZones.length,
    custom: true,
  }))
  return [...builtin, ...custom].filter((m) => m.players >= playerCount)
}

/** 运行时地图表的增删查：从存储层再导出，调用方不必同时了解 `game/data` 的细节 */
export { hasMap, registerMap, unregisterMap }
