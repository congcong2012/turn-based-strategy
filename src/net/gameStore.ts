/**
 * 房主侧对局状态持久化（断线重连的关键）
 *
 * 只有房主写这份数据：房主浏览器刷新/崩溃后，重新进入同一房间即可恢复整局对局，
 * 再把完整状态补发给对手，双方继续下棋。客户端只从房主拿状态，不落盘。
 */

import { DATA } from '../game/data'
import type { GameState } from '../game/types'

const KEY_PREFIX = 'ancient-tactics.game.'

export interface GameStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export function defaultStorage(): GameStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    localStorage.getItem('probe')
    return localStorage
  } catch {
    return null
  }
}

export function gameKey(roomCode: string): string {
  return KEY_PREFIX + roomCode
}

/** 轻量校验：防止旧版本/损坏数据把对局带崩 */
export function isPlausibleGame(value: unknown): value is GameState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<GameState>
  if (typeof state.mapId !== 'string' || !(state.mapId in DATA.maps)) return false
  if (!Array.isArray(state.players) || state.players.length < 2) return false
  if (!Array.isArray(state.units) || !Array.isArray(state.buildings)) return false
  if (typeof state.turnIndex !== 'number' || typeof state.round !== 'number') return false
  // 规则版本升级后旧对局字段不全，直接丢弃，避免用错规则继续下棋
  if (typeof state.turnSeq !== 'number') return false
  if (state.phase !== 'DEPLOY' && state.phase !== 'PLAYING' && state.phase !== 'GAME_OVER') return false
  return true
}

export function saveGame(storage: GameStorage | null, roomCode: string, state: GameState): void {
  if (!storage) return
  try {
    storage.setItem(gameKey(roomCode), JSON.stringify({ savedAt: Date.now(), state }))
  } catch {
    /* 隐私模式/配额不足时静默失败：不影响当前对局 */
  }
}

export function loadGame(storage: GameStorage | null, roomCode: string): GameState | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(gameKey(roomCode))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state?: unknown }
    return isPlausibleGame(parsed?.state) ? parsed.state : null
  } catch {
    return null
  }
}

export function clearGame(storage: GameStorage | null, roomCode: string): void {
  if (!storage) return
  try {
    storage.removeItem(gameKey(roomCode))
  } catch {
    /* ignore */
  }
}
