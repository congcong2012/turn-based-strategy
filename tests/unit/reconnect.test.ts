import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoomSession } from '../../src/net/roomSession'
import type { RoomSession, RoomView } from '../../src/net/roomSession'
import type { GameStorage } from '../../src/net/gameStore'
import { createMemoryHub } from './support/memoryHub'
import type { MemoryHub } from './support/memoryHub'

const ROOM = 'AB23CD'

interface Peer { session: RoomSession; view: RoomView }

function memoryStorage(): GameStorage {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

function makePeer(hub: MemoryHub, playerId: string, nickname: string, storage: GameStorage): Peer {
  const peer: Peer = { session: null as unknown as RoomSession, view: null as unknown as RoomView }
  peer.session = createRoomSession({
    playerId,
    nickname,
    strategy: 'mqtt',
    kind: 'local',
    transportFactory: hub.createFactory(),
    storage,
    onChange: (view) => { peer.view = view },
  })
  return peer
}

/** 走到 PLAYING：甲先手，双方各放一个刀盾兵，甲再移动一次 */
async function playingGame(hub: MemoryHub, storage: GameStorage) {
  const alice = makePeer(hub, 'alice', '甲', storage)
  await alice.session.join(ROOM)
  await vi.advanceTimersByTimeAsync(3200)
  const bob = makePeer(hub, 'bob', '乙', storage)
  await bob.session.join(ROOM)
  await vi.advanceTimersByTimeAsync(200)

  alice.session.setReady(true)
  bob.session.setReady(true)
  await vi.advanceTimersByTimeAsync(100)
  alice.session.startGame()
  await vi.advanceTimersByTimeAsync(100)

  alice.session.sendCommand({ type: 'deploy', unitType: 'sword', x: 11, y: 4 })
  bob.session.sendCommand({ type: 'deploy', unitType: 'sword', x: 11, y: 19 })
  await vi.advanceTimersByTimeAsync(100)
  alice.session.sendCommand({ type: 'deployDone' })
  bob.session.sendCommand({ type: 'deployDone' })
  await vi.advanceTimersByTimeAsync(200)

  const unit = alice.view.game!.units.find((u) => u.owner === 'alice')!
  alice.session.sendCommand({ type: 'move', unitId: unit.id, x: 11, y: 7 })
  await vi.advanceTimersByTimeAsync(200)
  return { alice, bob, unitId: unit.id }
}

describe('断线重连', () => {
  let hub: MemoryHub
  let storage: GameStorage
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    hub = createMemoryHub()
    storage = memoryStorage()
  })
  afterEach(() => { vi.useRealTimers() })

  it('房主刷新后恢复整局，并把状态补发给对手', async () => {
    const { alice, bob, unitId } = await playingGame(hub, storage)
    expect(alice.view.game?.phase).toBe('PLAYING')
    expect(bob.view.game?.units.find((u) => u.id === unitId)?.y).toBe(7)

    // 房主"刷新"：旧会话断开 → 同 playerId 新会话加入（同一浏览器 = 同一 storage）
    await alice.session.leave()
    await vi.advanceTimersByTimeAsync(200)
    expect(bob.view.paused).toBe(true)
    expect(bob.view.pausedReason).toBe('host-offline')

    const aliceAgain = makePeer(hub, 'alice', '甲', storage)
    await aliceAgain.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(3400)

    expect(aliceAgain.view.role).toBe('host')
    expect(aliceAgain.view.paused).toBe(false)
    expect(aliceAgain.view.game?.phase).toBe('PLAYING')
    expect(aliceAgain.view.game?.units.find((u) => u.id === unitId)?.y).toBe(7)
    expect(aliceAgain.view.notice).toContain('恢复')
    // 对手侧也恢复，并且不再暂停
    expect(bob.view.paused).toBe(false)
    expect(bob.view.game?.units.find((u) => u.id === unitId)?.y).toBe(7)
    expect(bob.view.game?.funds.alice).toBe(aliceAgain.view.game?.funds.alice)

    // 恢复后能继续正常行动
    aliceAgain.session.sendCommand({ type: 'endTurn' })
    await vi.advanceTimersByTimeAsync(200)
    expect(bob.view.myTurn).toBe(true)
  })

  it('对手掉线：席位保留、标记离线，轮到其回合时房主可跳过', async () => {
    const { alice, bob } = await playingGame(hub, storage)
    const bobPeerId = hub.peerIds().find((id) => id !== hub.peerIds()[0])! // 第二个连接
    void bobPeerId

    // 让乙断开（模拟关掉页面）
    await bob.session.leave()
    await vi.advanceTimersByTimeAsync(200)

    // 席位仍在，只是标记为离线
    expect(alice.view.players).toHaveLength(2)
    expect(alice.view.offlinePlayers).toContain('bob')
    expect(alice.view.game?.units.filter((u) => u.owner === 'bob')).toHaveLength(1)

    // 甲结束回合 → 轮到掉线的乙 → 暂停并允许房主跳过
    alice.session.sendCommand({ type: 'endTurn' })
    await vi.advanceTimersByTimeAsync(200)
    expect(alice.view.paused).toBe(true)
    expect(alice.view.pausedReason).toBe('player-offline')
    expect(alice.view.canSkipTurn).toBe(true)

    alice.session.skipDisconnectedTurn()
    await vi.advanceTimersByTimeAsync(200)
    expect(alice.view.myTurn).toBe(true)
    expect(alice.view.paused).toBe(false)
    expect(alice.view.game?.units.filter((u) => u.owner === 'bob')).toHaveLength(1)
  })

  it('掉线玩家回来后拿到最新状态并能继续行动', async () => {
    const { alice, bob, unitId } = await playingGame(hub, storage)
    await bob.session.leave()
    await vi.advanceTimersByTimeAsync(200)

    // 甲继续行动：结束回合（乙的回合被跳过）后再移动
    alice.session.sendCommand({ type: 'endTurn' })
    await vi.advanceTimersByTimeAsync(200)
    alice.session.skipDisconnectedTurn()
    await vi.advanceTimersByTimeAsync(200)

    const bobAgain = makePeer(hub, 'bob', '乙', storage)
    await bobAgain.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(300)

    expect(bobAgain.view.game?.phase).toBe('PLAYING')
    expect(bobAgain.view.offlinePlayers).toEqual([])
    expect(bobAgain.view.game?.units.find((u) => u.id === unitId)?.y).toBe(7)
  })

  it('对局结束后不再恢复（避免回到已结束的残局）', async () => {
    const { alice, bob } = await playingGame(hub, storage)
    alice.session.sendCommand({ type: 'resign' })
    await vi.advanceTimersByTimeAsync(200)
    expect(alice.view.game?.phase).toBe('GAME_OVER')

    await alice.session.leave()
    await vi.advanceTimersByTimeAsync(200)
    const aliceAgain = makePeer(hub, 'alice', '甲', storage)
    await aliceAgain.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(3400)
    expect(aliceAgain.view.game).toBeNull()
    void bob
  })
})
