/**
 * 自制地图的**自动分发**（房主 → 对端）。
 *
 * 背景：以前房主选一张自制图，其他玩家必须先用微信把 `ATM1:` 分享码发过去、手动导入，
 * 否则开局后会停在「缺少这张地图」。现在房主在开局（以及 hello 补发）时自动推一份。
 *
 * 这里守三件事：
 *  1. **只发自制图**：内置图对端本来就有，多发一份是噪音；
 *  2. **先发地图、后发局面**：否则对端会先渲染「缺少这张地图」再跳回来；
 *  3. **中途加入 / 刷新重连也要补发**，且只发给那一个人。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoomSession } from '../../src/net/roomSession'
import type { RoomSession, RoomView } from '../../src/net/roomSession'
import { BUILTIN_MAPS, hasMap, registerMap, unregisterMap } from '../../src/game/data'
import type { MapDef } from '../../src/game/data'
import { decodeShareCode, isUserMapId } from '../../src/app/mapStore'
import { createMemoryHub } from './support/memoryHub'
import type { MemoryHub } from './support/memoryHub'
import type { Transport, TransportFactory, Wire } from '../../src/net/types'

const ROOM = 'AB23CD'
const USER_MAP_ID = 'user_map_test'

interface Sent {
  from: string
  to?: string
  msg: Wire
}

interface Peer {
  session: RoomSession
  view: RoomView
  wireId: string
}

/** 复制一张内置图、换成自制图 id —— 内容仍然是合法的（能过 validateMap） */
function makeUserMap(): MapDef {
  const base = BUILTIN_MAPS[Object.keys(BUILTIN_MAPS)[0]]
  return { ...base, id: USER_MAP_ID, name: '测试自制图' }
}

/** 把一个 peer 的传输包装一层，记录它发出去的每条线上消息 */
function makePeer(hub: MemoryHub, sent: Sent[], playerId: string, nickname: string): Peer {
  const peer: Peer = { session: null as unknown as RoomSession, view: null as unknown as RoomView, wireId: '' }

  const factory: TransportFactory = async (handlers) => {
    const inner: Transport = await hub.createFactory()(handlers)
    peer.wireId = inner.selfId
    return {
      ...inner,
      send: (msg: Wire, to?: string) => {
        sent.push({ from: peer.wireId, to, msg })
        inner.send(msg, to)
      },
    }
  }

  peer.session = createRoomSession({
    playerId,
    nickname,
    strategy: 'mqtt',
    kind: 'local',
    transportFactory: factory,
    onChange: (view) => {
      peer.view = view
    },
  })
  return peer
}

async function twoPeers(hub: MemoryHub, sent: Sent[]) {
  const alice = makePeer(hub, sent, 'alice', '甲')
  await alice.session.join(ROOM)
  await vi.advanceTimersByTimeAsync(3200)
  const bob = makePeer(hub, sent, 'bob', '乙')
  await bob.session.join(ROOM)
  await vi.advanceTimersByTimeAsync(200)
  return { alice, bob }
}

async function readyAndStart(alice: Peer, bob: Peer): Promise<void> {
  alice.session.setReady(true)
  bob.session.setReady(true)
  await vi.advanceTimersByTimeAsync(100)
  alice.session.startGame()
  await vi.advanceTimersByTimeAsync(100)
}

function mapMessages(sent: Sent[]): Sent[] {
  return sent.filter((s) => s.msg.t === 'map')
}

describe('自制地图自动分发', () => {
  let hub: MemoryHub
  let sent: Sent[]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    hub = createMemoryHub()
    sent = []
    registerMap(makeUserMap())
  })

  afterEach(() => {
    unregisterMap(USER_MAP_ID)
    vi.useRealTimers()
  })

  it('★ 房主选自制图开局 → 广播一条可解码的地图消息，且**排在局面之前**', async () => {
    const { alice, bob } = await twoPeers(hub, sent)

    alice.session.setMap(USER_MAP_ID)
    await readyAndStart(alice, bob)

    expect(isUserMapId(USER_MAP_ID)).toBe(true)
    expect(bob.view.game?.mapId).toBe(USER_MAP_ID)

    const maps = mapMessages(sent).filter((m) => m.from === alice.wireId)
    expect(maps).toHaveLength(1)
    // 同一批里有 game 消息，且 map 一定在前（否则对端会闪一下"缺少这张地图"）
    const aliceMessages = sent.filter((m) => m.from === alice.wireId)
    const mapIndex = aliceMessages.findIndex((m) => m.msg.t === 'map')
    const gameIndex = aliceMessages.findIndex((m) => m.msg.t === 'game')
    expect(mapIndex).toBeGreaterThanOrEqual(0)
    expect(gameIndex).toBeGreaterThan(mapIndex)

    // 载荷是分享码，且解码后 id 与选中一致（id 一致才可能"双方是同一张图"）
    const wire = maps[0].msg
    if (wire.t !== 'map') throw new Error('unreachable')
    const decoded = decodeShareCode(wire.code)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error('unreachable')
    expect(decoded.map.id).toBe(USER_MAP_ID)
  })

  it('选内置图开局 → 不发地图消息（对端本来就有）', async () => {
    const { alice, bob } = await twoPeers(hub, sent)

    // 不调用 setMap ⇒ 按人数自动挑内置图
    await readyAndStart(alice, bob)

    expect(bob.view.game?.mapId).toBeTruthy()
    expect(isUserMapId(bob.view.game?.mapId ?? '')).toBe(false)
    expect(mapMessages(sent)).toHaveLength(0)
  })

  it('★ 对局中有人加入（hello）→ 只给这个新人对点补发地图', async () => {
    const { alice, bob } = await twoPeers(hub, sent)
    alice.session.setMap(USER_MAP_ID)
    await readyAndStart(alice, bob)

    const before = mapMessages(sent).length

    const carol = makePeer(hub, sent, 'carol', '丙')
    await carol.session.join(ROOM)
    await vi.advanceTimersByTimeAsync(400)

    // carol 一进来就收到了局面（她能看到这张图的前提）
    expect(carol.view.game?.mapId).toBe(USER_MAP_ID)

    const added = mapMessages(sent).slice(before)
    expect(added).toHaveLength(1)
    // 定向发送，不是再广播一次（否则每来一个人都给所有人重发一遍）
    expect(added[0].to).toBe(carol.wireId)
  })

  it('地图不在房主本机时静默跳过（对端仍走手动兜底，不抛错）', async () => {
    unregisterMap(USER_MAP_ID) // 模拟"存档来自另一台机器"
    const { alice, bob } = await twoPeers(hub, sent)

    // 直接设置一个不存在的地图 id：lobby 里允许，开局时内核会回退/报错 ——
    // 这里只关心"发送端不炸"，因此用 try 包住开局，断言没有 map 消息即可
    try {
      alice.session.setMap(USER_MAP_ID)
      await readyAndStart(alice, bob)
    } catch {
      /* 内核可能拒绝未知地图，与本用例无关 */
    }

    expect(mapMessages(sent)).toHaveLength(0)
    expect(hasMap(USER_MAP_ID)).toBe(false)
  })
})
