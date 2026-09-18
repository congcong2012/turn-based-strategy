import { describe, expect, it } from 'vitest'
import { describeEvent } from '../../src/game/logText'
import type { LogContext } from '../../src/game/logText'

const ctx: LogContext = {
  unitName: (id) => (id === 'u1' ? '刀盾兵·甲' : '弓兵·乙'),
  buildingName: () => '村落',
  playerName: (id) => (id === 'A' ? '甲将军' : '乙将军'),
  round: 3,
}

describe('战报文案', () => {
  it('部署 / 生产 / 出场', () => {
    expect(describeEvent({ type: 'deploy', unitId: 'u1', unitType: 'sword', playerId: 'A', x: 1, y: 2, cost: 1000 }, ctx)).toBe('甲将军 部署了 刀盾兵（-1000）')
    expect(describeEvent({ type: 'produce', buildingId: 'b1', unitType: 'spear', playerId: 'A', cost: 1000 }, ctx)).toBe('甲将军 生产 长枪兵（-1000）')
    expect(describeEvent({ type: 'spawn', unitId: 'u2', unitType: 'spear', playerId: 'A', x: 6, y: 2 }, ctx)).toBe('长枪兵 在 (6,2) 出场')
  })

  it('攻击：伤害、反击与歼灭', () => {
    expect(
      describeEvent({ type: 'attack', attackerId: 'u1', defenderId: 'u2', damage: 55, counterDamage: 24, destroyed: [] }, ctx),
    ).toBe('刀盾兵·甲 攻击 弓兵·乙：-55，反击 -24')
    expect(
      describeEvent({ type: 'attack', attackerId: 'u1', defenderId: 'u2', damage: 90, counterDamage: 0, destroyed: ['u2'] }, ctx),
    ).toContain('歼灭 弓兵·乙')
  })

  it('占领进度与易主', () => {
    expect(describeEvent({ type: 'capture', unitId: 'u1', buildingId: 'b1', playerId: 'A', points: 10, captured: false }, ctx)).toBe('甲将军 占领 村落 进度 10/20')
    expect(describeEvent({ type: 'capture', unitId: 'u1', buildingId: 'b1', playerId: 'A', points: 20, captured: true }, ctx)).toBe('甲将军 占领了 村落')
  })

  it('经济 / 回合 / 结束', () => {
    expect(describeEvent({ type: 'income', playerId: 'A', amount: 3000 }, ctx)).toBe('甲将军 征收军费 +3000')
    expect(describeEvent({ type: 'turnStart', playerId: 'B', round: 3 }, ctx)).toBe('第 3 回合 · 轮到 乙将军')
    expect(describeEvent({ type: 'gameOver', winner: 'A', reason: 'hq_captured' }, ctx)).toBe('对局结束：甲将军 获胜（攻陷王城）')
    expect(describeEvent({ type: 'gameOver', winner: null, reason: 'score' }, ctx)).toBe('对局结束：和局（回合上限计分）')
  })
})
