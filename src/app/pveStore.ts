/**
 * 单人练习（PVE）对局持久化。
 *
 * 与联机侧 `net/gameStore.ts` 的差别：
 *  - 单人没有"房间"，所以只有**一个槽位**，键名固定；
 *  - 联机只需存 `GameState`（对手状态从房主补发），单人还要存**配置（含种子）与战报**，
 *    否则恢复出来的局既不知道难度、也没有历史战报；
 *  - 单人是离线局，重开标签页也得能恢复，因此用 localStorage（不是 sessionStorage）。
 *
 * 清除时机与联机一致：**只有"退出对局"才清**；刷新 / 关标签页不清。
 */

import { isPlausibleGame } from '../net/gameStore'
import type { GameStorage } from '../net/gameStore'
import { defaultStorage } from '../net/gameStore'
import { emptyJournal } from '../game/journal'
import type { Journal } from '../game/journal'
import type { GameState } from '../game/types'
import type { PveConfig } from './pveSession'
import { isPlayableDifficulty } from '../ai'

export const PVE_STORAGE_KEY = 'ancient-tactics.pve'

/** 存档结构版本：字段不兼容时直接丢弃，避免用错规则继续下棋 */
export const PVE_SAVE_VERSION = 1

export interface PveSnapshot {
  version: number
  savedAt: number
  config: PveConfig
  state: GameState
  journal: Journal
}

/**
 * 合法难度直接取自 AI 层的"对玩家开放档"表（`PLAYABLE_DIFFICULTIES`），
 * **不再在这里硬编码一份** —— 否则将来新开一档时，设置页能选、存档却会被判非法而清档。
 */
export function isPlausibleDifficulty(value: unknown): value is PveConfig['difficulty'] {
  return isPlayableDifficulty(value)
}

/** 配置校验：opponents 1–3、humanSeat 落在合法座位内、seed 是有限数、difficulty 合法 */
export function isPlausibleConfig(value: unknown): value is PveConfig {
  if (!value || typeof value !== 'object') return false
  const config = value as Partial<PveConfig>
  if (typeof config.opponents !== 'number' || !Number.isFinite(config.opponents)) return false
  const opponents = Math.floor(config.opponents)
  if (opponents < 1 || opponents > 3) return false
  if (typeof config.humanSeat !== 'number' || !Number.isFinite(config.humanSeat)) return false
  const humanSeat = Math.floor(config.humanSeat)
  if (humanSeat < 0 || humanSeat > opponents) return false
  if (typeof config.seed !== 'number' || !Number.isFinite(config.seed)) return false
  return isPlausibleDifficulty(config.difficulty)
}

/** 战报校验失败时**只丢战报**（降级为空 journal），不因此丢掉整局 */
export function isPlausibleJournal(value: unknown): value is Journal {
  if (!value || typeof value !== 'object') return false
  const journal = value as Partial<Journal>
  return (
    Array.isArray(journal.log) && Array.isArray(journal.events) && typeof journal.seq === 'number'
  )
}

export function savePve(storage: GameStorage | null, snapshot: PveSnapshot): void {
  if (!storage) return
  try {
    storage.setItem(PVE_STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    /* 隐私模式/配额不足时静默失败：不影响当前对局，只是刷新后无法恢复 */
  }
}

/**
 * 读存档。任何一处不可信就**清档并返回 null**（回退到设置页），宁可重开也不要崩。
 * 注意：`GAME_OVER` 的局不会被写入（见 usePveGame 的落盘策略），所以这里不必特判。
 */
export function loadPve(storage: GameStorage | null = defaultStorage()): PveSnapshot | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(PVE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PveSnapshot>

    if (parsed?.version !== PVE_SAVE_VERSION) {
      clearPve(storage)
      return null
    }
    if (!isPlausibleConfig(parsed.config) || !isPlausibleGame(parsed.state)) {
      clearPve(storage)
      return null
    }
    // 配置推导出的座位数必须与实际对局玩家数一致，否则说明是不匹配的两份数据
    const expectedPlayers = Math.floor(parsed.config.opponents) + 1
    if (parsed.state.players.length !== expectedPlayers) {
      clearPve(storage)
      return null
    }

    const journal = isPlausibleJournal(parsed.journal) ? parsed.journal : emptyJournal()

    return {
      version: PVE_SAVE_VERSION,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
      config: parsed.config,
      state: parsed.state,
      journal,
    }
  } catch {
    return null
  }
}

export function clearPve(storage: GameStorage | null = defaultStorage()): void {
  if (!storage) return
  try {
    storage.removeItem(PVE_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
