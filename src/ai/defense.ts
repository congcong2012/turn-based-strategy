/**
 * 守土警报：**己方据点门口出现敌军**时，把"回防"这件事变成一个有分的动作。
 *
 * ## 为什么需要它（真实缺陷）
 *
 * 原来只有 `evaluate` 里的 `defend` 项会在**敌方已经产生占领进度**时扣分。
 * 但 `hard` 档的流程是「按启发式取前 K 名 → 再对前 K 名做一步前瞻」——
 * 一个在中场、附近没有敌人的单位，"往回走"在启发式里是 0 分，**根本进不了候选池**，
 * 于是评估器再着急也选不到它。
 *
 * 表现就是玩家看到的：兵都挤在地图中间攻敌人，老家被贴脸了也不回头。
 *
 * ## 判据（刻意很窄）
 *
 * 只对**兵营与王城**、且敌兵已经逼到门口时报警：
 *  - 王城：敌兵在 2 格内（1 格可下回合开始占领，2 格是"下下回合"，都要管）；
 *  - 兵营：敌兵贴脸（1 格）；
 *  - 村落：不报 —— 丢一个村不值得全军回头。
 *
 * 敌方**正在占领**时权重最高（`closeness = 3`），因为那时只剩一两回合。
 *
 * 权重单位与 `heuristics` 的其他项一致（"每靠近一格得多少分"），
 * 40 × 重要度 × 紧迫度：王城被贴脸 ≈ 480/格，显著压过"抢一个中立村落 +60"。
 */

import { chebyshevDistance } from '../game/movement'
import { isAllyOwner } from '../game/teams'
import type { GameState, PlayerId } from '../game/types'

export interface DefenseAlarm {
  /** 被威胁的据点位置 */
  at: { x: number; y: number }
  /** 每靠近一格的分值（越小越远） */
  weight: number
  /** 是否已经在被占领（用于日志与更强的紧迫度） */
  capturing: boolean
}

export function defenseAlarm(state: GameState, playerId: PlayerId): DefenseAlarm | null {
  let best: DefenseAlarm | null = null

  for (const building of state.buildings) {
    if (!isAllyOwner(state, playerId, building.owner)) continue
    if (building.type === 'village') continue

    let nearest = Infinity
    for (const unit of state.units) {
      if (isAllyOwner(state, playerId, unit.owner)) continue
      nearest = Math.min(nearest, chebyshevDistance(unit, building))
    }

    // 敌方正在踩着我方据点读条：不管远近都要管（那可能是最后两回合）
    const capturing = building.capture !== null && building.capture.points > 0 && !isAllyOwner(state, playerId, building.capture.playerId)
    const radius = building.type === 'hq' ? 2 : 1
    if (!capturing && nearest > radius) continue

    const importance = building.type === 'hq' ? 6 : 2
    const closeness = capturing ? 3 : Math.max(1, radius + 1 - nearest)
    const weight = importance * closeness * 40

    if (!best || weight > best.weight) {
      best = { at: { x: building.x, y: building.y }, weight, capturing }
    }
  }

  return best
}
