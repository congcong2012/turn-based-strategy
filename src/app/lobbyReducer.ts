/** 房主端权威房间名单的归约函数（纯函数，可单测） */

import type { LobbyPlayer, LobbySnapshot, Phase } from '../net/types'
import type { Difficulty } from '../ai'
import { DEEP_DIFFICULTY_MAX_PLAYERS, resolveDifficulty } from '../ai'

export const MAX_PLAYERS = 4

/**
 * 替真人行动的 AI（AI 补位 + 掉线托管）默认用哪一档：「普通」。
 * 不掉线的人既不该被更强的 AI 惩罚，也不该被白送 —— 房主可在大厅改。
 */
export const DEFAULT_AI_DIFFICULTY: Difficulty = 'normal'

export function createLobby(roomCode: string, hostId: string, phase: Phase = 'LOBBY'): LobbySnapshot {
  return recompute({
    roomCode,
    phase,
    hostId,
    players: [],
    maxPlayers: MAX_PLAYERS,
    canStart: false,
    mapId: null,
    /**
     * AI 补位：本局**总共几个席位**（含真人）。
     * 0 = 不补位；> 0 时不足的部分由 AI 坐（例如 2 人房想打四战之地 → 设 4，补 2 个 AI）。
     */
    aiSlotCount: 0,
    aiDifficulty: DEFAULT_AI_DIFFICULTY,
    teamMode: 'ffa',
    rev: 0,
  })
}

/** 房主选图（null = 自动） */
export function setMapId(lobby: LobbySnapshot, mapId: string | null): LobbySnapshot {
  return { ...lobby, mapId }
}

/**
 * 设置 AI 补位席位数（本局总共几个席位、含真人；0 = 不补位）。
 *
 * ⚠️ 必须在 reducer 里更新（而不是在 roomSession 里手写 `{ ...lobby, aiSlotCount }`）——
 * 快照是**整体替换**的，任何漏掉字段的地方都会把设置悄悄清掉。
 */
export function setAiSlotCount(lobby: LobbySnapshot, count: number): LobbySnapshot {
  const next = count <= 0 ? 0 : Math.min(MAX_PLAYERS, Math.max(2, Math.floor(count)))
  // ⚠️ 必须 recompute：2v2 的 canStart 取决于"席位是否凑满 4"，改补位会改变它
  return recompute(resolveLobbyAiDifficulty({ ...lobby, aiSlotCount: next }))
}

/**
 * 对局模式：混战 / 2v2。
 *
 * 2v2 需要**四个席位**（真人在座 + AI 补位凑满），所以切换后要重算 canStart ——
 * 房主可以先开 2v2 再拉人，人数不够时"开始"按钮应当是灰的，而不是开局后少一队。
 */
export function setTeamMode(lobby: LobbySnapshot, mode: 'ffa' | '2v2'): LobbySnapshot {
  return recompute({ ...lobby, teamMode: mode })
}

/** 房主选"替真人行动的 AI 用哪一档"（AI 补位 + 掉线托管共用） */
export function setAiDifficulty(lobby: LobbySnapshot, difficulty: Difficulty): LobbySnapshot {
  return resolveLobbyAiDifficulty({ ...lobby, aiDifficulty: difficulty })
}

/**
 * 把大厅里的 AI 档收敛到**本局实际可用**的档。
 *
 * 本局共几方 = `aiSlotCount > 0` 时按它算，否则按"真人数"算（不补位时就是真人对局）。
 * 唯一会被收敛的是「深推演」：它只在两人局成立（规则见 `src/ai/profile.ts`）。
 *
 * ⚠️ 这里只是**大厅侧**的收敛（玩家加进来/退出会改变人数，所以每次改设置都重算一次）；
 * 真正开局时 `roomSession` 还会按**实际**玩家数再收敛一次，两道保险。
 */
export function resolveLobbyAiDifficulty(lobby: LobbySnapshot): LobbySnapshot {
  const total = lobby.aiSlotCount > 0 ? lobby.aiSlotCount : connectedCount(lobby)
  const next = resolveDifficulty(lobby.aiDifficulty, total)
  return next === lobby.aiDifficulty ? lobby : { ...lobby, aiDifficulty: next }
}

/** 「深推演」在本大厅当前设定下是否可选（UI 用它决定禁用与说明） */
export function lobbyAllowsDeepAi(lobby: LobbySnapshot): boolean {
  const total = lobby.aiSlotCount > 0 ? lobby.aiSlotCount : connectedCount(lobby)
  return total <= DEEP_DIFFICULTY_MAX_PLAYERS
}

export function connectedCount(lobby: LobbySnapshot): number {
  // 观战者不占席位，所以不计入
  return lobby.players.filter((p) => p.connected && !p.spectator).length
}

/** 满员判定：只统计在线的玩家 */
export function isFull(lobby: LobbySnapshot): boolean {
  return connectedCount(lobby) >= lobby.maxPlayers
}

export function hasPlayer(lobby: LobbySnapshot, playerId: string): boolean {
  return lobby.players.some((p) => p.playerId === playerId)
}

export interface UpsertOptions {
  /** 重连（同一 playerId 换新连接）时把准备状态重置为未准备 */
  resetReady?: boolean
}

export function upsertPlayer(
  lobby: LobbySnapshot,
  player: { playerId: string; nickname: string; spectator?: boolean },
  options: UpsertOptions = {},
): LobbySnapshot {
  const existing = lobby.players.find((p) => p.playerId === player.playerId)
  let players: LobbyPlayer[]
  if (existing) {
    players = lobby.players.map((p) =>
      p.playerId === player.playerId
        ? {
            ...p,
            nickname: player.nickname || p.nickname,
            connected: true,
            ready: options.resetReady ? false : p.ready,
          }
        : p,
    )
  } else {
    players = [
      ...lobby.players,
      {
        playerId: player.playerId,
        nickname: player.nickname,
        // 观战者不参与"准备"：它不占席位，也不该阻塞开局
        ready: player.spectator === true,
        isHost: false,
        connected: true,
        spectator: player.spectator === true,
      },
    ]
  }
  return recompute({ ...lobby, players })
}

/** 对局进行中掉线：保留席位，只标记为离线（GDD 8.5） */
export function markDisconnected(lobby: LobbySnapshot, playerId: string): LobbySnapshot {
  const players = lobby.players.map((p) => (p.playerId === playerId ? { ...p, connected: false } : p))
  return recompute({ ...lobby, players })
}

export function markConnected(lobby: LobbySnapshot, playerId: string): LobbySnapshot {
  const players = lobby.players.map((p) => (p.playerId === playerId ? { ...p, connected: true } : p))
  return recompute({ ...lobby, players })
}

export function removePlayer(lobby: LobbySnapshot, playerId: string): LobbySnapshot {
  return recompute({ ...lobby, players: lobby.players.filter((p) => p.playerId !== playerId) })
}

export function setReady(lobby: LobbySnapshot, playerId: string, ready: boolean): LobbySnapshot {
  const players = lobby.players.map((p) => (p.playerId === playerId ? { ...p, ready } : p))
  return recompute({ ...lobby, players })
}

export function setNickname(lobby: LobbySnapshot, playerId: string, nickname: string): LobbySnapshot {
  const clean = nickname.trim().slice(0, 16) || '无名将军'
  const players = lobby.players.map((p) => (p.playerId === playerId ? { ...p, nickname: clean } : p))
  return recompute({ ...lobby, players })
}

export function setHostId(lobby: LobbySnapshot, hostId: string): LobbySnapshot {
  return recompute({ ...lobby, hostId })
}

export function setPhase(lobby: LobbySnapshot, phase: Phase): LobbySnapshot {
  return recompute({ ...lobby, phase })
}

/** 重算派生字段：isHost 与 canStart（≥2 名在线玩家且全部已准备） */
export function recompute(lobby: LobbySnapshot): LobbySnapshot {
  const players = lobby.players.map((p) => ({ ...p, isHost: p.playerId === lobby.hostId }))
  const online = players.filter((p) => p.connected)
  // 观战者不算"在线玩家里的人"：既不计入人数，也不阻塞开局
  const seated = online.filter((p) => !p.spectator)
  // 本局席位 = max(真人在座, AI 补位目标)；2v2 必须是 4 席（两队各两人，缺一不可）
  const seats = Math.max(seated.length, lobby.aiSlotCount)
  const teamOk = lobby.teamMode !== '2v2' || seats === MAX_PLAYERS
  const canStart =
    seated.length >= 2 && seated.every((p) => p.ready) && seated.length <= MAX_PLAYERS && teamOk
  return { ...lobby, players, canStart }
}
