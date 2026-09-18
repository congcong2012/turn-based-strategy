import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoomSession } from '../../src/net/roomSession'
import type { RoomSession, RoomView } from '../../src/net/roomSession'
import { createMemoryHub } from './support/memoryHub'
import type { MemoryHub } from './support/memoryHub'

const ROOM = 'AB23CD'

interface Peer { session: RoomSession; view: RoomView }

function makePeer(hub: MemoryHub, playerId: string, nickname: string): Peer {
  const peer: Peer = { session: null as unknown as RoomSession, view: null as unknown as RoomView }
  peer.session = createRoomSession({
    playerId,
    nickname,
    strategy: 'mqtt',
    kind: 'local',
    transportFactory: hub.createFactory(),
    onChange: (view) => { peer.view = view },
  })
  return peer
}

async function twoPeers(hub: MemoryHub) {
  const alice = makePeer(hub, 'alice', '甲')
  await alice.session.join(ROOM)
  await vi.advanceTimersByTimeAsync(3200)
  const bob = makePeer(hub, 'bob', '乙')
  await bob.session.join(ROOM)
  await vi.advanceTimersByTimeAsync(200)
  return { alice, bob }
}

describe('对局指令的房间集成（房主权威）', () => {
  let hub: MemoryHub
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    hub = createMemoryHub()
  })
  afterEach(() => { vi.useRealTimers() })

  it('房主开局进入部署阶段，双方看到同一份状态', async () => {
    const { alice, bob } = await twoPeers(hub)
    expect(alice.view.game).toBeNull()

    alice.session.setReady(true)
    bob.session.setReady(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(alice.view.canStart).toBe(true)

    alice.session.startGame()
    await vi.advanceTimersByTimeAsync(100)

    expect(alice.view.game?.phase).toBe('DEPLOY')
    expect(bob.view.game?.phase).toBe('DEPLOY')
    expect(bob.view.game?.players).toEqual(['alice', 'bob'])
    // 非房主不能开局
    expect(bob.view.isHost).toBe(false)
  })

  it('客户端指令经房主校验后生效，非法指令被拒绝且状态不变', async () => {
    const { alice, bob } = await twoPeers(hub)
    alice.session.setReady(true)
    bob.session.setReady(true)
    await vi.advanceTimersByTimeAsync(100)
    alice.session.startGame()
    await vi.advanceTimersByTimeAsync(100)

    // bob 在己方部署区（南半场 y19..23）放一个刀盾兵
    bob.session.sendCommand({ type: 'deploy', unitType: 'sword', x: 11, y: 22 })
    await vi.advanceTimersByTimeAsync(100)
    expect(alice.view.game?.units).toHaveLength(1)
    expect(bob.view.game?.units).toHaveLength(1)
    expect(bob.view.game?.deploy.bob.placed).toBe(1)

    // 非法：部署到对方半场
    bob.session.sendCommand({ type: 'deploy', unitType: 'sword', x: 11, y: 2 })
    await vi.advanceTimersByTimeAsync(100)
    expect(bob.view.game?.units).toHaveLength(1)
    expect(bob.view.error).toContain('DEPLOY_ZONE_INVALID')

    // 非法：预算不足
    bob.session.sendCommand({ type: 'deploy', unitType: 'heavyCav', x: 10, y: 22 })
    await vi.advanceTimersByTimeAsync(100)
    expect(bob.view.error).toContain('DEPLOY_BUDGET_EXCEEDED')
  })

  it('部署完成 → PLAYING，只有当前玩家能行动', async () => {
    const { alice, bob } = await twoPeers(hub)
    alice.session.setReady(true)
    bob.session.setReady(true)
    await vi.advanceTimersByTimeAsync(100)
    alice.session.startGame()
    await vi.advanceTimersByTimeAsync(100)

    alice.session.sendCommand({ type: 'deploy', unitType: 'sword', x: 11, y: 1 })
    bob.session.sendCommand({ type: 'deploy', unitType: 'sword', x: 11, y: 22 })
    await vi.advanceTimersByTimeAsync(100)
    alice.session.sendCommand({ type: 'deployDone' })
    bob.session.sendCommand({ type: 'deployDone' })
    await vi.advanceTimersByTimeAsync(150)

    expect(alice.view.game?.phase).toBe('PLAYING')
    expect(alice.view.myTurn).toBe(true)
    expect(bob.view.myTurn).toBe(false)
    // 先手方 alice 的 START 已结算（起始 4000 + 王城 1200 + 兵营 300×2）
    expect(alice.view.game?.funds.alice).toBe(5800)

    // 不是自己的回合 → 拒绝
    const unit = bob.view.game!.units.find((u) => u.owner === 'bob')!
    bob.session.sendCommand({ type: 'move', unitId: unit.id, x: 11, y: 21 })
    await vi.advanceTimersByTimeAsync(100)
    expect(bob.view.error).toContain('NOT_YOUR_TURN')
    expect(bob.view.game?.units.find((u) => u.id === unit.id)?.y).toBe(22)

    // 房主移动自己的单位 → 双方同步
    const mine = alice.view.game!.units.find((u) => u.owner === 'alice')!
    alice.session.sendCommand({ type: 'move', unitId: mine.id, x: 11, y: 2 })
    await vi.advanceTimersByTimeAsync(100)
    expect(bob.view.game?.units.find((u) => u.id === mine.id)?.y).toBe(2)

    // 结束回合 → 轮到 bob，并结算收入
    alice.session.sendCommand({ type: 'endTurn' })
    await vi.advanceTimersByTimeAsync(150)
    expect(alice.view.myTurn).toBe(false)
    expect(bob.view.myTurn).toBe(true)
    expect(bob.view.game?.turnIndex).toBe(1)
  })

  it('重连时房主补发完整对局快照', async () => {
    const { alice, bob } = await twoPeers(hub)
    alice.session.setReady(true)
    bob.session.setReady(true)
    await vi.advanceTimersByTimeAsync(100)
    alice.session.startGame()
    await vi.advanceTimersByTimeAsync(100)
    bob.session.sendCommand({ type: 'deploy', unitType: 'sword', x: 11, y: 22 })
    await vi.advanceTimersByTimeAsync(100)

    // bob 刷新：新连接、同 playerId
    const bobAgain = makePeer(hub, 'bob', '乙')
    await bobAgain.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(300)

    expect(bobAgain.view.game?.phase).toBe('DEPLOY')
    expect(bobAgain.view.game?.units).toHaveLength(1)
  })
})
