/**
 * AI Worker 的**客户端**：把"请 AI 出下一手"发到后台线程，并在任何异常情况下退化为**主线程计算**。
 *
 * 设计要点：
 *  1. **失败一定可用**：Worker 起不来 / 抛错 / 半路挂掉，都改为在主线程用**同样的入参**重算。
 *     因为 `nextCommand` 是纯函数，两条路径的**结果完全一致**，所以回退不会改变棋局，
 *     只是把耗时搬回主线程而已。
 *  2. **没有 Worker 时同步返回**：这样调用方（以及大量既有单测）的同步假设不受影响，
 *     只有真的起了 Worker 才会走 Promise 分支。
 *  3. **可注入工厂**：单测可以塞一个假的 Worker 来验证"挂掉之后的行为"，
 *     不必真的起线程（vitest 是 node 环境，没有 Worker）。
 */

import type { Command } from '../game/types'
import { handleAiRequest } from './workerProtocol'
import type { AiTask, AiRequest, AiResponse } from './workerProtocol'
import { createWorkerData } from './workerProtocol'

export interface AiWorkerClient {
  /** 要下一条指令。没有可用 Worker 时**同步返回**，否则返回 Promise */
  think: (task: AiTask) => Command | Promise<Command>
  /** 当前是否真的跑在 Worker 里（false = 已退化为主线程） */
  usingWorker: () => boolean
  dispose: () => void
}

export interface AiWorkerClientOptions {
  /** 注入点：默认起真 Worker；单测用它模拟"起不来"或"起了就报错" */
  createWorker?: () => Worker
  /** 退化到主线程时回调一次（便于打日志/上报，别在 UI 里弹错） */
  onFallback?: (reason: string) => void
}

interface Waiting {
  task: AiTask
  resolve: (command: Command) => void
}

/** 默认实现：交给打包器处理（Vite 会把 workerEntry 单独打成一个 chunk，并按 base 生成正确的 URL） */
function defaultCreateWorker(): Worker {
  return new Worker(new URL('./workerEntry.ts', import.meta.url), { type: 'module' })
}

export function createAiWorkerClient(options: AiWorkerClientOptions = {}): AiWorkerClient {
  // 主线程自己的数据集（回退路径用），同样与全局 DATA 隔离
  const fallbackData = createWorkerData()

  let worker: Worker | null = null
  let broken = false
  let seq = 0
  const waiting = new Map<number, Waiting>()

  const computeOnMainThread = (task: AiTask): Command =>
    handleAiRequest({ ...task, id: -1 }, fallbackData)

  const reportFallback = (reason: string): void => {
    if (!broken) options.onFallback?.(reason)
    broken = true
  }

  /** Worker 挂了：它算不出来的请求，全部在主线程按同样入参补算 */
  const drainToMainThread = (reason: string): void => {
    reportFallback(reason)
    for (const [id, entry] of waiting) {
      waiting.delete(id)
      entry.resolve(computeOnMainThread(entry.task))
    }
    try {
      worker?.terminate()
    } catch {
      /* ignore */
    }
    worker = null
  }

  // 懒启动：在线对战完全不碰它；只有真的要用 AI 时才起线程
  const ensureWorker = (): Worker | null => {
    if (broken) return null
    if (worker) return worker
    const factory = options.createWorker ?? (typeof Worker === 'undefined' ? null : defaultCreateWorker)
    if (!factory) {
      reportFallback('当前环境没有 Worker')
      return null
    }
    try {
      worker = factory()
    } catch (error) {
      reportFallback('创建 Worker 失败：' + (error instanceof Error ? error.message : String(error)))
      return null
    }
    worker.onmessage = (event: MessageEvent<AiResponse>) => {
      const response = event.data
      const entry = waiting.get(response.id)
      if (!entry) return
      waiting.delete(response.id)
      // Worker 内部出错（例如未知地图）→ 主线程同入参重算，行为不变
      entry.resolve(response.ok ? response.command : computeOnMainThread(entry.task))
    }
    worker.onerror = () => drainToMainThread('Worker 运行时错误')
    worker.onmessageerror = () => drainToMainThread('Worker 消息反序列化失败')
    return worker
  }

  const think = (task: AiTask): Command | Promise<Command> => {
    const active = ensureWorker()
    if (!active) return computeOnMainThread(task)

    seq += 1
    const id = seq
    return new Promise<Command>((resolve) => {
      waiting.set(id, { task, resolve })
      const request: AiRequest = { ...task, id }
      try {
        active.postMessage(request)
      } catch (error) {
        drainToMainThread('发送请求失败：' + (error instanceof Error ? error.message : String(error)))
      }
    })
  }

  return {
    think,
    usingWorker: () => worker !== null && !broken,
    dispose: () => {
      waiting.clear()
      try {
        worker?.terminate()
      } catch {
        /* ignore */
      }
      worker = null
    },
  }
}
