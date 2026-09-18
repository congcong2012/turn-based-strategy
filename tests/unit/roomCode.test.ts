import { describe, expect, it } from 'vitest'
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  isValidRoomCode,
  normalizeRoomCode,
  randomRoomCode,
} from '../../src/app/roomCode'

describe('房间码', () => {
  it('归一化：转大写并剔除不在字母表内的字符', () => {
    expect(normalizeRoomCode('ab23cd')).toBe('AB23CD')
    expect(normalizeRoomCode('abc-123')).toBe('ABC23')
    expect(normalizeRoomCode('  xy  z9 ')).toBe('XYZ9')
  })

  it('剔除易混字符 I / O / 0 / 1', () => {
    // i、o、0、1 都非法；l 合法（保留 L）
    expect(normalizeRoomCode('il0o1')).toBe('L')
  })

  it('长度截断为 6 位', () => {
    expect(normalizeRoomCode('abcdefghij')).toBe('ABCDEF')
  })

  it('校验只接受已归一化的 6 位码', () => {
    expect(isValidRoomCode('ABC23D')).toBe(true)
    expect(isValidRoomCode('abc23d')).toBe(false)
    expect(isValidRoomCode('ABC23')).toBe(false)
    expect(isValidRoomCode('')).toBe(false)
  })

  it('随机生成：长度正确、字符全部合法、可按随机源复现', () => {
    const code = randomRoomCode()
    expect(code).toHaveLength(ROOM_CODE_LENGTH)
    for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch)

    const fixed = randomRoomCode(() => 0)
    expect(fixed).toBe(ROOM_CODE_ALPHABET[0].repeat(ROOM_CODE_LENGTH))

    const high = randomRoomCode(() => 0.999999)
    expect(isValidRoomCode(high)).toBe(true)
  })
})
