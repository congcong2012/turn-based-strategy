import { describe, expect, it } from 'vitest'
import {
  CLAIM_WAIT_MS,
  HOST_LOST_GRACE_MS,
  createElection,
  gone,
  hostHello,
  pickSuccessor,
  seen,
  setPhase,
  tick,
} from '../../src/app/hostElection'
import type { ElectionEffect, ElectionState } from '../../src/app/hostElection'

const rec = (playerId: string, joinedAt: number) => ({
  playerId,
  nickname: playerId,
  joinedAt,
  connected: true,
})

function types(effects: ElectionEffect[]): string[] {
  return effects.map((e) => e.type)
}

/** 构造某个客户端的真实视角：自己加入 → 看到房主 → 承认房主 → 看到其他玩家 */
function clientView(
  selfId: string,
  joinedAt: number,
  hostId: string,
  others: Array<[string, number]> = [],
): ElectionState {
  let state = createElection(selfId, selfId, joinedAt)
  state = seen(state, rec(hostId, 0)).state
  state = hostHello(state, hostId).state
  for (const [id, at] of others) state = seen(state, rec(id, at)).state
  return state
}

describe('房主选举', () => {
  it('初始无房主；等待期内不自任', () => {
    const state = createElection('p1', '甲', 1000)
    expect(state.hostId).toBeNull()
    const early = tick(state, 1000 + CLAIM_WAIT_MS - 1)
    expect(early.state.hostId).toBeNull()
    expect(early.effects).toHaveLength(0)
  })

  it('无人应答 → 第一个加入者成为房主', () => {
    const state = createElection('p1', '甲', 1000)
    const result = tick(state, 1000 + CLAIM_WAIT_MS)
    expect(result.state.hostId).toBe('p1')
    expect(types(result.effects)).toEqual(['becameHost', 'broadcastHostHello'])
  })

  it('收到 hostHello → 承认对方为房主', () => {
    const state = createElection('p2', '乙', 5000)
    const result = hostHello(state, 'p1')
    expect(result.state.hostId).toBe('p1')
    expect(result.state.selfDeclared).toBe(false)
    expect(result.effects).toHaveLength(0)

    // 承认之后不再自任房主
    const later = tick(result.state, 5000 + CLAIM_WAIT_MS + 100)
    expect(later.state.hostId).toBe('p1')
    expect(later.effects).toHaveLength(0)
  })

  it('竞态：双方都自任房主 → 字典序小者胜出，大者降级', () => {
    const a: ElectionState = { ...createElection('p1', '甲', 0), hostId: 'p1', selfDeclared: true }
    const b: ElectionState = { ...createElection('p2', '乙', 0), hostId: 'p2', selfDeclared: true }

    const aView = hostHello(a, 'p2')
    expect(aView.state.hostId).toBe('p1')
    expect(types(aView.effects)).toEqual(['broadcastHostHello'])

    const bView = hostHello(b, 'p1')
    expect(bView.state.hostId).toBe('p1')
    expect(bView.state.selfDeclared).toBe(false)
    expect(types(bView.effects)).toEqual(['steppedDown'])
  })

  it('房主掉线超宽限期 → 剩余最早加入者接管（仅 LOBBY）', () => {
    const p2 = gone(clientView('p2', 100, 'p1', [['p3', 200]]), 'p1').state
    const p3 = gone(clientView('p3', 200, 'p1', [['p2', 100]]), 'p1').state

    // 第一次 tick 只是"发现掉线"并开始计时
    const noticed = tick(p2, 0)
    expect(noticed.state.hostLostAt).toBe(0)
    expect(noticed.effects).toHaveLength(0)

    // 宽限期内不接管
    const earlyTick = tick(noticed.state, HOST_LOST_GRACE_MS - 1)
    expect(earlyTick.effects).toHaveLength(0)

    // 过了宽限期：p2 是最早加入的剩余玩家 → 接管
    const p2Tick = tick(earlyTick.state, HOST_LOST_GRACE_MS)
    expect(p2Tick.state.hostId).toBe('p2')
    expect(types(p2Tick.effects)).toEqual(['becameHost', 'broadcastHostHello'])

    // p3 不接管（它不是最早者）
    const p3Noticed = tick(p3, 0).state
    const p3Tick = tick(p3Noticed, HOST_LOST_GRACE_MS * 2)
    expect(p3Tick.state.hostId).toBe('p1')
    expect(p3Tick.effects).toHaveLength(0)
  })

  it('非 LOBBY 阶段拒绝接管（游戏内不做主机迁移）', () => {
    const playing = setPhase(gone(clientView('p2', 100, 'p1'), 'p1').state, 'PLAYING')
    const noticed = tick(playing, 0).state
    const result = tick(noticed, HOST_LOST_GRACE_MS * 3)

    expect(result.state.hostId).toBe('p1')
    expect(result.effects).toHaveLength(0)
  })

  it('房主回来 → 清除掉线计时', () => {
    const p2 = gone(clientView('p2', 100, 'p1'), 'p1').state
    const noticed = tick(p2, 0).state
    expect(noticed.hostLostAt).toBe(0)

    const back = seen(noticed, rec('p1', 0)).state
    expect(back.hostLostAt).toBeNull()
  })

  it('pickSuccessor 取最早加入者，同刻按 playerId 字典序', () => {
    expect(pickSuccessor({ a: rec('a', 100), b: rec('b', 50) })).toBe('b')
    expect(pickSuccessor({ z: rec('z', 100), a: rec('a', 100) })).toBe('a')
    expect(pickSuccessor({ a: { ...rec('a', 1), connected: false } })).toBeNull()
  })
})
