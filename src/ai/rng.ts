/**
 * 确定性伪随机数发生器 —— **只服务于 AI 层**。
 *
 * 游戏内核（src/game/**）是零随机的（战斗完全确定），这是项目的架构原则之一：
 * 随机只允许出现在"表现层/决策层"，不允许进入规则。
 * 因此"简单"难度需要的随机性放在这里，并由 `PveConfig.seed` 决定，保证同种子可复现。
 */

/** mulberry32：小而快的 32 位 PRNG，返回 [0, 1) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 把任意若干片段散列成一个 32 位种子（FNV-1a） */
export function hashSeed(...parts: Array<string | number>): number {
  let h = 2166136261
  for (const part of parts) {
    const text = String(part)
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
  }
  return h >>> 0
}
