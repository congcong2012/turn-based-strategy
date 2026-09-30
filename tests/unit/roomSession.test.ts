import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoomSession } from '../../src/net/roomSession'
import type { RoomSession, RoomView } from '../../src/net/roomSession'
import { createMemoryHub } from './support/memoryHub'
import type { MemoryHub } from './support/memoryHub'
import type { Transport, TransportFactory, TransportHandlers } from '../../src/net/types'

const ROOM = 'AB23CD'

interface Peer {
  session: RoomSession
  view: RoomView
}

function makePeer(
  hub: MemoryHub,
  playerId: string,
  nickname: string,
  transportFactory?: TransportFactory,
): Peer {
  const peer: Peer = { session: null as unknown as RoomSession, view: null as unknown as RoomView }
  peer.session = createRoomSession({
    playerId,
    nickname,
    strategy: 'mqtt',
    kind: 'local',
    transportFactory: transportFactory ?? hub.createFactory(),
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
    // M2：开始游戏后进入部署阶段，并生成权威对局状态
    expect(alice.view.notice).toContain('部署阶段')
    expect(alice.view.game?.phase).toBe('DEPLOY')
    expect(bob.view.game?.phase).toBe('DEPLOY')
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

  it('房间容量 4：第 3/4 人可加入，第 5 人被拒绝', async () => {
    const alice = makePeer(hub, 'alice', '甲')
    await alice.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(3200)
    const bob = makePeer(hub, 'bob', '乙')
    await bob.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(200)
    const carol = makePeer(hub, 'carol', '丙')
    await carol.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(200)
    const dave = makePeer(hub, 'dave', '丁')
    await dave.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(200)

    expect(alice.view.players.map((p) => p.playerId)).toEqual(['alice', 'bob', 'carol', 'dave'])
    expect(carol.view.players).toHaveLength(4)

    const eve = makePeer(hub, 'eve', '戊')
    await eve.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(300)
    expect(eve.view.players).toHaveLength(0)
    expect(eve.view.roomCode).toBeNull()
    expect(eve.view.notice).toContain('房间已满')
    expect(alice.view.players).toHaveLength(4)
  })

  it('缺陷回归：join() 还在等传输时就被 leave()，会话不得复活（StrictMode 双挂载）', async () => {
    // 传输工厂先卡住：模拟 join 期间发生"卸载"（React StrictMode / 用户秒点离开）
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const base = hub.createFactory()
    const slowFactory: TransportFactory = async (handlers: TransportHandlers): Promise<Transport> => {
      await gate
      return base(handlers)
    }

    const alice = makePeer(hub, 'alice', '甲')
    await alice.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(3200)
    expect(alice.view.role).toBe('host')

    const bob = makePeer(hub, 'bob', '乙', slowFactory)
    const joining = bob.session.join(ROOM)
    await bob.session.leave() // 挂载即卸载
    await flush()
    release() // 传输这时才就绪

    await joining
    await vi.advanceTimersByTimeAsync(10_000)

    // 旧会话必须彻底作废：不自任房主、不再进房、不再打扰房主
    expect(bob.session.getView().role).toBe('idle')
    expect(bob.view.role).toBe('idle')
    expect(hub.peerIds()).toHaveLength(1) // 传输已被释放
    expect(alice.view.players).toHaveLength(1)
  })

  it('缺陷回归：新会话"继承"了已建连的房间（没有 peerJoin）也能收敛为客户端', async () => {
    const alice = makePeer(hub, 'alice', '甲')
    await alice.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(3200)
    expect(alice.view.role).toBe('host')

    // bob 刷新：新会话与 alice 之间连接已存在，但双方都不会再收到 peerJoin
    const bob = makePeer(hub, 'bob', '乙', hub.createFactory({ silent: true }))
    await bob.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(8000)

    // 靠"有 peer 但名单里没有别人 → 重发 hello"的兜底收敛
    expect(bob.view.role).toBe('client')
    expect(bob.view.hostNickname).toBe('甲')
    expect(bob.view.players.map((p) => p.playerId)).toEqual(['alice', 'bob'])
    expect(alice.view.players).toHaveLength(2)
    expect(alice.view.isHost).toBe(true)
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
