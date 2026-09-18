import { describe, expect, it } from 'vitest'
import { resolveIdentity, roomCodeFromUrl } from '../../src/app/identity'
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
})
