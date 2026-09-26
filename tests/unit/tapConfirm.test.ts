import { describe, expect, it } from 'vitest'
import { EMPTY_TAP_STATE, TAP_CONFIRM_WINDOW_MS, nextTapState } from '../../src/ui/tapConfirm'

describe('移动端双击确认', () => {
  it('桌面端（无需确认）直接执行', () => {
    const r = nextTapState(EMPTY_TAP_STATE, 'move:3,4', 1000, false)
    expect(r.execute).toBe(true)
    expect(r.state.pendingKey).toBeNull()
  })

  it('触屏：第一次点只标记，第二次点同一格才执行', () => {
    const first = nextTapState(EMPTY_TAP_STATE, 'move:3,4', 1000, true)
    expect(first.execute).toBe(false)
    expect(first.state.pendingKey).toBe('move:3,4')

    const second = nextTapState(first.state, 'move:3,4', 1500, true)
    expect(second.execute).toBe(true)
    expect(second.state.pendingKey).toBeNull()
  })

  it('触屏：超过确认窗口需要重新点两次', () => {
    const first = nextTapState(EMPTY_TAP_STATE, 'move:3,4', 1000, true)
    const late = nextTapState(first.state, 'move:3,4', 1000 + TAP_CONFIRM_WINDOW_MS + 1, true)
    expect(late.execute).toBe(false)
    expect(late.state.pendingKey).toBe('move:3,4')
  })

  it('触屏：点别处 = 改选目标，不会误执行', () => {
    const first = nextTapState(EMPTY_TAP_STATE, 'move:3,4', 1000, true)
    const other = nextTapState(first.state, 'attack:5,5', 1200, true)
    expect(other.execute).toBe(false)
    expect(other.state.pendingKey).toBe('attack:5,5')
  })
})
