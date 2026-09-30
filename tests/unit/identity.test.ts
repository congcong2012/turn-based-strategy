import { afterEach, describe, expect, it } from 'vitest'
import {
  clearLastRoom,
  readLastRoom,
  readLastRoomPassword,
  resolveIdentity,
  roomCodeFromUrl,
  roomPasswordFromUrl,
  writeLastRoom,
} from '../../src/app/identity'
import type { StorageLike } from '../../src/app/identity'

function memoryStorage(seed: Record<string, string> = {}): StorageLike {
  const data = new Map(Object.entries(seed))
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  }
}

describe('玩家身份', () => {
  it('首次进入生成 playerId，昵称有默认值', () => {
    const identity = resolveIdentity({ search: '', dev: false, storage: memoryStorage() })
    expect(identity.playerId).toMatch(/\S+/)
    expect(identity.nickname.startsWith('将军·')).toBe(true)
    expect(identity.ephemeral).toBe(false)
  })

  it('复用 localStorage 中的身份（刷新后仍是同一个玩家）', () => {
    const storage = memoryStorage({
      'ancient-tactics.playerId': 'pid-123',
      'ancient-tactics.nickname': '老将军',
    })
    const identity = resolveIdentity({ search: '', dev: false, storage })
    expect(identity.playerId).toBe('pid-123')
    expect(identity.nickname).toBe('老将军')
  })

  it('DEV 下 ?as= 覆盖身份且不落盘', () => {
    const storage = memoryStorage()
    const identity = resolveIdentity({ search: '?as=p1&nick=%E7%94%B2', dev: true, storage })
    expect(identity.playerId).toBe('p1')
    expect(identity.nickname).toBe('甲')
    expect(identity.ephemeral).toBe(true)
  })

  it('生产构建忽略 ?as=', () => {
    const identity = resolveIdentity({ search: '?as=p1', dev: false, storage: memoryStorage() })
    expect(identity.playerId).not.toBe('p1')
    expect(identity.ephemeral).toBe(false)
  })

  it('从 URL 读取房间码', () => {
    expect(roomCodeFromUrl('?room=ab23cd')).toBe('AB23CD')
    expect(roomCodeFromUrl('?foo=1')).toBeNull()
    expect(roomCodeFromUrl('?room=zzz')).toBe('ZZZ')
  })

  it('从 URL 读取房间密码（?key=）', () => {
    expect(roomPasswordFromUrl('?room=AB23CD&key=tea')).toBe('tea')
    expect(roomPasswordFromUrl('?key=%20%20')).toBeNull()
    expect(roomPasswordFromUrl('?room=AB23CD')).toBeNull()
    expect(roomPasswordFromUrl('?key=' + 'x'.repeat(200))?.length).toBe(64)
  })
})

/** sessionStorage 在 node 测试环境里不存在，这里注入一个假的 */
function fakeSessionStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    size: () => data.size,
  }
}

describe('本标签页房间记忆（刷新自动回到原房间）', () => {
  afterEach(() => {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage
  })

  it('记住房间码；带密码时把密码一起记住（密码参与连接密钥派生，刷新后必须复用）', () => {
    const store = fakeSessionStorage()
    ;(globalThis as { sessionStorage?: unknown }).sessionStorage = store

    writeLastRoom('AB23CD', 'tea-2024')
    expect(readLastRoom()).toBe('AB23CD')
    expect(readLastRoomPassword()).toBe('tea-2024')

    // 无密码房间：不能残留上一个房间的密码
    writeLastRoom('ZZ99ZZ')
    expect(readLastRoomPassword()).toBeNull()

    writeLastRoom('ZZ99ZZ', 'k')
    clearLastRoom()
    expect(readLastRoom()).toBeNull()
    expect(readLastRoomPassword()).toBeNull()
  })

  it('没有 sessionStorage（隐私模式/服务端）时静默降级，不抛异常', () => {
    expect(() => writeLastRoom('AB23CD', 'k')).not.toThrow()
    expect(readLastRoom()).toBeNull()
    expect(readLastRoomPassword()).toBeNull()
  })
})
