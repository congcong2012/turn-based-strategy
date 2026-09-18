import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoomSession } from '../../src/net/roomSession'
import type { RoomSession, RoomView } from '../../src/net/roomSession'
import { createMemoryHub } from './support/memoryHub'
import type { MemoryHub } from './support/memoryHub'

const ROOM = 'AB23CD'

interface Peer {
  session: RoomSession
  view: RoomView
}

function makePeer(hub: MemoryHub, playerId: string, nickname: string): Peer {
  const peer: Peer = { session: null as unknown as RoomSession, view: null as unknown as RoomView }
  peer.session = createRoomSession({
    playerId,
    nickname,
    strategy: 'mqtt',
    kind: 'local',
    transportFactory: hub.createFactory(),
    onChange: (view) => {
      peer.view = view
    },
  })
  return peer
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('房间会话（双端内存传输）', () => {
  let hub: MemoryHub

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    hub = createMemoryHub()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('第一个加入者自动成为房主，后加入者成为客户端', async () => {
    const alice = makePeer(hub, 'alice', '甲')
    await alice.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(3200)

    expect(alice.view.role).toBe('host')
    expect(alice.view.isHost).toBe(true)

    const bob = makePeer(hub, 'bob', '乙')
    await bob.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(200)

    expect(bob.view.role).toBe('client')
    expect(bob.view.isHost).toBe(false)
    expect(bob.view.hostNickname).toBe('甲')

    // 房主权威名单里两人都在，且房主标识只有 alice
    expect(alice.view.players).toHaveLength(2)
    expect(bob.view.players).toHaveLength(2)
    expect(bob.view.players.filter((p) => p.isHost).map((p) => p.playerId)).toEqual(['alice'])
  })

  it('准备状态同步：双方都准备后房主可开始', async () => {
    const alice = makePeer(hub, 'alice', '甲')
    await alice.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(3200)

    const bob = makePeer(hub, 'bob', '乙')
    await bob.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(200)
    expect(alice.view.canStart).toBe(false)

    bob.session.setReady(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(alice.view.players.find((p) => p.playerId === 'bob')?.ready).toBe(true)
    expect(bob.view.ready).toBe(true)
    expect(alice.view.canStart).toBe(false) // 房主自己还没准备

    alice.session.setReady(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(alice.view.canStart).toBe(true)
    expect(bob.view.canStart).toBe(true)

    // 非房主点了开始也不会广播提示
    bob.session.startGame()
    await vi.advanceTimersByTimeAsync(50)
    expect(alice.view.notice).not.toContain('M2') // 非房主无法触发开始

    alice.session.startGame()
    await vi.advanceTimersByTimeAsync(50)
    expect(alice.view.notice).toContain('M2')
    expect(bob.view.notice).toContain('M2')
  })

  it('竞态：双方同时自任房主 → 收敛到同一房主', async () => {
    hub.pause()
    const p1 = makePeer(hub, 'p1', '甲')
    const p2 = makePeer(hub, 'p2', '乙')
    await p1.session.join(ROOM)
    await p2.session.join(ROOM)

    await vi.advanceTimersByTimeAsync(3200)
    expect(p1.view.role).toBe('host')
    expect(p2.view.role).toBe('host')

    hub.resume()
    await vi.advanceTimersByTimeAsync(500)

    expect(p1.view.isHost).toBe(true)
    expect(p2.view.isHost).toBe(false)
    expect(p2.view.role).toBe('client')
    expect(p1.view.players).toHaveLength(2)
    expect(p2.view.players).toHaveLength(2)
  })

  it('玩家离开 → 列表更新；房主离开 → 剩余玩家接管', async () => {
    const alice = makePeer(hub, 'alice', '甲')
    await alice.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(3200)

    const bob = makePeer(hub, 'bob', '乙')
    await bob.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(200)
    expect(alice.view.players).toHaveLength(2)

    await bob.session.leave()
    await vi.advanceTimersByTimeAsync(200)
    expect(alice.view.players).toHaveLength(1)

    // 房主掉线：5 秒宽限期后 bob 不在场，则由 alice 自己维持房主
    hub.disconnect(hub.peerIds()[0])
    await vi.advanceTimersByTimeAsync(6000)
    expect(alice.view.role).toBe('host')
  })

  it('房主掉线 → 客户端在宽限期后接管', async () => {
    const alice = makePeer(hub, 'alice', '甲')
    await alice.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(3200)

    const bob = makePeer(hub, 'bob', '乙')
    await bob.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(200)
    expect(bob.view.role).toBe('client')

    hub.disconnect(hub.peerIds()[0]) // alice 掉线
    await vi.advanceTimersByTimeAsync(1000)
    expect(bob.view.isHost).toBe(false)

    await vi.advanceTimersByTimeAsync(5000)
    expect(bob.view.role).toBe('host')
    expect(bob.view.isHost).toBe(true)
  })

  it('刷新重连：同一 playerId 用新连接回来，不产生重复条目', async () => {
    const alice = makePeer(hub, 'alice', '甲')
    await alice.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(3200)

    const bob = makePeer(hub, 'bob', '乙')
    await bob.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(200)
    bob.session.setReady(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(alice.view.players).toHaveLength(2)
    expect(alice.view.players[1].ready).toBe(true)

    // 刷新 = 旧连接断开 + 同 playerId 新连接
    const bobAgain = makePeer(hub, 'bob', '乙')
    await bobAgain.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(300)

    expect(alice.view.players).toHaveLength(2)
    expect(alice.view.players.map((p) => p.playerId)).toEqual(['alice', 'bob'])
    expect(alice.view.players[1].ready).toBe(false) // 重连后准备状态重置
    expect(bobAgain.view.hostNickname).toBe('甲')
  })

  it('房间满员：第三名玩家被拒绝，名单不变', async () => {
    const alice = makePeer(hub, 'alice', '甲')
    await alice.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(3200)
    const bob = makePeer(hub, 'bob', '乙')
    await bob.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(200)

    const carol = makePeer(hub, 'carol', '丙')
    await carol.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(300)

    expect(alice.view.players).toHaveLength(2)
    // 被拒绝的玩家：退回加入界面并给出提示
    expect(carol.view.players).toHaveLength(0)
    expect(carol.view.roomCode).toBeNull()
    expect(carol.view.notice).toContain('房间已满')
    expect(alice.view.players.map((p) => p.playerId)).toEqual(['alice', 'bob'])
  })

  it('非法房间码被拒绝且不建立连接', async () => {
    const alice = makePeer(hub, 'alice', '甲')
    await alice.session.join('AB')
    await flush()
    expect(alice.view.error).toContain('6 位')
    expect(alice.view.roomCode).toBeNull()
    expect(hub.peerIds()).toHaveLength(0)
  })

  it('改名同步到房主名单', async () => {
    const alice = makePeer(hub, 'alice', '甲')
    await alice.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(3200)
    const bob = makePeer(hub, 'bob', '乙')
    await bob.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(200)

    bob.session.setNickname('飞将军')
    await vi.advanceTimersByTimeAsync(100)
    expect(alice.view.players.find((p) => p.playerId === 'bob')?.nickname).toBe('飞将军')
    expect(bob.view.players.find((p) => p.playerId === 'bob')?.nickname).toBe('飞将军')
  })
})
