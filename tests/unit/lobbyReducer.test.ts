import { describe, expect, it } from 'vitest'
import {
  MAX_PLAYERS,
  connectedCount,
  createLobby,
  hasPlayer,
  isFull,
  recompute,
  removePlayer,
  setHostId,
  setNickname,
  setReady,
  upsertPlayer,
} from '../../src/app/lobbyReducer'

const alice = { playerId: 'alice', nickname: '甲' }
const bob = { playerId: 'bob', nickname: '乙' }

describe('房主端大厅名单', () => {
  it('初始为空，不能开始', () => {
    const lobby = createLobby('ABC23D', 'alice')
    expect(lobby.players).toHaveLength(0)
    expect(lobby.canStart).toBe(false)
    expect(lobby.maxPlayers).toBe(MAX_PLAYERS)
  })

  it('加入 / 幂等（同一玩家重复 hello 不产生重复条目）', () => {
    let lobby = createLobby('ABC23D', 'alice')
    lobby = upsertPlayer(lobby, alice)
    lobby = upsertPlayer(lobby, alice)
    lobby = upsertPlayer(lobby, bob)
    expect(lobby.players.map((p) => p.playerId)).toEqual(['alice', 'bob'])
    expect(lobby.players[0].isHost).toBe(true)
    expect(lobby.players[1].isHost).toBe(false)
  })

  it('满员判定按在线人数（2–4 人）', () => {
    const p3 = { playerId: 'carol', nickname: '丙' }
    const p4 = { playerId: 'dave', nickname: '丁' }
    let lobby = upsertPlayer(createLobby('ABC23D', 'alice'), alice)
    expect(isFull(lobby)).toBe(false)
    lobby = upsertPlayer(lobby, bob)
    expect(isFull(lobby)).toBe(false) // 2 人还能再来
    lobby = upsertPlayer(lobby, p3)
    expect(isFull(lobby)).toBe(false)
    lobby = upsertPlayer(lobby, p4)
    expect(isFull(lobby)).toBe(true) // 4 人满
    expect(connectedCount(lobby)).toBe(4)
    expect(hasPlayer(lobby, 'bob')).toBe(true)
  })

  it('全部在线玩家准备后才能开始，且至少 2 人', () => {
    let lobby = upsertPlayer(createLobby('ABC23D', 'alice'), alice)
    lobby = setReady(lobby, 'alice', true)
    expect(lobby.canStart).toBe(false) // 只有 1 人

    lobby = upsertPlayer(lobby, bob)
    expect(lobby.canStart).toBe(false) // bob 未准备
    lobby = setReady(lobby, 'bob', true)
    expect(lobby.canStart).toBe(true)

    lobby = setReady(lobby, 'alice', false)
    expect(lobby.canStart).toBe(false)
  })

  it('重连（换连接）时准备状态重置', () => {
    let lobby = upsertPlayer(createLobby('ABC23D', 'alice'), alice)
    lobby = upsertPlayer(lobby, bob)
    lobby = setReady(lobby, 'bob', true)

    const kept = upsertPlayer(lobby, bob, { resetReady: false })
    expect(kept.players.find((p) => p.playerId === 'bob')?.ready).toBe(true)

    const reset = upsertPlayer(lobby, bob, { resetReady: true })
    expect(reset.players.find((p) => p.playerId === 'bob')?.ready).toBe(false)
  })

  it('离开 / 改名 / 换房主', () => {
    let lobby = upsertPlayer(createLobby('ABC23D', 'alice'), alice)
    lobby = upsertPlayer(lobby, bob)
    lobby = setNickname(lobby, 'bob', '  飞将军  ')
    expect(lobby.players[1].nickname).toBe('飞将军')

    lobby = setNickname(lobby, 'bob', '')
    expect(lobby.players[1].nickname).toBe('无名将军')

    lobby = removePlayer(lobby, 'alice')
    expect(lobby.players.map((p) => p.playerId)).toEqual(['bob'])
    expect(lobby.canStart).toBe(false)

    lobby = setHostId(lobby, 'bob')
    expect(recompute(lobby).players[0].isHost).toBe(true)
  })
})
