/**
 * 回防（`src/ai/defense.ts` + 启发式/评估器里的两项）。
 *
 * 守的是一个真实缺陷：AI 的兵全挤在地图中间抢据点，**老家被贴脸也不回防**。
 * 根因不是"评估器不重视"，而是 `hard` 档先按启发式取前 K 名 —— "往回走"这种动作
 * 在启发式里原本是 0 分，压根进不了候选池，评估器再着急也选不到。
 */

import { describe, expect, it } from 'vitest'
import { addUnit, newGame, P1, P2, startPlaying, testData } from '../game/fixtures'
import { defenseAlarm } from '../../../src/ai/defense'
import { nextCommand } from '../../../src/ai'
import type { GameState } from '../../../src/game/types'

const data = testData()

/** A 的王城在 (2,7)，B 的王城在 (5,0) */
function scenario(besiegerAt: { x: number; y: number }, defenderAt: { x: number; y: number }): GameState {
  let s = startPlaying(newGame(data), data)
  s = { ...s, units: [], turnIndex: 0 }
  s = addUnit(s, data, 'sword', P2, besiegerAt.x, besiegerAt.y)
  s = addUnit(s, data, 'sword', P1, defenderAt.x, defenderAt.y)
  return s
}

describe('defenseAlarm · 什么时候该回防', () => {
  it('敌兵贴到我方王城 → 报警，权重大于"抢一个村落"', () => {
    const s = scenario({ x: 2, y: 6 }, { x: 2, y: 3 })
    const alarm = defenseAlarm(s, P1)
    expect(alarm).not.toBeNull()
    expect(alarm!.weight).toBeGreaterThan(60) // 村落踩上去才 +60
  })

  it('敌兵离王城很远 → 不报警（避免一有侦察兵就全军回撤）', () => {
    const s = scenario({ x: 5, y: 2 }, { x: 2, y: 3 })
    expect(defenseAlarm(s, P1)).toBeNull()
  })

  it('敌兵贴着中立村落 → 不报警（丢个村不值得回防）', () => {
    // (4,0) 是中立村落
    const s = scenario({ x: 4, y: 1 }, { x: 2, y: 3 })
    expect(defenseAlarm(s, P1)).toBeNull()
  })

  it('自家门口没敌人时安静（不会无谓地牵制全军）', () => {
    const s = scenario({ x: 5, y: 0 }, { x: 2, y: 3 })
    expect(defenseAlarm(s, P1)).toBeNull()
  })
})

describe('★ 老家被贴脸时，中场的兵要往回走', () => {
  it('距离王城 4 格的兵，第一步应当是靠近王城（而不是继续北上）', () => {
    const s = scenario({ x: 2, y: 6 }, { x: 2, y: 3 })
    const cmd = nextCommand(s, P1, 'hard', data)
    // 王城在 (2,7)：往回走 = y 变大
    if (cmd.type === 'move') {
      expect(cmd.y).toBeGreaterThan(3)
    } else if (cmd.type === 'attack') {
      // 直接打围城的兵也算回防
      const target = s.units.find((u) => u.id === cmd.targetId)
      expect(target?.owner).toBe(P2)
    } else {
      throw new Error('期望是移动或攻击，实际是 ' + cmd.type)
    }
  })
})
