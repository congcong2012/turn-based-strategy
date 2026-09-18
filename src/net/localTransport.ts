/**
 * 本地调试传输：用 BroadcastChannel 在同一台机器的多个标签页之间通信。
 * 用途：无网络时调试大厅 UI、以及不需要公网信令的自动化测试。
 * 生产构建不会启用（由 import.meta.env.DEV 把关）。
 */

import type { PeerId, Transport, TransportHandlers, Wire } from './types'

const PEER_TIMEOUT_MS = 3500
const PING_INTERVAL_MS = 1000

type Envelope =
  | { k: 'join'; from: PeerId }
  | { k: 'present'; from: PeerId }
  | { k: 'ping'; from: PeerId }
  | { k: 'bye'; from: PeerId }
  | { k: 'msg'; from: PeerId; to?: PeerId; data: Wire }

export interface LocalTransportOptions {
  roomCode: string
  handlers: TransportHandlers
  selfId?: string
}

export function createLocalTransport(options: LocalTransportOptions): Transport {
  const { roomCode, handlers } = options
  const selfId = options.selfId ?? 'local-' + Math.random().toString(36).slice(2, 10)
  const peers = new Map<PeerId, number>()
  let channel: BroadcastChannel | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null

  const post = (env: Envelope): void => {
    channel?.postMessage(env)
  }

  const touch = (peerId: PeerId): void => {
    if (peerId === selfId) return
    const known = peers.has(peerId)
    peers.set(peerId, Date.now())
    if (!known) handlers.onPeerJoin(peerId)
  }

  const drop = (peerId: PeerId): void => {
    if (!peers.delete(peerId)) return
    handlers.onPeerLeave(peerId)
  }

  const sweep = (): void => {
    const now = Date.now()
    for (const [peerId, lastSeen] of peers) {
      if (now - lastSeen > PEER_TIMEOUT_MS) drop(peerId)
    }
  }

  const onChannelMessage = (event: MessageEvent<Envelope>): void => {
    const env = event.data
    if (!env || env.from === selfId) return
    switch (env.k) {
      case 'join':
        touch(env.from)
        post({ k: 'present', from: selfId })
        break
      case 'present':
      case 'ping':
        touch(env.from)
        break
      case 'bye':
        drop(env.from)
        break
      case 'msg':
        touch(env.from)
        if (!env.to || env.to === selfId) handlers.onMessage(env.data, env.from)
        break
    }
  }

  const sendBye = (): void => post({ k: 'bye', from: selfId })

  channel = new BroadcastChannel('ancient-tactics::' + roomCode)
  channel.onmessage = onChannelMessage
  if (typeof window !== 'undefined') window.addEventListener('pagehide', sendBye)

  post({ k: 'join', from: selfId })
  pingTimer = setInterval(() => {
    post({ k: 'ping', from: selfId })
    sweep()
  }, PING_INTERVAL_MS)

  handlers.onStatus('connected')

  return {
    selfId,
    kind: 'local',
    send: (msg: Wire, to?: PeerId) => post({ k: 'msg', from: selfId, to, data: msg }),
    getPeers: () => [...peers.keys()],
    leave: async () => {
      sendBye()
      if (pingTimer) clearInterval(pingTimer)
      pingTimer = null
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', sendBye)
      channel?.close()
      channel = null
      peers.clear()
      handlers.onStatus('closed')
    },
  }
}
