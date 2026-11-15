/**
 * 全局设置（音量 / 我的颜色 / 开发者模式）与阵营配色。
 *
 * 守两件事：
 *  1. localStorage 是不可信输入 —— 越界音量、未知颜色、错误类型都必须回落默认；
 *  2. 配色的优先级是 **2v2 队伍色 > 我的颜色 > 座位默认**（否则"同队同色"会被个人偏好破坏）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  SELF_COLOR_CHOICES,
  getSettings,
  normalizeSettings,
  resetSettingsCache,
  setSettings,
  subscribeSettings,
} from '../../src/app/settings'
import { ROLE_COLORS, TEAM_COLORS, ownerColor } from '../../src/render/playerColors'
import { createGame } from '../../src/game/state'
import { withTeams } from '../../src/game/state'
import { diagonalTeams } from '../../src/game/teams'
import { DATA } from '../../src/game/data'

describe('normalizeSettings · 不可信输入', () => {
  it('音量夹到 0..1 并保留两位小数', () => {
    expect(normalizeSettings({ volume: 5 }).volume).toBe(1)
    expect(normalizeSettings({ volume: -3 }).volume).toBe(0)
    expect(normalizeSettings({ volume: 0.333 }).volume).toBe(0.33)
    expect(normalizeSettings({ volume: Number.NaN }).volume).toBe(DEFAULT_SETTINGS.volume)
  })

  it('颜色只接受四个预设值（其它一律视为"默认"）', () => {
    expect(normalizeSettings({ selfColor: '#4aa89b' }).selfColor).toBe('#4aa89b')
    expect(normalizeSettings({ selfColor: '#123456' }).selfColor).toBeNull()
    expect(normalizeSettings({ selfColor: 42 }).selfColor).toBeNull()
  })

  it('devMode 只认布尔；坏输入整体回落默认', () => {
    expect(normalizeSettings({ devMode: true }).devMode).toBe(true)
    expect(normalizeSettings({ devMode: 'yes' }).devMode).toBe(false)
    for (const bad of [null, undefined, 1, 'x', []]) {
      expect(normalizeSettings(bad)).toEqual(DEFAULT_SETTINGS)
    }
  })
})

describe('设置存取与订阅', () => {
  afterEach(() => {
    setSettings({ ...DEFAULT_SETTINGS })
    resetSettingsCache()
  })

  it('setSettings 会更新快照并通知订阅者', () => {
    let calls = 0
    const off = subscribeSettings(() => {
      calls += 1
    })
    setSettings({ devMode: true })
    expect(getSettings().devMode).toBe(true)
    expect(calls).toBe(1)
    off()
    setSettings({ devMode: false })
    expect(calls).toBe(1) // 取消订阅后不再通知
  })
})

describe('ownerColor · 优先级', () => {
  const players = ['A', 'B', 'C', 'D']

  afterEach(() => {
    setSettings({ ...DEFAULT_SETTINGS })
    resetSettingsCache()
  })

  it('混战：按座位取默认色', () => {
    const state = createGame('ancient_01', ['A', 'B'], DATA)
    expect(ownerColor(state, 'A', 'A')).toBe(ROLE_COLORS[0])
    expect(ownerColor(state, 'B', 'A')).toBe(ROLE_COLORS[1])
  })

  it('★ 设置了"我的颜色"：只改自己，别人不受影响', () => {
    setSettings({ selfColor: '#9078c8' })
    const state = createGame('ancient_01', ['A', 'B'], DATA)
    expect(ownerColor(state, 'A', 'A')).toBe('#9078c8')
    expect(ownerColor(state, 'B', 'A')).toBe(ROLE_COLORS[1])
  })

  it('★ 2v2：队伍色压过个人偏好（否则"同队同色"就不成立）', () => {
    setSettings({ selfColor: '#9078c8' })
    const state = withTeams(createGame('ancient_04', players, DATA), diagonalTeams(4))
    expect(ownerColor(state, 'A', 'A')).toBe(TEAM_COLORS[0])
    expect(ownerColor(state, 'D', 'A')).toBe(TEAM_COLORS[0]) // 队友同色
    expect(ownerColor(state, 'B', 'A')).toBe(TEAM_COLORS[1])
  })
})

describe('★ 两份四色表的一致性（settings 与 playerColors 各写了一份，必须钉住）', () => {
  // SELF_COLOR_CHOICES（设置面板的选项）与 ROLE_COLORS（棋盘座位默认色）
  // 是同四个值的两份手写副本 —— 直接 import 会造成 settings ↔ playerColors 循环依赖，
  // 所以用测试钉住：将来任何一边改了调色板，这边立刻红。
  it('SELF_COLOR_CHOICES 的色值与 ROLE_COLORS 一一对应（顺序相同）', () => {
    expect([...SELF_COLOR_CHOICES.map((c) => c.hex)]).toEqual([...ROLE_COLORS])
  })
})
