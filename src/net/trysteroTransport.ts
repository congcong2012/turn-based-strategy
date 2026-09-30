/**
 * Trystero 传输实现（真实 P2P：WebRTC DataChannel + 公共信令）
 *
 * 注意：trystero@0.25 起，'trystero/mqtt' 等子路径已改为废弃垫片（导入即抛错），
 * 官方已拆分为 @trystero-p2p/core | mqtt | torrent 等作用域包，这里使用新包。
 *
 * 信令策略实测（本机网络）：
 *   MQTT   broker.emqx.io ✓  broker-cn.emqx.io ✓  broker.hivemq.com ✓  test.mosquitto.org ✗
 *   Torrent tracker.openwebtorrent.com ✓
 *   Nostr  relay.damus.io / nos.lol 全部超时 ✗（因此不作默认）
 */

import type { JoinRoomConfig, Room } from '@trystero-p2p/core'
import type { SignalStrategy, Transport, TransportHandlers, Wire } from './types'

export const APP_ID = 'ancient-tactics-mvp-v1'

/** MQTT 中转：按实测可达性排序（国内优先 broker-cn） */
export const MQTT_RELAY_URLS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker-cn.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
]

/** Torrent 策略使用内置 tracker 默认值 */
export const TORRENT_RELAY_URLS: string[] = []

export function relayUrlsFor(strategy: SignalStrategy): string[] {
  return strategy === 'mqtt' ? MQTT_RELAY_URLS : TORRENT_RELAY_URLS
}

interface StrategyModule {
  joinRoom: (config: JoinRoomConfig, roomId: string, callbacks?: unknown) => Room
  selfId: string
}

async function loadStrategy(strategy: SignalStrategy): Promise<StrategyModule> {
  const mod =
    strategy === 'mqtt'
      ? await import('@trystero-p2p/mqtt')
      : await import('@trystero-p2p/torrent')
  return mod as unknown as StrategyModule
}

export interface TrysteroTransportOptions {
  roomCode: string
  strategy: SignalStrategy
  handlers: TransportHandlers
  /** 可选房间密码：参与 SDP 密钥派生与握手校验 */
  password?: string
}

export async function createTrysteroTransport(options: TrysteroTransportOptions): Promise<Transport> {
  const { roomCode, strategy, handlers, password } = options
  const mod = await loadStrategy(strategy)

  const urls = relayUrlsFor(strategy)
  const config: JoinRoomConfig = { appId: APP_ID }
  if (password) config.password = password
  if (urls.length > 0) {
    config.relayConfig = { urls, redundancy: urls.length }
  }

  handlers.onStatus('connecting')

  const room = mod.joinRoom(config, APP_ID + '::' + roomCode, {
    onJoinError: (err: { error: string }) => handlers.onStatus('failed', err.error),
  })

  const action = room.makeAction<Wire>('wire')
  action.onMessage = (data, context) => handlers.onMessage(data, context.peerId)
  room.onPeerJoin = (peerId) => handlers.onPeerJoin(peerId)
  room.onPeerLeave = (peerId) => handlers.onPeerLeave(peerId)

  // 信令健康检查：房间对象是同步返回的，但中继连接是异步的。
  // 早期版本直接报"已连接"会误导用户；这里改为轮询中继 socket 的真实状态。
  const getRelaySockets = (mod as unknown as { getRelaySockets?: () => unknown }).getRelaySockets
  let relayTimer: ReturnType<typeof setInterval> | null = null
  const checkRelays = (): boolean => {
    const raw = getRelaySockets?.() ?? []
    const list: unknown[] = typeof (raw as Iterable<unknown>)?.[Symbol.iterator] === 'function' ? [...(raw as Iterable<unknown>)] : Object.values(raw as Record<string, unknown>)
    return list.some((socket) => (socket as { readyState?: number })?.readyState === 1)
  }
  let relayAttempts = 0
  relayTimer = setInterval(() => {
    relayAttempts += 1
    if (checkRelays()) {
      handlers.onStatus('connected')
      if (relayTimer) clearInterval(relayTimer)
      relayTimer = null
      return
    }
    if (relayAttempts >= 12) {
      // 12 秒仍没有任何中继连接 → 明确失败并提示降级方案
      handlers.onStatus('failed', '公共信令连不上（可切换 Torrent 或改用手动直连）')
      if (relayTimer) clearInterval(relayTimer)
      relayTimer = null
    }
  }, 1000)
  handlers.onStatus('connecting', '正在连接公共信令…')

  // 幂等的 leave：Trystero 内部已注册 beforeunload 清理，这里只保证不会重复调用
  let leaving = false
  const leaveRoom = async (): Promise<void> => {
    if (leaving) return
    leaving = true
    try {
      await room.leave()
    } catch {
      /* 页面即将销毁，忽略 */
    }
  }

  // DEV 调试钩子：可在控制台/自动化里检查信令与 peer 连接状态
  if (import.meta.env.DEV) {
    const g = globalThis as Record<string, unknown>
    g.__atTrystero = {
      room,
      selfId: mod.selfId,
      roomCode,
      strategy,
      getRelaySockets: (mod as unknown as { getRelaySockets?: () => unknown }).getRelaySockets,
    }
  }

  return {
    selfId: mod.selfId,
    kind: 'trystero',
    send: (msg: Wire, to?: string) => {
      void action.send(msg, to ? { target: to } : undefined).catch((err: Error) => {
        handlers.onStatus('failed', String(err?.message ?? err))
      })
    },
    getPeers: () => Object.keys(room.getPeers()),
    leave: async () => {
      if (relayTimer) clearInterval(relayTimer)
      relayTimer = null
      await leaveRoom()
      handlers.onStatus('closed')
    },
  }
}
