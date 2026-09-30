/** 极简路由：只用 query 与 hash（GitHub Pages 纯静态，不需要 404 兜底） */

import { useEffect, useState } from 'react'
import { normalizeRoomCode } from './roomCode'

export type Page = 'home' | 'lobby' | 'rules'

export interface Route {
  page: Page
  /** 邀请链接里的房间码（存在时直接进大厅） */
  roomCode: string | null
  /** 邀请链接里的房间密码 */
  roomKey: string | null
}

function keyFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get('key')
  if (!raw) return null
  const clean = raw.trim().slice(0, 64)
  return clean.length > 0 ? clean : null
}

/**
 * 解析规则（顺序很重要）：
 *  1. 带合法 ?room= → 直接进大厅（老邀请链接必须继续可用）
 *  2. #/rules 或 ?page=rules → 规则速查
 *  3. #/lobby 或 ?page=lobby → 大厅
 *  4. 其它（含空参数）→ 主页
 */
export function parseRoute(search: string, hash: string): Route {
  const params = new URLSearchParams(search)
  const roomRaw = params.get('room')
  const roomCode = roomRaw ? normalizeRoomCode(roomRaw) : null
  const roomKey = keyFromSearch(search)
  const hashPage = hash.replace(/^#\/?/, '').toLowerCase()
  const queryPage = (params.get('page') ?? '').toLowerCase()

  if (roomCode && roomCode.length === 6) return { page: 'lobby', roomCode, roomKey }
  if (hashPage === 'rules' || queryPage === 'rules') return { page: 'rules', roomCode: null, roomKey }
  if (hashPage === 'lobby' || queryPage === 'lobby') return { page: 'lobby', roomCode: null, roomKey }
  return { page: 'home', roomCode: null, roomKey }
}

/** 当前路由 + 切换（切换时写 hash，保证刷新/后退仍停在同一页） */
export function useRoute(): { route: Route; go: (page: Page) => void } {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.search, window.location.hash))

  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.search, window.location.hash))
    window.addEventListener('hashchange', onChange)
    window.addEventListener('popstate', onChange)
    return () => {
      window.removeEventListener('hashchange', onChange)
      window.removeEventListener('popstate', onChange)
    }
  }, [])

  const go = (page: Page) => {
    const next = '#/' + page
    if (window.location.hash !== next) window.location.hash = next
    else setRoute(parseRoute(window.location.search, window.location.hash))
    window.scrollTo({ top: 0 })
  }

  return { route, go }
}
