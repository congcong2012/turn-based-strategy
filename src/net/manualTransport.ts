/**
 * 手动交换 SDP 的点对点传输（AGENTS.md 要求的公共信令降级方案）
 *
 * 与 Trystero 传输实现同一个 Transport 接口，因此房间协议（hello/hostHello/lobby/game/cmd）
 * 完全复用；区别只是"如何交换 SDP"：不再依赖公共信令，而是把连接码通过微信/QQ 等带外渠道发过去。
 *
 * 流程：
 *   房主：创建邀请码 → 发给好友 → 好友回一个应答码 → 房主粘贴 → 通道建立
 *   好友：粘贴邀请码 → 生成应答码 → 发回房主
 *
 * 限制（会写在 UI 上）：仅支持 2 人；需要一次带外通信；无 TURN 时双方都在对称 NAT 后可能连不上。
 */

import type { PeerId, Transport, TransportHandlers, TransportStatus, Wire } from './types'

export type ManualRole = 'host' | 'guest'

const SIGNAL_PREFIX = 'AT1:'
/** 免费公共 STUN（无需注册/付费）；不配置 TURN */
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
const ICE_TIMEOUT_MS = 2500
const CONNECT_TIMEOUT_MS = 20000
export const MANUAL_PEER_ID: PeerId = 'manual-peer'

export type SignalPayload = { type: 'offer' | 'answer'; sdp: string }

/** 连接码编解码（纯函数，便于单测） */
export function encodeSignal(payload: SignalPayload): string {
  const json = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return SIGNAL_PREFIX + btoa(binary)
}

export function decodeSignal(code: string): SignalPayload {
  const cleaned = code.trim().replace(/\s+/g, '')
  if (!cleaned.startsWith(SIGNAL_PREFIX)) throw new Error('连接码格式不对（应以 ' + SIGNAL_PREFIX + ' 开头）')
  const base64 = cleaned.slice(SIGNAL_PREFIX.length)
  if (base64.length < 16) throw new Error('连接码内容不完整')
  let json: string
  try {
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    json = new TextDecoder().decode(bytes)
  } catch {
    throw new Error('连接码已损坏（无法解码），请重新复制完整内容')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('连接码已损坏（内容不是有效数据）')
  }
  const payload = parsed as Partial<SignalPayload>
  if ((payload.type !== 'offer' && payload.type !== 'answer') || typeof payload.sdp !== 'string' || payload.sdp.length < 20) {
    throw new Error('连接码缺少必要的会话描述')
  }
  return { type: payload.type, sdp: payload.sdp }
}

export interface ManualTransport extends Transport {
  readonly role: ManualRole
  /** 房主：生成邀请码 */
  createOfferCode: () => Promise<string>
  /** 好友：吃进邀请码并生成应答码 */
  acceptOfferCode: (code: string) => Promise<string>
  /** 房主：吃进应答码，完成连接 */
  acceptAnswerCode: (code: string) => Promise<void>
}

export interface ManualTransportOptions {
  role: ManualRole
  handlers: TransportHandlers
}

function waitForIce(pc: RTCPeerConnection, timeoutMs = ICE_TIMEOUT_MS): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', onChange)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer)
        done()
      }
    }
    pc.addEventListener('icegatheringstatechange', onChange)
  })
}

export function createManualTransport(options: ManualTransportOptions): ManualTransport {
  const { role, handlers } = options
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  let channel: RTCDataChannel | null = null
  let open = false
  let left = false
  let announced = false

  const status = (next: TransportStatus, detail?: string) => {
    if (!left) handlers.onStatus(next, detail)
  }

  const wireChannel = (dc: RTCDataChannel) => {
    channel = dc
    dc.onopen = () => {
      open = true
      status('connected')
      if (!announced) {
        announced = true
        handlers.onPeerJoin(MANUAL_PEER_ID)
      }
    }
    dc.onclose = () => {
      if (!open) return
      open = false
      handlers.onPeerLeave(MANUAL_PEER_ID)
      status('reconnecting', '直连通道已断开')
    }
    dc.onmessage = (event) => {
      try {
        handlers.onMessage(JSON.parse(String(event.data)) as Wire, MANUAL_PEER_ID)
      } catch {
        status('failed', '收到无法解析的数据')
      }
    }
  }

  pc.onconnectionstatechange = () => {
    if (left) return
    if (pc.connectionState === 'connected') status('connected')
    else if (pc.connectionState === 'failed') status('failed', '直连失败：双方网络可能都在对称 NAT 之后（家用网络一般可用）')
    else if (pc.connectionState === 'disconnected') status('reconnecting', '直连中断，正在尝试恢复')
  }

  if (role === 'host') {
    wireChannel(pc.createDataChannel('wire', { ordered: true }))
  } else {
    pc.ondatachannel = (event) => wireChannel(event.channel)
  }

  const waitForOpen = () =>
    new Promise<void>((resolve) => {
      if (open) return resolve()
      const timer = setTimeout(() => {
        status('failed', '连接超时：请确认两边都粘贴了正确的连接码')
        resolve()
      }, CONNECT_TIMEOUT_MS)
      const check = setInterval(() => {
        if (open) {
          clearInterval(check)
          clearTimeout(timer)
          resolve()
        }
      }, 200)
    })

  status('connecting')

  return {
    role,
    selfId: role === 'host' ? 'manual-host' : 'manual-guest',
    kind: 'manual',
    getPeers: () => (open ? [MANUAL_PEER_ID] : []),
    send: (msg: Wire) => {
      if (!channel || !open) return
      try {
        channel.send(JSON.stringify(msg))
      } catch (err) {
        status('failed', '发送失败：' + String((err as Error)?.message ?? err))
      }
    },
    leave: async () => {
      left = true
      open = false
      try {
        channel?.close()
      } catch {
        /* ignore */
      }
      pc.close()
      handlers.onStatus('closed')
    },

    async createOfferCode() {
      if (role !== 'host') throw new Error('只有房主能生成邀请码')
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await waitForIce(pc)
      const sdp = pc.localDescription?.sdp
      if (!sdp) throw new Error('生成邀请码失败')
      return encodeSignal({ type: 'offer', sdp })
    },

    async acceptOfferCode(code: string) {
      if (role !== 'guest') throw new Error('只有加入方需要粘贴邀请码')
      const payload = decodeSignal(code)
      if (payload.type !== 'offer') throw new Error('这看起来是应答码，请粘贴房主发来的邀请码')
      await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp })
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      await waitForIce(pc)
      const sdp = pc.localDescription?.sdp
      if (!sdp) throw new Error('生成应答码失败')
      return encodeSignal({ type: 'answer', sdp })
    },

    async acceptAnswerCode(code: string) {
      if (role !== 'host') throw new Error('只有房主需要粘贴应答码')
      const payload = decodeSignal(code)
      if (payload.type !== 'answer') throw new Error('这看起来是邀请码，请粘贴好友回传的应答码')
      await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
      await waitForOpen()
    },
  }
}
