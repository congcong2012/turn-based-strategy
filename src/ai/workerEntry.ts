/**
 * AI Worker 的入口（`src/ai/workerClient.ts` 用 `new Worker(new URL('./workerEntry.ts', import.meta.url))` 拉起）。
 *
 * 这里只做三件事：收请求 → 算 → 回结果。**任何异常都必须转成 `ok:false` 回给主线程**，
 * 不能让它变成"没有回应的请求"，否则主线程会一直等下去（表现为 AI 回合卡住不动）。
 */

import { createWorkerData, handleAiRequest } from './workerProtocol'
import type { AiRequest, AiResponse } from './workerProtocol'

/** 只声明用到的成员：避免为了 `DedicatedWorkerGlobalScope` 去引 webworker lib（app 的 tsconfig 是 DOM 环境） */
interface WorkerScope {
  onmessage: ((event: MessageEvent<AiRequest>) => void) | null
  postMessage: (message: AiResponse) => void
}

const scope = self as unknown as WorkerScope

// 数据集在 Worker 里建一次、反复复用（地图每次请求都会被覆盖成最新的那份）
const data = createWorkerData()

scope.onmessage = (event) => {
  const request = event.data
  try {
    scope.postMessage({ id: request.id, ok: true, command: handleAiRequest(request, data) })
  } catch (error) {
    scope.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
