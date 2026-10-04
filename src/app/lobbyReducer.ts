/** 房主端权威房间名单的归约函数（纯函数，可单测） */

import type { LobbyPlayer, LobbySnapshot, Phase } from '../net/types'

export const MAX_PLAYERS = 4

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
  return { ...lobby, aiSlotCount: next }
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
  const canStart = seated.length >= 2 && seated.every((p) => p.ready) && seated.length <= MAX_PLAYERS
  return { ...lobby, players, canStart }
}
