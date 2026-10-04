/**
 * 房主选举（纯函数，可单测）
 *
 * 规则：
 *  1. 加入后广播 hello；若 3 秒内无人以 hostHello 应答 → 自己成为房主（"第一个加入者即房主"）。
 *  2. 收到 hostHello → 承认对方（第二个及以后加入者天然是客户端）。
 *  3. 双方几乎同时自任房主（竞态）→ 按"先加入者优先"（joinedAt）收敛，同刻用 playerId 字典序兜底。
 *     公共信令握手可能超过 3 秒，后加入者也会误自任房主；用加入时间裁决可保证
 *     "第一个进入房间的人成为房主"这一语义（实测线上就踩到过）。
 *  4. 房主掉线 → 等待 5 秒；仍未回来则由剩余玩家中最早加入者接管（**任何阶段都允许**）。
 *     大厅与对局中都接管：对局中新房主直接用自己内存里的局面继续（房主每执行一步都会全量广播，
 *     所以客户端手上那份就是最新的）。
 *  5. **房主权带任期号（epoch）**：每次接班 +1，冲突时**任期大的赢**，任期相同才退回"先加入者优先"。
 *     为什么必须有它：原房主回来时它的局面是**旧的**，若按"先加入者优先"让它夺回权威，
 *     它一广播就把整局**回滚**到掉线前。有了任期号，它听到新任期后会老实降级成普通玩家。
 */

import type { Phase } from '../net/types'

export const CLAIM_WAIT_MS = 3000
export const HOST_LOST_GRACE_MS = 5000

export interface PeerRecord {
  playerId: string
  nickname: string
  joinedAt: number
  connected: boolean
}

export interface ElectionState {
  selfId: string
  phase: Phase
  joinedAt: number
  hostId: string | null
  selfDeclared: boolean
  /**
   * 当前承认的房主任期号（0 = 还没有房主）。
   * 每次自任/接班都 +1；仲裁时**任期大的赢**（见文件头第 5 条）。
   */
  epoch: number
  /** 第一次发现房主掉线的时刻（用于宽限期计时） */
  hostLostAt: number | null
  records: Record<string, PeerRecord>
}

export type ElectionEffect =
  | { type: 'becameHost'; hostId: string }
  | { type: 'steppedDown'; hostId: string }
  | { type: 'broadcastHostHello'; hostId: string }

export interface ElectionResult {
  state: ElectionState
  effects: ElectionEffect[]
}

export function createElection(
  selfId: string,
  nickname: string,
  joinedAt: number,
  phase: Phase = 'LOBBY',
): ElectionState {
  return {
    selfId,
    phase,
    joinedAt,
    hostId: null,
    selfDeclared: false,
    epoch: 0,
    hostLostAt: null,
    records: { [selfId]: { playerId: selfId, nickname, joinedAt, connected: true } },
  }
}

export function setPhase(state: ElectionState, phase: Phase): ElectionState {
  return { ...state, phase }
}

export function isSelfHost(state: ElectionState): boolean {
  return state.hostId !== null && state.hostId === state.selfId
}

/** 剩余玩家中"最早加入"者（joinedAt 相同时按 playerId 字典序，保证各端算出同一结果） */
export function pickSuccessor(records: Record<string, PeerRecord>): string | null {
  const connected = Object.values(records).filter((r) => r.connected)
  if (connected.length === 0) return null
  connected.sort((a, b) => {
    if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt
    return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0
  })
  return connected[0].playerId
}

export function seen(state: ElectionState, rec: PeerRecord): ElectionResult {
  const records: Record<string, PeerRecord> = { ...state.records, [rec.playerId]: { ...rec, connected: true } }
  let next: ElectionState = { ...state, records }
  if (state.hostId !== null && state.hostId === rec.playerId) next = { ...next, hostLostAt: null }
  return { state: next, effects: [] }
}

/**
 * 竞态裁决：双方都自任房主时，谁该留下？
 * 规则 = 先加入者优先（joinedAt 更早），同一时刻再用 playerId 字典序兜底。
 * joinedAt 来自各自 hello 的复制值，因此两端算出的结果必然一致；
 * 时钟偏差只会选错赢家，不会造成两端不一致。
 *
 * 注意（v1.0.0 修的真实缺陷）：对方 joinedAt **优先取自 hostHello 消息本身**。
 * 原来只查 `records[otherId]`，而"对方的 hostHello 先于对方的 hello 到达"是常见情形
 * （刷新重连时尤其如此：新 peer 的 hostHello 立刻就到，hello 可能晚到几百毫秒），
 * 此时会退回字典序 → 双方都自认房主，且**再也不会重新裁决**：
 * 两边互相忽略对方的 lobby 快照，表现为"列表里只有自己"，卡死到刷新为止。
 */
function shouldKeepHostship(
  state: ElectionState,
  otherId: string,
  otherJoinedAt?: number | null,
  otherEpoch?: number | null,
): boolean {
  // ① 任期大的赢 —— 这条挡住了"带着旧局面的原房主夺回权威"。
  //    只有**双方都报了任期**才比较：对方是旧客户端（没带这个字段）时退回下面的 joinedAt 规则，
  //    否则新版客户端会凭"我有任期、你没有"把合法的旧房主顶掉。
  if (otherEpoch !== null && otherEpoch !== undefined && state.epoch !== otherEpoch) {
    return state.epoch > otherEpoch
  }

  // ② 同任期（典型：两人几乎同时自任房主）：沿用"先加入者优先"
  const mine = state.joinedAt
  const theirs = otherJoinedAt ?? state.records[otherId]?.joinedAt ?? null
  if (theirs === null || theirs === undefined) return state.selfId < otherId // 对方没给时间戳 → 退回字典序
  if (mine !== theirs) return mine < theirs
  return state.selfId < otherId
}

export function hostHello(
  state: ElectionState,
  hostId: string,
  hostJoinedAt?: number | null,
  hostEpoch?: number | null,
): ElectionResult {
  const theirEpoch = hostEpoch ?? 0

  if (state.hostId === hostId) {
    // 还是同一个房主：只在对方报了更高的任期时更新（罕见，但保持一致）
    return theirEpoch > state.epoch ? { state: { ...state, epoch: theirEpoch }, effects: [] } : { state, effects: [] }
  }

  // 竞态：我已声明在先，且按"任期 → 先加入者"该我当房主 → 保持并重申，让对方降级
  if (state.selfDeclared && shouldKeepHostship(state, hostId, hostJoinedAt, theirEpoch)) {
    return { state, effects: [{ type: 'broadcastHostHello', hostId: state.selfId }] }
  }

  const effects: ElectionEffect[] = []
  if (state.selfDeclared && hostId !== state.selfId) effects.push({ type: 'steppedDown', hostId })

  return {
    state: {
      ...state,
      hostId,
      selfDeclared: hostId === state.selfId,
      // 对方没报任期（老客户端）就沿用自己已知的，别把任期号清零
      epoch: theirEpoch > state.epoch ? theirEpoch : state.epoch,
      hostLostAt: null,
    },
    effects,
  }
}

export function gone(state: ElectionState, playerId: string): ElectionResult {
  const rec = state.records[playerId]
  if (!rec) return { state, effects: [] }
  const records: Record<string, PeerRecord> = { ...state.records, [playerId]: { ...rec, connected: false } }
  return { state: { ...state, records }, effects: [] }
}

/** 驱动计时器：由 session 周期性调用 */
export function tick(state: ElectionState, now: number): ElectionResult {
  const effects: ElectionEffect[] = []
  let next = state

  // 记录"第一次发现房主掉线"的时刻 / 房主回来后清除
  if (next.hostId !== null && next.hostId !== next.selfId) {
    const hostRec = next.records[next.hostId]
    if (hostRec && !hostRec.connected) {
      if (next.hostLostAt === null) next = { ...next, hostLostAt: now }
    } else if (next.hostLostAt !== null) {
      next = { ...next, hostLostAt: null }
    }
  }

  // 1) 无人应答 → 自任房主
  if (next.hostId === null && !next.selfDeclared && now - next.joinedAt >= CLAIM_WAIT_MS) {
    next = { ...next, hostId: next.selfId, selfDeclared: true, epoch: next.epoch + 1, hostLostAt: null }
    effects.push({ type: 'becameHost', hostId: next.selfId })
    effects.push({ type: 'broadcastHostHello', hostId: next.selfId })
    return { state: next, effects }
  }

  // 2) 房主掉线超过宽限期 → 最早的剩余玩家接管（**大厅与对局都允许**）
  const hostRec = next.hostId ? next.records[next.hostId] : undefined
  if (
    next.hostId !== null &&
    next.hostId !== next.selfId &&
    hostRec !== undefined &&
    !hostRec.connected &&
    next.hostLostAt !== null &&
    now - next.hostLostAt >= HOST_LOST_GRACE_MS
  ) {
    if (pickSuccessor(next.records) === next.selfId && !next.selfDeclared) {
      next = { ...next, hostId: next.selfId, selfDeclared: true, epoch: next.epoch + 1, hostLostAt: null }
      effects.push({ type: 'becameHost', hostId: next.selfId })
      effects.push({ type: 'broadcastHostHello', hostId: next.selfId })
    }
  }

  return { state: next, effects }
}
