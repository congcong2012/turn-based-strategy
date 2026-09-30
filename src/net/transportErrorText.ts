/**
 * 传输层错误文案（纯函数，可单测）
 *
 * 背景（v1.0.2）：Trystero 在房间密码不一致时会抛出英文错误
 *   "incorrect room password when decrypting offer"
 * 直接把英文丢给玩家毫无帮助，而且这个失败**不是信令问题**，不该引导玩家去切信令。
 * 这里把已知错误翻成中文可执行提示；未知错误原样返回（便于排查）。
 */

export function describeTransportError(raw: string | null | undefined): string {
  const text = (raw ?? '').trim()
  if (text.length === 0) return '连接失败（原因未知）'

  if (isPasswordError(text)) {
    return '房间密码不一致：请和房主核对密码（区分大小写），或直接用房主发来的邀请链接（链接里自带密码）'
  }
  if (/(ICE|DTLS|SCTP|datachannel)/i.test(text)) {
    return '直连建立失败（可能是网络或 NAT 限制）：可尝试切换信令，或改用手动直连'
  }
  if (/(timeout|ETIMEDOUT|unreachable)/i.test(text)) {
    return '连接超时：可切换信令策略，或改用手动直连（微信互发连接码）'
  }
  return text
}

/**
 * 该失败是否属于"房间密码"问题（用于避免给出"切换信令"这类误导建议）。
 * 同时认识英文原文与中文译文：UI 拿到的是已翻译的 detail。
 */
export function isPasswordError(raw: string | null | undefined): boolean {
  const text = raw ?? ''
  if (text.includes('房间密码')) return true
  if (/room password/i.test(text)) return true
  return /password/i.test(text) && /(decrypt|mismatch|incorrect|wrong)/i.test(text)
}
