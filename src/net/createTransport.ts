/** 传输工厂：生产走 Trystero，DEV 下可用 ?transport=local 走同机 BroadcastChannel */

import { createLocalTransport } from './localTransport'
import { createTrysteroTransport } from './trysteroTransport'
import type { SignalStrategy, Transport, TransportFactory, TransportHandlers, TransportKind } from './types'

export interface CreateTransportOptions {
  kind: TransportKind
  strategy: SignalStrategy
  roomCode: string
  handlers: TransportHandlers
  /** 可选房间密码（手动直连不使用密码：它不经过信令） */
  password?: string
}

export async function createTransport(options: CreateTransportOptions): Promise<Transport> {
  if (options.kind === 'local') {
    return createLocalTransport({ roomCode: options.roomCode, handlers: options.handlers })
  }
  if (options.kind === 'manual') {
    throw new Error('手动直连请通过 startManualPairing 建立（需要两步交换连接码）')
  }
  return createTrysteroTransport({
    roomCode: options.roomCode,
    strategy: options.strategy,
    handlers: options.handlers,
    password: options.password,
  })
}

/** 给 session 用的工厂包装 */
export function transportFactoryFor(
  kind: TransportKind,
  strategy: SignalStrategy,
  roomCode: string,
): TransportFactory {
  return (handlers: TransportHandlers, password?: string | null) =>
    createTransport({ kind, strategy, roomCode, handlers, password: password ?? undefined })
}
