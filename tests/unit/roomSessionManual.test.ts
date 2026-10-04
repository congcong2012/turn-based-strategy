/**
 * 手动直连的相位竞争回归测试（2026-10-04）。
 *
 * 背景：`submitManualCode` 在 `await mt.acceptAnswerCode(code)` 之后，用**调用前捕获的快照**写回相位。
 * 而 `acceptAnswerCode` 会一直等到数据通道打开 —— 通道打开的那一刻，`onStatus('connected')`
 * 已经把相位推到 'connected'，随后又被旧快照覆盖回 'connecting'：
 * 房主页面从「房间视图」退回「加入表单」，而且再也回不去。
 *
 * E2E 里的表现是"等房主的开始按钮超时 / 按钮被从 DOM 上摘掉"——
 * 这条轨道曾两次被记为"负载敏感的偶发抖动"，直到抓出这个时序才定论。
 *
 * 这里用注入的假手动传输**精确复现**"先 connected、后 resolve"的时序
 * （真实 WebRTC 在单测环境里跑不起来，所以给 RoomSessionOptions 加了 manualTransportFactory 口子）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoomSession } from '../../src/net/roomSession'
import type { RoomSession, RoomView } from '../../src/net/roomSession'
import type { ManualTransport } from '../../src/net/manualTransport'
import type { TransportHandlers } from '../../src/net/types'

const ROOM = 'AB23CD'

type ManualFactory = (options: {
  role: 'host' | 'guest'
  handlers: TransportHandlers
}) => ManualTransport

/** 假手动传输：只关心"连接那一刻"的事件顺序，不碰真实 WebRTC */
function fakeManualFactory(acceptAnswer: (handlers: TransportHandlers) => Promise<void>): ManualFactory {
  return ({ handlers }) => ({
    role: 'host',
    selfId: 'manual-host',
    kind: 'manual',
    getPeers: () => [],
    send: () => {},
    leave: async () => {
      handlers.onStatus('closed')
    },
    createOfferCode: async () => 'AT1:' + 'o'.repeat(300),
    acceptOfferCode: async () => 'AT1:' + 'a'.repeat(300),
    acceptAnswerCode: () => acceptAnswer(handlers),
  })
}

function makeSession(factory: ManualFactory): { session: RoomSession; view: () => RoomView } {
  let view: RoomView | null = null
  const session = createRoomSession({
    playerId: 'alice',
    nickname: '甲',
    strategy: 'mqtt',
    kind: 'local',
    transportFactory: async () => {
      throw new Error('手动直连不应使用常规传输')
    },
    manualTransportFactory: factory,
    onChange: (next) => {
      view = next
    },
  })
  return { session, view: () => view as RoomView }
}

describe('手动直连 · 相位竞争（回归）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('★ 通道打开（先 connected）之后 acceptAnswerCode 才返回：相位必须停在 connected', async () => {
    const { session, view } = makeSession(
      fakeManualFactory(async (handlers) => {
        // 真实时序：dc.onopen → status('connected') →（最多 200ms 后）waitForOpen 的轮询让 Promise 返回
        handlers.onStatus('connected')
        await Promise.resolve()
      }),
    )
    await session.startManualPairing(ROOM, 'host')
    await vi.advanceTimersByTimeAsync(0)
    expect(view().manual?.phase).toBe('need-answer')

    await session.submitManualCode('AT1:' + 'a'.repeat(300))
    await vi.advanceTimersByTimeAsync(0)
    // 旧实现这里是 'connecting'：房间视图被卸载、房主退回加入表单（E2E 表现为按钮被摘掉）
    expect(view().manual?.phase).toBe('connected')
    expect(view().status).toBe('connected')
  })

  it('★ 等待通道超时（status=failed）时相位应落到 failed，而不是永远挂在"建立中"', async () => {
    const { session, view } = makeSession(
      fakeManualFactory(async (handlers) => {
        handlers.onStatus('failed', '连接超时：请确认两边都粘贴了正确的连接码')
      }),
    )
    await session.startManualPairing(ROOM, 'host')
    await vi.advanceTimersByTimeAsync(0)
    await session.submitManualCode('AT1:' + 'a'.repeat(300))
    await vi.advanceTimersByTimeAsync(0)
    expect(view().manual?.phase).toBe('failed')
    expect(view().manual?.error).toContain('超时')
  })
})
