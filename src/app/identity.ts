/** 玩家身份：playerId 持久化在 localStorage，刷新后仍是同一个玩家（Trystero 的 peerId 每次连接都会变） */

import { normalizeRoomCode } from './roomCode'

const PLAYER_ID_KEY = 'ancient-tactics.playerId'
const NICKNAME_KEY = 'ancient-tactics.nickname'
const SUFFIX_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export interface Identity {
  playerId: string
  nickname: string
  /** 临时身份（DEV 的 ?as= 调试入口），不写入 localStorage */
  ephemeral: boolean
}

function safeStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null
    localStorage.getItem(PLAYER_ID_KEY)
    return localStorage
  } catch {
    return null
  }
}

export function createPlayerId(rand: () => number = Math.random): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  const uuid = g.crypto?.randomUUID?.()
  if (uuid) return uuid
  return 'p-' + Math.floor(rand() * 1e12).toString(36) + Date.now().toString(36)
}

export function randomSuffix(rand: () => number = Math.random): string {
  let out = ''
  for (let i = 0; i < 4; i += 1) {
    const idx = Math.min(SUFFIX_ALPHABET.length - 1, Math.max(0, Math.floor(rand() * SUFFIX_ALPHABET.length)))
    out += SUFFIX_ALPHABET[idx]
  }
  return out
}

export function defaultNickname(rand: () => number = Math.random): string {
  return '将军·' + randomSuffix(rand)
}

export function readStoredNickname(storage: StorageLike | null = safeStorage()): string | null {
  try {
    return storage?.getItem(NICKNAME_KEY) ?? null
  } catch {
    return null
  }
}

export function writeStoredPlayerId(playerId: string, storage: StorageLike | null = safeStorage()): void {
  try {
    storage?.setItem(PLAYER_ID_KEY, playerId)
  } catch {
    /* 隐私模式下写失败不影响游戏 */
  }
}

export function writeStoredNickname(nickname: string, storage: StorageLike | null = safeStorage()): void {
  try {
    storage?.setItem(NICKNAME_KEY, nickname)
  } catch {
    /* ignore */
  }
}

const LAST_ROOM_KEY = 'ancient-tactics.lastRoom'

/** 记住本标签页当前所在房间（sessionStorage：刷新可恢复，新标签页互不影响） */
export function writeLastRoom(roomCode: string): void {
  try {
    globalThis.sessionStorage?.setItem(LAST_ROOM_KEY, roomCode)
  } catch {
    /* ignore */
  }
}

export function readLastRoom(): string | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(LAST_ROOM_KEY) ?? null
    if (!raw) return null
    const code = normalizeRoomCode(raw)
    return code.length === 6 ? code : null
  } catch {
    return null
  }
}

export function clearLastRoom(): void {
  try {
    globalThis.sessionStorage?.removeItem(LAST_ROOM_KEY)
  } catch {
    /* ignore */
  }
}

/** 从 URL 读取房间码（?room=ABC123），好友打开链接即自动预填 */
export function roomCodeFromUrl(search: string): string | null {
  const params = new URLSearchParams(search)
  const raw = params.get('room')
  if (!raw) return null
  const code = normalizeRoomCode(raw)
  return code.length > 0 ? code : null
}

export interface ResolveIdentityOptions {
  search: string
  dev: boolean
  storage?: StorageLike | null
  rand?: () => number
}

/**
 * 解析本地身份。
 * DEV 下支持 ?as=<playerId>&nick=<昵称> 的测试/调试入口（不落盘），
 * 生产构建只会走 localStorage 与随机默认值。
 */
export function resolveIdentity(options: ResolveIdentityOptions): Identity {
  const { search, dev } = options
  const storage = options.storage === undefined ? safeStorage() : options.storage
  const rand = options.rand ?? Math.random

  if (dev) {
    const params = new URLSearchParams(search)
    const as = params.get('as')
    if (as) {
      return {
        playerId: as,
        nickname: params.get('nick')?.trim() || readStoredNickname(storage) || defaultNickname(rand),
        ephemeral: true,
      }
    }
  }

  let playerId = null
  try {
    playerId = storage?.getItem(PLAYER_ID_KEY) ?? null
  } catch {
    playerId = null
  }
  if (!playerId) playerId = createPlayerId(rand)

  const nickname = readStoredNickname(storage) ?? defaultNickname(rand)
  return { playerId, nickname, ephemeral: false }
}
