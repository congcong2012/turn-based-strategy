/**
 * AI 计算的跨线程协议。
 *
 * 边界特意切在 `nextCommand` 这一层：它本来就是**纯函数**
 * （入参只有 状态 / 玩家 / 难度 / 数据集 / 随机数），所以搬进 Worker 不会引入任何语义变化 ——
 * 这也正是"刷新后 AI 逐帧可复现"这条约束能被保住的原因：结果只取决于入参，与线程、时序无关。
 *
 * 两件事必须随请求一起送过去：
 *  1. **派生种子**（不是 rng 函数）：函数没法 structured-clone，而种子可以；
 *     Worker 侧用同一个 `mulberry32(seed)` 还原出与主线程逐位相同的随机序列。
 *  2. **地图**：自制地图只存在玩家浏览器里，Worker 里没有这份数据。
 */

import { DATA } from '../game/data'
import type { GameData, MapDef } from '../game/data'
import { nextCommand, nextCommandWith } from './index'
import type { AiProfile, Difficulty } from './profile'
import { mulberry32 } from './rng'
import type { Command, GameState, PlayerId } from '../game/types'

/** 一次"请 AI 出下一手"的任务（不含内部用的请求号） */
export interface AiTask {
  state: GameState
  playerId: PlayerId
  difficulty: Difficulty
  /** 与主线程 `aiRng()` 完全一致的派生种子 */
  seed: number
  /**
   * 当前地图。**每次请求都带上**（不做"只发一次"的缓存）：
   * 地图可能被玩家在编辑器里改过而 id 不变，缓存会悄悄用旧版本下棋 ——
   * 相比这个风险，几千字节的克隆成本可以忽略。
   */
  map: MapDef
  /**
   * 可选的**策略档案覆盖**（LLM 参谋用）。
   *
   * - **不传（undefined）**：完全等价于改造前 —— 走 `nextCommand`（按 `difficulty` 取档）；
   * - **传了**：走 `nextCommandWith`（用这份档案决策）。
   *
   * 之所以做成可选字段而不是"必传"：这样联机 AI 补位、评估台、既有单测全部零改动，
   * 且"未启用参谋 ⇒ 行为逐字不变"这条不变量在**协议层**也是成立的。
   *
   * ⚠️ `AiProfile` 是**纯数据**（数字 + 布尔 + 字符串数组），可安全 structured-clone；
   * 这也是它作为跨线程载荷的前提。
   */
  profile?: AiProfile
}

export interface AiRequest extends AiTask {
  id: number
}

export type AiResponse =
  | { id: number; ok: true; command: Command }
  | { id: number; ok: false; error: string }

/**
 * 造一份 Worker 自己的数据集。
 *
 * 刻意用**浅拷贝 + 独立 maps 副本**：Worker 是长生命周期对象，
 * 让它持有自己的表，就不会和主线程那份 `DATA` 相互影响（也不会污染同进程的单测）。
 */
export function createWorkerData(): GameData {
  return { ...DATA, maps: { ...DATA.maps } }
}

/**
 * 处理一次请求（纯函数：给定同样的 task 与 data，必然得到同样的指令）。
 *
 * 抽成独立函数是为了**单测能直接验证"Worker 里算出来的和主线程一模一样"**，
 * 而不必真的起一个线程。
 *
 * 两条分支：
 *  - `task.profile` 存在 → `nextCommandWith`（LLM 参谋给的覆盖档，主线程算出来的那份）；
 *  - 否则 → `nextCommand`（按难度取档，**与改造前逐字一致**）。
 *
 * 注意 `data.maps[task.map.id] = task.map` 这一步在两支之前：地图覆盖与走哪支无关。
 */
export function handleAiRequest(task: AiRequest, data: GameData): Command {
  data.maps[task.map.id] = task.map
  if (task.profile) {
    return nextCommandWith(task.state, task.playerId, task.profile, data, mulberry32(task.seed))
  }
  return nextCommand(task.state, task.playerId, task.difficulty, data, mulberry32(task.seed))
}
