import { describe, expect, it } from 'vitest'
import { computeReach, pathTo, reachableDestinations, chebyshevDistance } from '../../../src/game/movement'
import { moveCost } from '../../../src/game/data'
import { addUnit, newGame, startPlaying, testData } from './fixtures'

const data = testData()

function unitAt(state: ReturnType<typeof newGame>, typeId: string, x: number, y: number) {
  const s = addUnit(state, data, typeId, 'A', x, y)
  const unit = s.units.find((u) => u.x === x && u.y === y)
  if (!unit) throw new Error('missing unit')
  return { state: s, unit }
}

describe('移动（Dijkstra）', () => {
  it('平原上步行 3：可达格 = 曼哈顿距离 ≤ 3 的格子', () => {
    const base = startPlaying(newGame(data), data)
    const { state, unit } = unitAt(base, 'sword', 0, 0)
    const reach = computeReach(state, unit, data)
    expect(reach.get('3,0')?.cost).toBe(3) // 直线 3 步
    expect(reach.get('4,0')).toBeUndefined() // 超出移动力
    // 只能走四邻接，不能斜走：到 (1,1) 要 (0,0)->(1,0)->(1,1)，平原 1 + 森林 2 = 3
    expect(reach.get('1,1')?.cost).toBe(3)
    expect(reach.has('0,3')).toBe(true)
    expect(reach.has('0,4')).toBe(false)
  })

  it('地形消耗：森林 2、山地 2（步行）、河流不可通行', () => {
    const map = data.maps.test
    expect(moveCost(map, 1, 1, 'foot', data)).toBe(2)
    expect(moveCost(map, 2, 1, 'foot', data)).toBe(2)
    expect(moveCost(map, 3, 1, 'foot', data)).toBeNull()
    // 骑兵/器械不能进山地
    expect(moveCost(map, 2, 1, 'horse', data)).toBeNull()
    expect(moveCost(map, 2, 1, 'siege', data)).toBeNull()
  })

  it('骑兵移动力 6，但被山地阻断（需绕行）', () => {
    const base = startPlaying(newGame(data), data)
    const { state, unit } = unitAt(base, 'lightCav', 1, 2)
    const reach = computeReach(state, unit, data)
    expect(reach.get('1,1')?.cost).toBe(3) // 森林对骑兵消耗 3
    expect(reach.get('2,1')).toBeUndefined() // 山地不可通行，骑兵无法进入
  })

  it('敌方单位阻挡通行；友方可通过但不可停留', () => {
    const base = startPlaying(newGame(data), data)
    const withEnemy = addUnit(base, data, 'sword', 'B', 1, 0)
    const { state, unit } = unitAt(withEnemy, 'sword', 0, 0)
    const reach = computeReach(state, unit, data)
    // (1,0) 被敌人占据 → 不可进入也不可穿越
    expect(reachableDestinations(state, unit, data).some((d) => d.x === 1 && d.y === 0)).toBe(false)
    // 绕行到 (2,0) 需要 (0,0)->(0,1)->(0,2)->(1,2)->(2,2)->(2,1)[山地 2]->(2,0) 共 7 步 > 3 → 不可达
    expect(reach.get('2,0')).toBeUndefined()

    const withFriend = addUnit(base, data, 'sword', 'A', 1, 0)
    const second = unitAt(withFriend, 'spear', 0, 0)
    const reach2 = computeReach(second.state, second.unit, data)
    expect(reach2.get('1,0')?.cost).toBe(1) // 友方可穿过
    const dests = reachableDestinations(second.state, second.unit, data)
    expect(dests.some((d) => d.x === 1 && d.y === 0)).toBe(false) // 但不能停留
    expect(dests.some((d) => d.x === 2 && d.y === 0)).toBe(true)
  })

  it('路径是连续的四邻接序列，终点即目标', () => {
    const base = startPlaying(newGame(data), data)
    const { state, unit } = unitAt(base, 'sword', 0, 0)
    const path = pathTo(state, unit, 3, 0, data)
    expect(path).toEqual([{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }])
    expect(pathTo(state, unit, 7, 7, data)).toBeNull()
  })

  it('切比雪夫距离用于射程判定', () => {
    expect(chebyshevDistance({ x: 0, y: 0 }, { x: 2, y: 1 })).toBe(2)
  })
})
