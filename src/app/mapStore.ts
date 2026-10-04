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

// ------------------------------------------------------------------ 分享码

/**
 * 分享码前缀。看到这个前缀就按"压缩过的地图"解析，否则按普通 JSON 解析 ——
 * 导入框因此可以同时接受两种粘贴内容。
 */
export const SHARE_CODE_PREFIX = 'ATM1:'

/** 兵种/据点类型在分享码里的编号（固定表，比存字符串省一半） */
const BUILDING_TYPES = ['hq', 'barracks', 'village'] as const

/**
 * 分享码里存的紧凑结构（键名故意很短，因为要塞进聊天框）。
 *
 * 地形用「调色板 + 游程」编码：一张 24×24 图有 576 格，但大部分是连续的同种地形，
 * 游程后通常只剩几十项 —— 再套 base64 后一张图大约几百个字符，微信里能直接发。
 */
interface CompactMap {
  v: 1
  i: string
  n: string
  w: number
  h: number
  p: string[]
  r: Array<[number, number]>
  b: Array<[number, number, number, number]>
  z: Array<[number, number, number, number]>
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): string {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function compactOf(map: MapDef): CompactMap {
  const palette: string[] = []
  const runs: Array<[number, number]> = []
  for (const id of map.terrain) {
    let index = palette.indexOf(id)
    if (index === -1) {
      palette.push(id)
      index = palette.length - 1
    }
    const last = runs[runs.length - 1]
    if (last && last[1] === index) last[0] += 1
    else runs.push([1, index])
  }
  return {
    v: 1,
    i: map.id,
    n: map.name,
    w: map.width,
    h: map.height,
    p: palette,
    r: runs,
    b: map.buildings.map((b) => [
      Math.max(0, BUILDING_TYPES.indexOf(b.type as (typeof BUILDING_TYPES)[number])),
      b.x,
      b.y,
      b.owner === null ? -1 : b.owner,
    ]),
    z: map.deployZones.map((z) => [z.x0, z.y0, z.x1, z.y1]),
  }
}

/** 一张地图 → 分享码（含原始 id，双方导入后 id 一致才能联机选到同一张图） */
export function encodeShareCode(map: MapDef): string {
  return SHARE_CODE_PREFIX + toBase64Url(JSON.stringify(compactOf(map)))
}

export function isShareCode(text: string): boolean {
  return text.trim().startsWith(SHARE_CODE_PREFIX)
}

/**
 * 分享码 → 地图。**保留原 id**（这是它能用于联机的关键：两端 import 后 id 相同）。
 * 解码后仍走一遍常规校验，坏码只报错不抛异常。
 */
export function decodeShareCode(
  text: string,
  data: GameData = DATA,
): { ok: true; map: MapDef } | { ok: false; errors: string[] } {
  const trimmed = text.trim()
  if (!isShareCode(trimmed)) return { ok: false, errors: ['这不是一张地图分享码'] }
  let compact: CompactMap
  try {
    compact = JSON.parse(fromBase64Url(trimmed.slice(SHARE_CODE_PREFIX.length))) as CompactMap
  } catch {
    return { ok: false, errors: ['分享码已损坏（无法解码）'] }
  }
  if (!compact || compact.v !== 1 || !Array.isArray(compact.r) || !Array.isArray(compact.p)) {
    return { ok: false, errors: ['分享码版本不认识'] }
  }

  const terrain: string[] = []
  for (const [count, index] of compact.r) {
    const id = compact.p[index]
    if (typeof id !== 'string') return { ok: false, errors: ['分享码里的地形表不完整'] }
    for (let i = 0; i < count; i += 1) terrain.push(id)
  }

  const map: MapDef = {
    id: compact.i,
    name: compact.n,
    width: compact.w,
    height: compact.h,
    terrain,
    buildings: (compact.b ?? []).map(([type, x, y, owner], index) => ({
      id: 'b' + (index + 1),
      type: BUILDING_TYPES[type] ?? 'village',
      x,
      y,
      owner: owner < 0 ? null : owner,
    })),
    deployZones: (compact.z ?? []).map(([x0, y0, x1, y1]) => ({ x0, y0, x1, y1 })),
  }

  const result = validateMap(map, data)
  if (!result.ok) return { ok: false, errors: result.errors.map((e) => e.message) }
  return { ok: true, map: normalizeMap(map) }
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

export interface MapOption {
  id: string
  name: string
  width: number
  height: number
  players: number
  custom: boolean
}

/** 内置 + 本机已导入的自制地图 */
function mapOptions(storage: GameStorage | null): MapOption[] {
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
  return [...builtin, ...custom]
}

/**
 * 单人练习可选的地图：**内置 + 自制**，且席位够用（`players >= 需要的玩家数`）。
 */
export function listPveMaps(playerCount: number, storage: GameStorage | null = defaultStorage()): MapOption[] {
  return mapOptions(storage).filter((m) => m.players >= playerCount)
}

/**
 * 大厅选图用：内置 + 本机已导入的自制地图（不做席位过滤 —— 房主自己要判断人数是否匹配）。
 *
 * ⚠️ 自制地图**没有随产物分发**：房主选了它，其他玩家必须先在编辑器里导入同一张图
 * （用分享码，保留同一个 id），否则他们那边渲染不出这张地图。大厅会对自制图给出明确提示。
 */
export function listLobbyMaps(storage: GameStorage | null = defaultStorage()): MapOption[] {
  return mapOptions(storage)
}

/** 运行时地图表的增删查：从存储层再导出，调用方不必同时了解 `game/data` 的细节 */
export { hasMap, registerMap, unregisterMap }
