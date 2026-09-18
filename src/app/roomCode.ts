/** 房间码规则：6 位，剔除 I/O/0/1 等易混字符 */

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_LENGTH = 6

/**
 * 归一化房间码：转大写 → 移除非字母表字符 → 截断到 6 位。
 * 输入 abc-def / abc123 等都能得到可用结果。
 */
export function normalizeRoomCode(raw: string): string {
  const upper = String(raw ?? '').toUpperCase()
  let out = ''
  for (const ch of upper) {
    if (out.length >= ROOM_CODE_LENGTH) break
    if (ROOM_CODE_ALPHABET.includes(ch)) out += ch
  }
  return out
}

export function isValidRoomCode(code: string): boolean {
  return code.length === ROOM_CODE_LENGTH && normalizeRoomCode(code) === code
}

export function randomRoomCode(rand: () => number = Math.random): string {
  const len = ROOM_CODE_ALPHABET.length
  let out = ''
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    const idx = Math.min(len - 1, Math.max(0, Math.floor(rand() * len)))
    out += ROOM_CODE_ALPHABET[idx]
  }
  return out
}
