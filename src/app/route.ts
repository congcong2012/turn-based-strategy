/** 极简路由：只用 query 与 hash（GitHub Pages 纯静态，不需要 404 兜底） */

import { useEffect, useState } from 'react'
import { normalizeRoomCode } from './roomCode'

export type Page = 'home' | 'lobby' | 'rules' | 'pve'

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

const PAGES: Page[] = ['home', 'lobby', 'rules', 'pve']

function asPage(raw: string): Page | null {
  const value = raw.toLowerCase()
  return (PAGES as string[]).includes(value) ? (value as Page) : null
}

/**
 * 解析规则（顺序很重要）：
 *  1. hash（#/home、#/lobby、#/rules）—— **点击导航的结果优先**。
 *     否则 `?page=lobby` 这类参数会永远压住"返回主页"，用户点了没反应。
 *  2. 带合法 ?room= → 直接进大厅（老邀请链接必须继续可用）
 *  3. ?page=rules / ?page=lobby
 *  4. 其它（含空参数）→ 主页
 */
export function parseRoute(search: string, hash: string): Route {
  const params = new URLSearchParams(search)
  const roomRaw = params.get('room')
  const roomCode = roomRaw ? normalizeRoomCode(roomRaw) : null
  const roomKey = keyFromSearch(search)

  const hashPage = asPage(hash.replace(/^#\/?/, ''))
  if (hashPage) return { page: hashPage, roomCode, roomKey }

  if (roomCode && roomCode.length === 6) return { page: 'lobby', roomCode, roomKey }

  const queryPage = asPage(params.get('page') ?? '')
  if (queryPage) return { page: queryPage, roomCode: null, roomKey }
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
    // 顺手把旧的 ?page= 参数清掉（保留 ?room= / ?key= 这些邀请信息），
    // 免得"链接里的旧参数"和这次点击打架，也让分享出去的地址更干净。
    const params = new URLSearchParams(window.location.search)
    if (params.has('page')) {
      params.delete('page')
      const search = params.toString()
      window.history.replaceState(null, '', window.location.pathname + (search ? '?' + search : '') + '#/' + page)
      setRoute(parseRoute(search ? '?' + search : '', '#/' + page))
    } else {
      const next = '#/' + page
      if (window.location.hash !== next) window.location.hash = next
      else setRoute(parseRoute(window.location.search, next))
    }
    window.scrollTo({ top: 0 })
  }

  return { route, go }
}
