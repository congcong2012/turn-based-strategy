import { describe, expect, it } from 'vitest'
import { describeTransportError, isPasswordError } from '../../src/net/transportErrorText'

describe('传输层错误文案', () => {
  it('房间密码不一致 → 中文可执行提示，并标记为密码问题', () => {
    const raw = 'incorrect room password when decrypting offer'
    expect(isPasswordError(raw)).toBe(true)
    expect(describeTransportError(raw)).toContain('房间密码不一致')
    expect(describeTransportError(raw)).toContain('邀请链接')
  })

  it('翻译后的中文提示仍被识别为密码问题（UI 拿到的是译文）', () => {
    const translated = describeTransportError('incorrect room password when decrypting offer')
    expect(isPasswordError(translated)).toBe(true)
  })

  it('网络类错误给出对应建议，不当成密码问题', () => {
    expect(isPasswordError('ICE connection failed')).toBe(false)
    expect(describeTransportError('ICE connection failed')).toContain('直连建立失败')
    expect(describeTransportError('connection timeout')).toContain('超时')
  })

  it('未知错误原样返回（便于排查），空值有兜底文案', () => {
    expect(describeTransportError('boom from relay')).toBe('boom from relay')
    expect(describeTransportError('')).toContain('连接失败')
    expect(describeTransportError(null)).toContain('连接失败')
  })
})
