/**
 * 全局设置（首页「设置」面板）。
 *
 * 只有三项，但每一项都影响"看得到什么"：
 *  - `volume`：主音量（音效开关仍在局内 HUD，两者相乘）；
 *  - `selfColor`：自己阵营的颜色（null = 按座位取默认色）；
 *  - `devMode`：开发者模式 —— **所有诊断信息（信令、peer、日志、AI 参数）的总闸**。
 *
 * 为什么用"模块级单例 + 订阅"而不是 Context：
 *  - 棋盘渲染（`render/boardApp`）与音效（`ui/sound`）也要读它，它们不在 React 树里；
 *  - `useSyncExternalStore` 拿到的快照是同一个对象引用，不会引发多余重渲染。
 */

import { useSyncExternalStore } from 'react'

export const SETTINGS_STORAGE_KEY = 'ancient-tactics.settings'

/** 可选的"我的颜色"（与棋盘默认的四色一致）。
 *  ⚠️ 与 `render/playerColors.ts` 的 ROLE_COLORS 是同四个值的两份手写副本
 *  （直接 import 会造成 settings ↔ playerColors 循环依赖）—— 一致性由
 *  `tests/unit/settings.test.ts` 的对齐用例钉住，改调色板时两边一起改。 */
export const SELF_COLOR_CHOICES = [
  { hex: '#c65a44', name: '赤' },
  { hex: '#4aa89b', name: '青' },
  { hex: '#d2a24b', name: '金' },
  { hex: '#9078c8', name: '紫' },
] as const

export interface AppSettings {
  /** 主音量 0..1 */
  volume: number
  /** 自己阵营的颜色（null = 跟随座位） */
  selfColor: string | null
  /** 开发者模式：显示诊断信息 + 允许局内调 AI 参数 */
  devMode: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  volume: 0.8,
  selfColor: null,
  devMode: false,
}

const VALID_COLORS = new Set<string>(SELF_COLOR_CHOICES.map((c) => c.hex))

export function normalizeSettings(raw: unknown): AppSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_SETTINGS }
  const obj = raw as Record<string, unknown>

  const volume =
    typeof obj.volume === 'number' && Number.isFinite(obj.volume)
      ? Math.min(1, Math.max(0, Math.round(obj.volume * 100) / 100))
      : DEFAULT_SETTINGS.volume

  const selfColor =
    typeof obj.selfColor === 'string' && VALID_COLORS.has(obj.selfColor) ? obj.selfColor : null

  const devMode = typeof obj.devMode === 'boolean' ? obj.devMode : DEFAULT_SETTINGS.devMode

  return { volume, selfColor, devMode }
}

function readStorage(): AppSettings {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_STORAGE_KEY)
    return raw ? normalizeSettings(JSON.parse(raw)) : { ...DEFAULT_SETTINGS }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

let current: AppSettings | null = null
const listeners = new Set<() => void>()

export function getSettings(): AppSettings {
  if (!current) current = readStorage()
  return current
}

export function setSettings(patch: Partial<AppSettings>): void {
  const next = normalizeSettings({ ...getSettings(), ...patch })
  current = next
  try {
    globalThis.localStorage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* 隐私模式 / 配额：静默失败，本次会话仍然生效 */
  }
  for (const fn of listeners) fn()
}

export function subscribeSettings(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** React 侧读取设置（快照引用稳定，改一次只重渲染一次） */
export function useAppSettings(): AppSettings {
  return useSyncExternalStore(subscribeSettings, getSettings, getSettings)
}

/** 单测/重置用：丢掉内存缓存，下次重新读 localStorage */
export function resetSettingsCache(): void {
  current = null
}
