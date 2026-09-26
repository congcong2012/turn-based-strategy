/** 移动端"双击确认"状态机（纯函数，便于单测） */

export interface TapConfirmState {
  pendingKey: string | null
  at: number
}

export const EMPTY_TAP_STATE: TapConfirmState = { pendingKey: null, at: 0 }
/** 第一次点击后，多长时间内再点同一格才算确认 */
export const TAP_CONFIRM_WINDOW_MS = 6000

export function isTouchDevice(): boolean {
  try {
    return Boolean(globalThis.matchMedia?.('(pointer: coarse)').matches)
  } catch {
    return false
  }
}

/**
 * 处理一次点击：
 *  - 桌面（requireConfirm=false）：直接执行
 *  - 触屏：第一次点只"标记待确认"，在窗口期内再点同一格才执行；点别处则改标记
 */
export function nextTapState(
  prev: TapConfirmState,
  key: string,
  now: number,
  requireConfirm: boolean,
  windowMs = TAP_CONFIRM_WINDOW_MS,
): { state: TapConfirmState; execute: boolean } {
  if (!requireConfirm) return { state: EMPTY_TAP_STATE, execute: true }
  if (prev.pendingKey === key && now - prev.at <= windowMs) {
    return { state: EMPTY_TAP_STATE, execute: true }
  }
  return { state: { pendingKey: key, at: now }, execute: false }
}
