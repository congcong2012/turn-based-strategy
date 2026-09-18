/** 传输工厂：生产走 Trystero，DEV 下可用 ?transport=local 走同机 BroadcastChannel */

import { createLocalTransport } from './localTransport'
import { createTrysteroTransport } from './trysteroTransport'
import type { SignalStrategy, Transport, TransportFactory, TransportHandlers, TransportKind } from './types'

export interface CreateTransportOptions {
  kind: TransportKind
  strategy: SignalStrategy
  roomCode: string
  handlers: TransportHandlers
}

export async function createTransport(options: CreateTransportOptions): Promise<Transport> {
  if (options.kind === 'local') {
    return createLocalTransport({ roomCode: options.roomCode, handlers: options.handlers })
  }
  return createTrysteroTransport({
    roomCode: options.roomCode,
    strategy: options.strategy,
    handlers: options.handlers,
  })
}

/** 给 session 用的工厂包装 */
export function transportFactoryFor(
  kind: TransportKind,
  strategy: SignalStrategy,
  roomCode: string,
): TransportFactory {
  return (handlers: TransportHandlers) => createTransport({ kind, strategy, roomCode, handlers })
}
