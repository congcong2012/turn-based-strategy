/**
 * 回合级 rollout（切片 4）：合法性、确定性、预算纪律、机制确实发生、适用边界。
 *
 * 强度结论（oracle vs hard 胜率）不在这里断言 —— 交给 `npm run bench:ai`（见 `docs/ai-bench-rollout.md`）。
 */

import { describe, expect, it } from 'vitest'
import { applyCommand } from '../../../src/game/commands'
import { MAX_AI_STEPS, nextCommand } from '../../../src/ai'
import { profileFor } from '../../../src/ai/profile'
import type { AiProfile } from '../../../src/ai/profile'
import { rolloutCommand } from '../../../src/ai/rollout'
import { mulberry32 } from '../../../src/ai/rng'
import type { Command, GameState } from '../../../src/game/types'
import {
  P1,
  P2,
  addUnit,
  newGame,
  startPlaying,
  startPlaying4,
  testData,
  testData4,
} from '../game/fixtures'

const data = testData()

function rolloutProfile(patch: Partial<AiProfile> = {}): AiProfile {
  return { ...profileFor('oracle'), ...patch }
}

/** "双方都有单位、已进入行动阶段"的局面（A 先手） */
function midGame(): GameState {
  return addUnit(startPlaying(newGame(data), data), data, 'spear', P2, 3, 5)
}

describe('回合级 rollout · 合法性与终止性', () => {
  it('oracle 整个回合产出的指令全部合法，并以 endTurn 收尾', () => {
    let s = startPlaying(newGame(data), data)
    const rng = mulberry32(7)
    const commands: Command[] = []
    for (let i = 0; i < MAX_AI_STEPS; i += 1) {
      const cmd = nextCommand(s, P1, 'oracle', data, rng)
      const r = applyCommand(s, P1, cmd, data)
      expect(r.ok, '非法指令: ' + JSON.stringify(cmd) + ' → ' + (r.ok ? '' : r.code)).toBe(true)
      if (!r.ok) break
      commands.push(cmd)
      s = r.state
      if (cmd.type === 'endTurn' || s.phase === 'GAME_OVER') break
    }
    expect(commands.length).toBeGreaterThan(0)
    expect(commands[commands.length - 1].type).toBe('endTurn')
  })
})

describe('回合级 rollout · 确定性（刷新可复现）', () => {
  it('同状态 + 同种子 → 同指令、同枚举次数', () => {
    const s = midGame()
    const profile = rolloutProfile()
    const a = rolloutCommand(s, P1, profile, data, mulberry32(123))
    const b = rolloutCommand(s, P1, profile, data, mulberry32(123))
    expect(a.cmd).toEqual(b.cmd)
    expect(a.generations).toBe(b.generations)
  })

  it('不依赖墙钟：间隔一段时间后调用结果一致', () => {
    const s = midGame()
    const profile = rolloutProfile()
    const first = rolloutCommand(s, P1, profile, data, mulberry32(55))
    const until = Date.now() + 40
    while (Date.now() < until) {
      /* busy wait */
    }
    const second = rolloutCommand(s, P1, profile, data, mulberry32(55))
    expect(second.cmd).toEqual(first.cmd)
    expect(second.generations).toBe(first.generations)
  })
})

describe('回合级 rollout · 预算纪律', () => {
  it('枚举次数永不超过 rolloutBudget', () => {
    const s = midGame()
    const r = rolloutCommand(s, P1, rolloutProfile(), data, mulberry32(3))
    expect(r.generations).toBeLessThanOrEqual(rolloutProfile().rolloutBudget)
  })

  it('预算极小时仍给出合法指令', () => {
    const s = midGame()
    const r = rolloutCommand(s, P1, rolloutProfile({ rolloutBudget: 1 }), data, mulberry32(1))
    expect(r.generations).toBeLessThanOrEqual(1)
    expect(applyCommand(s, P1, r.cmd, data).ok).toBe(true)
  })
})

describe('回合级 rollout · 机制确实发生', () => {
  it('评估一个根候选要枚举多次（含"我走完回合 + 对手走完回合"）', () => {
    const s = midGame()
    const r = rolloutCommand(s, P1, rolloutProfile(), data, mulberry32(9))
    // 只做 1 步前瞻的话，枚举次数不超过根候选数；rollout 必然远超它
    expect(r.generations).toBeGreaterThan(rolloutProfile().beamWidth)
  })

  it('关掉"对手回合"就退化成纯 1 步前瞻（枚举次数大幅下降）', () => {
    const s = midGame()
    const withFoe = rolloutCommand(s, P1, rolloutProfile(), data, mulberry32(9))
    const noFoe = rolloutCommand(s, P1, rolloutProfile({ rolloutFoeSteps: 0, rolloutMySteps: 0 }), data, mulberry32(9))
    expect(noFoe.generations).toBeLessThan(withFoe.generations)
    expect(noFoe.generations).toBeLessThanOrEqual(rolloutProfile().beamWidth)
  })
})

describe('回合级 rollout · 适用边界', () => {
  it('3–4 人局不启用：oracle 回退到 hard 的 1 步前瞻（评估本就相同）', () => {
    const d4 = testData4()
    const s = startPlaying4(d4)
    const oracleCmd = nextCommand(s, P1, 'oracle', d4, mulberry32(3))
    const hardCmd = nextCommand(s, P1, 'hard', d4, mulberry32(3))
    expect(oracleCmd).toEqual(hardCmd)
    expect(applyCommand(s, P1, oracleCmd, d4).ok).toBe(true)
  })

  it('非行动阶段（部署）不进入 rollout', () => {
    const r = rolloutCommand(newGame(data), P1, rolloutProfile(), data, mulberry32(2))
    expect(r.cmd).toEqual({ type: 'endTurn' })
    expect(r.generations).toBe(0)
  })
})
