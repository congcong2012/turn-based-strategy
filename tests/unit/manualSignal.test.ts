import { describe, expect, it } from 'vitest'
import { decodeSignal, encodeSignal } from '../../src/net/manualTransport'

describe('手动直连的连接码', () => {
  it('offer / answer 往返一致', () => {
    const offer = { type: 'offer' as const, sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\na=candidate:1 1 udp 1 1.2.3.4 5000 typ host' }
    const answer = { type: 'answer' as const, sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-' }
    expect(decodeSignal(encodeSignal(offer))).toEqual(offer)
    expect(decodeSignal(encodeSignal(answer))).toEqual(answer)
  })

  it('容错：粘贴时带换行/空格也能解析', () => {
    const code = encodeSignal({ type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1' })
    const messy = '  ' + code.slice(0, 10) + '\n' + code.slice(10, 20) + '  ' + code.slice(20) + '\n'
    expect(decodeSignal(messy).type).toBe('offer')
  })

  it('拒绝非法输入并给出可读原因', () => {
    expect(() => decodeSignal('hello world')).toThrow(/格式不对/)
    expect(() => decodeSignal('AT1:')).toThrow(/不完整/)
    expect(() => decodeSignal('AT1:!!!!not-base64!!!!')).toThrow(/损坏|格式/)
    const brokenJson = encodeSignal({ type: 'offer', sdp: 'x'.repeat(30) }).slice(0, 8)
    expect(() => decodeSignal(brokenJson)).toThrow()
    // 类型不对
    const bad = btoa(JSON.stringify({ type: 'nope', sdp: 'y'.repeat(40) }))
    expect(() => decodeSignal('AT1:' + bad)).toThrow(/会话描述/)
  })

  it('连接码是纯 ASCII，方便通过微信/短信传递（含中文也能正确往返）', () => {
    const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\na=note:中文备注\r\na=mid:0\r\n'
    const code = encodeSignal({ type: 'offer', sdp })
    expect(code.startsWith('AT1:')).toBe(true)
    expect(/^[\x20-\x7e]+$/.test(code)).toBe(true)
    expect(decodeSignal(code).sdp).toContain('中文备注')
  })
})
