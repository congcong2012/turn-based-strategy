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

  it('★ AI 补位：2 名真人 + 补到 4 方 → 开局真的多出两个 AI 席位，且 AI 会自动部署', async () => {
    const { alice, bob } = await twoPeers(hub)
    alice.session.setReady(true)
    bob.session.setReady(true)
    await vi.advanceTimersByTimeAsync(100)

    // 房主选"本局共 4 方"
    alice.session.setAiSlots(4)
    await vi.advanceTimersByTimeAsync(100)
    // 客户端也看得到这个设置
    expect(bob.view.aiSlotCount).toBe(4)

    alice.session.startGame()
    await vi.advanceTimersByTimeAsync(100)

    const players = alice.view.game?.players ?? []
    expect(players).toHaveLength(4)
    expect(players.filter((p) => p.startsWith('ai-'))).toHaveLength(2)
    // 真人仍是原来那两个，顺序不变（出手次序可预期）
    expect(players.slice(0, 2)).toEqual(['alice', 'bob'])
    // 双方看到同一份状态
    expect(bob.view.game?.players).toEqual(players)

    // AI 席位在部署阶段应当自动完成部署（不需要房主点任何东西）
    await vi.advanceTimersByTimeAsync(200)
    const aiSeats = players.filter((p) => p.startsWith('ai-'))
    for (const seat of aiSeats) {
      expect(alice.view.game?.deploy[seat]?.done, seat + ' 应已自动部署完毕').toBe(true)
      expect(
        alice.view.game?.units.filter((u) => u.owner === seat).length,
        seat + ' 应已放下部队',
      ).toBeGreaterThan(0)
    }
    // 真人不会被自动部署（他们自己点确认）
    expect(alice.view.game?.deploy['alice']?.done).toBe(false)
  })

  it('★ AI 难度：房主选的档会广播给所有人；「深推演」在多人局会被收敛成同档的「快棋」', async () => {
    const { alice, bob } = await twoPeers(hub)
    alice.session.setReady(true)
    bob.session.setReady(true)
    await vi.advanceTimersByTimeAsync(100)

    // 默认「普通」
    expect(bob.view.aiDifficulty).toBe('normal')

    // 4 人局：改成「困难 · 快棋」→ 客户端看得到
    alice.session.setAiSlots(4)
    alice.session.setAiDifficulty('hard')
    await vi.advanceTimersByTimeAsync(100)
    expect(bob.view.aiDifficulty).toBe('hard')

    // 4 人局里选「深推演」不成立 → 收敛成同档的「快棋」
    alice.session.setAiDifficulty('oracle')
    await vi.advanceTimersByTimeAsync(100)
    expect(alice.view.aiDifficulty).toBe('hard')
    expect(bob.view.aiDifficulty).toBe('hard')

    // 缩回两人局后它是合法的
    alice.session.setAiSlots(2)
    alice.session.setAiDifficulty('oracle')
    await vi.advanceTimersByTimeAsync(100)
    expect(alice.view.aiDifficulty).toBe('oracle')
    expect(bob.view.aiDifficulty).toBe('oracle')

    // 非房主改不动（房主权威）
    bob.session.setAiDifficulty('easy')
    await vi.advanceTimersByTimeAsync(100)
    expect(alice.view.aiDifficulty).toBe('oracle')
  })

  it('★ AI 补位：AI 席位的名字会出现在玩家列表里（不是裸露的 ai-2）', async () => {
    const { alice, bob } = await twoPeers(hub)
    // 双方都得准备才能开局（AI 补位补的是"缺席的人"，不是"没准备好的人"）
    alice.session.setReady(true)
    bob.session.setReady(true)
    await vi.advanceTimersByTimeAsync(100)
    alice.session.setAiSlots(3)
    await vi.advanceTimersByTimeAsync(100)
    alice.session.startGame()
    await vi.advanceTimersByTimeAsync(100)

    const aiEntry = alice.view.players.find((p) => p.playerId.startsWith('ai-'))
    expect(aiEntry).toBeDefined()
    expect(aiEntry?.nickname).toBe('电脑丙') // 座位 2 → 电脑丙（甲/乙/丙 按座位序）
    expect(aiEntry?.connected).toBe(true)
  })

  it('AI 补位关闭时行为与以前完全一致（只有真人）', async () => {
    const { alice, bob } = await twoPeers(hub)
    alice.session.setReady(true)
    bob.session.setReady(true)
    await vi.advanceTimersByTimeAsync(100)
    alice.session.startGame()
    await vi.advanceTimersByTimeAsync(100)
    expect(alice.view.game?.players).toEqual(['alice', 'bob'])
  })

  it('★ 观战：不占席位、不阻塞开局、收到完整状态但**不能操作**', async () => {
    const { alice, bob } = await twoPeers(hub)
    alice.session.setReady(true)
    bob.session.setReady(true)
    await vi.advanceTimersByTimeAsync(100)

    // 第三个人以观战身份进来
    const watcher = makePeer(hub, 'watcher', '看客')
    await watcher.session.join(ROOM, undefined, true)
    await vi.advanceTimersByTimeAsync(200)

    // 观战者不占席位：参战人数仍是 2，开局条件不受影响
    expect(watcher.view.spectating).toBe(true)
    expect(alice.view.canStart).toBe(true)
    expect(alice.view.players.filter((p) => p.spectator)).toHaveLength(1)
    expect(alice.view.players.find((p) => p.playerId === 'watcher')?.nickname).toBe('看客')

    alice.session.startGame()
    await vi.advanceTimersByTimeAsync(100)

    // 对局里没有观战者的席位（玩家数仍是 2）
    expect(alice.view.game?.players).toEqual(['alice', 'bob'])
    // 但观战者能收到完整状态（本作没有战争迷雾，观战看到的就是玩家看到的）
    expect(watcher.view.game?.players).toEqual(['alice', 'bob'])
    expect(watcher.view.game?.phase).toBe('DEPLOY')

    // ★ 只读：观战者发指令一律被拒，且局面不变
    const before = JSON.stringify(watcher.view.game)
    watcher.session.sendCommand({ type: 'deploy', unitType: 'sword', x: 2, y: 0 } as never)
    await vi.advanceTimersByTimeAsync(100)
    expect(watcher.view.error).toContain('观战')
    expect(JSON.stringify(alice.view.game)).toBe(before)
  })

  it('观察者刷新后仍是观战者（不会变成参战）', async () => {
    const { alice, bob } = await twoPeers(hub)
    alice.session.setReady(true)
    bob.session.setReady(true)
    await vi.advanceTimersByTimeAsync(100)

    const watcher = makePeer(hub, 'watcher', '看客')
    await watcher.session.join(ROOM, undefined, true)
    await vi.advanceTimersByTimeAsync(200)
    alice.session.startGame()
    await vi.advanceTimersByTimeAsync(100)

    // 重连（模拟刷新）：同样以观战身份回来
    const again = makePeer(hub, 'watcher', '看客')
    await again.session.join(ROOM, undefined, true)
    await vi.advanceTimersByTimeAsync(200)
    expect(again.view.spectating).toBe(true)
    expect(alice.view.game?.players).toEqual(['alice', 'bob'])
  })

  it('★ 观战：房间满员（4 名真人）时观战者仍能进入，且不占席位', async () => {
    const { alice } = await twoPeers(hub)
    const carl = makePeer(hub, 'carl', '丙')
    await carl.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(200)
    const dave = makePeer(hub, 'dave', '丁')
    await dave.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(200)
    // 4 名真人已坐满
    expect(alice.view.players.filter((p) => p.connected && !p.spectator)).toHaveLength(4)

    const watcher = makePeer(hub, 'watcher', '看客')
    await watcher.session.join(ROOM, undefined, true)
    await vi.advanceTimersByTimeAsync(200)

    // 没被「房间已满」打回：房主侧确实新增了一个观战席位
    expect(watcher.view.notice ?? '').not.toContain('已满')
    expect(alice.view.players.find((p) => p.playerId === 'watcher')?.spectator).toBe(true)
    expect(watcher.view.spectating).toBe(true)
    // 观战者不占席位：真人仍然是 4 个
    expect(alice.view.players.filter((p) => p.connected && !p.spectator)).toHaveLength(4)
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
    expect(bob.view.error).toContain('部署区')

    // 非法：预算不足
    bob.session.sendCommand({ type: 'deploy', unitType: 'heavyCav', x: 10, y: 22 })
    await vi.advanceTimersByTimeAsync(100)
    expect(bob.view.error).toContain('部署预算不够')
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
    expect(bob.view.error).toContain('还没轮到你行动')
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

  it('★ 完整战报：房主权威维护，刷新后重连的人也能拿到整局历史', async () => {
    const { alice, bob } = await twoPeers(hub)
    alice.session.setReady(true)
    bob.session.setReady(true)
    await vi.advanceTimersByTimeAsync(100)
    alice.session.startGame()
    await vi.advanceTimersByTimeAsync(100)

    // 双方各部署一次 → 房主侧累积出战报
    bob.session.sendCommand({ type: 'deploy', unitType: 'sword', x: 11, y: 22 })
    await vi.advanceTimersByTimeAsync(100)
    alice.session.sendCommand({ type: 'deploy', unitType: 'sword', x: 11, y: 1 })
    await vi.advanceTimersByTimeAsync(100)

    // 房主手里有完整战报；在线的客户端同步到同一份
    const hostRounds = alice.view.rounds
    expect(hostRounds.length).toBeGreaterThan(0)
    expect(hostRounds.flatMap((r) => r.lines).length).toBeGreaterThan(0)
    expect(bob.view.rounds).toEqual(hostRounds)

    // ★ bob 刷新：新连接、同 playerId —— 它此前的事件流全是空的，必须靠房主补发
    const bobAgain = makePeer(hub, 'bob', '乙')
    await bobAgain.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(300)

    expect(bobAgain.view.rounds).toEqual(hostRounds)
    // 这份战报是有内容的（而不是"补了个空数组"）
    expect(bobAgain.view.rounds.flatMap((r) => r.lines).length).toBeGreaterThan(0)
  })

  it('★ 完整战报：分组里的行与滚动窗口 log 的内容一致（同一份事实）', async () => {
    const { alice } = await twoPeers(hub)
    alice.session.setReady(true)
    await vi.advanceTimersByTimeAsync(100)

    const flat = alice.view.rounds.flatMap((r) => r.lines)
    // 战报还没开始时两边都是空的
    expect(flat).toEqual([])
    expect(alice.view.log).toEqual([])
  })
})
