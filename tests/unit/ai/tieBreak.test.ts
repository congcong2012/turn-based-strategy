/** 种子 tie-break：并列候选按种子分叉（评估台样本量的前提），唯一最优不吃噪声 */

import { describe, expect, it } from 'vitest'
import { nextCommand } from '../../../src/ai'
import { mulberry32 } from '../../../src/ai/rng'
import type { Command } from '../../../src/game/types'
import { P1, P2, addUnit, newGame, startPlaying, testData } from '../game/fixtures'

const data = testData()

describe('AI · 种子 tie-break', () => {
  it('部署并列落点：同一种子可复现，不同种子产生分叉', () => {
    const start = newGame(data)
    const seen = new Set<string>()
    for (let seed = 1; seed <= 24; seed += 1) {
      const a = nextCommand(start, P1, 'normal', data, mulberry32(seed))
      const b = nextCommand(start, P1, 'normal', data, mulberry32(seed))
      // 同种子 → 同决策（刷新 / 重跑都必须能复现）
      expect(a).toEqual(b)
      seen.add(JSON.stringify(a))
    }
    // 部署区里同兵种、同"靠前"档次的落点存在并列 → 不同种子必须走出不同落点，
    // 否则对战评估台（scripts/ai-bench.ts）积累不到独立样本
    expect(seen.size).toBeGreaterThan(1)
  })

  it('首步无并列时任何种子都选同一指令（平局打破不污染决策）', () => {
    // 该局面下首步的最优候选无并列（实测 8 种子全一致）；至于是不是攻击由
    // ai.test.ts 的"对手在射程内时会发起攻击"负责断言，这里只关心"不吃噪声"
    const withEnemy = addUnit(startPlaying(newGame(data), data), data, 'sword', P2, 3, 6)
    let baseline: Command | null = null
    for (let seed = 1; seed <= 8; seed += 1) {
      const cmd = nextCommand(withEnemy, P1, 'normal', data, mulberry32(seed))
      if (baseline === null) baseline = cmd
      expect(cmd).toEqual(baseline)
    }
    expect(baseline).not.toBeNull()
  })
})
