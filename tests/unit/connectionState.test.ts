import { describe, expect, it } from 'vitest'
import { deriveConnectionState, recoveryHint } from '../../src/net/connectionState'

const base = { detail: null, peerCount: 0, expectedPlayers: 1, inGame: false }

describe('连接状态推导', () => {
  it('未进房 / 连接中 / 失败', () => {
    expect(deriveConnectionState({ ...base, role: 'idle', status: 'idle' })).toBe('idle')
    expect(deriveConnectionState({ ...base, role: 'joining', status: 'idle' })).toBe('connecting')
    expect(deriveConnectionState({ ...base, role: 'host', status: 'connecting' })).toBe('connecting')
    expect(deriveConnectionState({ ...base, role: 'host', status: 'failed' })).toBe('failed')
  })

  it('有 peer = 已连接（优先于其它判断）', () => {
    expect(deriveConnectionState({ ...base, role: 'host', status: 'connected', peerCount: 2 })).toBe('connected')
    expect(deriveConnectionState({ ...base, role: 'client', status: 'reconnecting', peerCount: 1 })).toBe('connected')
  })

  it('没有 peer：对局中或名单里还有人 = 重连中；否则 = 等待对手', () => {
    expect(deriveConnectionState({ ...base, role: 'host', status: 'connected', expectedPlayers: 1 })).toBe('waiting')
    expect(deriveConnectionState({ ...base, role: 'host', status: 'connected', expectedPlayers: 2 })).toBe('reconnecting')
    expect(deriveConnectionState({ ...base, role: 'client', status: 'connected', inGame: true })).toBe('reconnecting')
    expect(deriveConnectionState({ ...base, role: 'client', status: 'reconnecting', inGame: true })).toBe('reconnecting')
  })

  it('失败/重连时给出下一步建议', () => {
    expect(recoveryHint('failed', 'mqtt')).toContain('手动直连')
    expect(recoveryHint('failed', 'torrent')).toContain('MQTT')
    expect(recoveryHint('reconnecting', 'mqtt')).toContain('重连')
    expect(recoveryHint('connected', 'mqtt')).toBeNull()
    expect(recoveryHint('waiting', 'mqtt')).toBeNull()
  })

  it('房间密码问题给密码建议，不误导玩家去切信令', () => {
    const hint = recoveryHint('failed', 'mqtt', 'incorrect room password when decrypting offer')
    expect(hint).toContain('房间密码不一致')
    expect(hint).not.toContain('Torrent')
    expect(hint).not.toContain('信令')
  })
})
