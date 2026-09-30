/** 测试用内存传输：模拟多个 peer 通过一个 hub 互联，可暂停投递以复现竞态 */

import type { PeerId, Transport, TransportFactory, TransportHandlers, Wire } from '../../../src/net/types'

export interface MemoryHubOptions {
  /**
   * 静默加入：新传输**不**触发任何 onPeerJoin（双向）。
   * 用来复现"会话继承了一个已建连的房间"：刷新页面时新会话可能直接复用旧 room，
   * 两端都不会再收到 peerJoin 事件。
   */
  silent?: boolean
}

export interface MemoryHub {
  createFactory: (options?: MemoryHubOptions) => TransportFactory
  peerIds: () => PeerId[]
  disconnect: (peerId: PeerId) => void
  pause: () => void
  resume: () => void
}

export function createMemoryHub(): MemoryHub {
  const live = new Map<PeerId, TransportHandlers>()
  let counter = 0
  let paused = false
  const queue: Array<() => void> = []

  const deliver = (fn: () => void): void => {
    if (paused) queue.push(fn)
    else fn()
  }

  const createFactory = (options: MemoryHubOptions = {}): TransportFactory => {
    return async (handlers: TransportHandlers): Promise<Transport> => {
      counter += 1
      const selfId: PeerId = 'peer-' + counter
      let left = false
      live.set(selfId, handlers)

      if (!options.silent) {
        const others = [...live.keys()].filter((id) => id !== selfId)
        for (const id of others) deliver(() => live.get(id)?.onPeerJoin(selfId))
      }

      return {
        selfId,
        kind: 'local',
        send: (msg: Wire, to?: PeerId) => {
          if (left) return
          const targets = to ? [to] : [...live.keys()].filter((id) => id !== selfId)
          for (const target of targets) {
            deliver(() => live.get(target)?.onMessage(msg, selfId))
          }
        },
        getPeers: () => [...live.keys()].filter((id) => id !== selfId),
        leave: async () => {
          left = true
          live.delete(selfId)
          for (const id of [...live.keys()]) deliver(() => live.get(id)?.onPeerLeave(selfId))
        },
      }
    }
  }

  return {
    createFactory,
    peerIds: () => [...live.keys()],
    disconnect: (peerId: PeerId) => {
      live.delete(peerId)
      for (const id of [...live.keys()]) deliver(() => live.get(id)?.onPeerLeave(peerId))
    },
    pause: () => {
      paused = true
    },
    resume: () => {
      paused = false
      while (queue.length > 0) queue.shift()?.()
    },
  }
}
