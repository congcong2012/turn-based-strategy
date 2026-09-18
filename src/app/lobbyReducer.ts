/** 房主端权威房间名单的归约函数（纯函数，可单测） */

import type { LobbyPlayer, LobbySnapshot, Phase } from '../net/types'

export const MAX_PLAYERS = 2

export function createLobby(roomCode: string, hostId: string, phase: Phase = 'LOBBY'): LobbySnapshot {
  return recompute({
    roomCode,
    phase,
    hostId,
    players: [],
    maxPlayers: MAX_PLAYERS,
    canStart: false,
    rev: 0,
  })
}

export function connectedCount(lobby: LobbySnapshot): number {
  return lobby.players.filter((p) => p.connected).length
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
  player: { playerId: string; nickname: string },
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
      { playerId: player.playerId, nickname: player.nickname, ready: false, isHost: false, connected: true },
    ]
  }
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
  const canStart = online.length >= 2 && online.every((p) => p.ready)
  return { ...lobby, players, canStart }
}
