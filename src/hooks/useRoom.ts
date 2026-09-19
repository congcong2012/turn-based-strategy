import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  clearLastRoom,
  readLastRoom,
  resolveIdentity,
  roomCodeFromUrl,
  writeLastRoom,
  writeStoredNickname,
  writeStoredPlayerId,
} from '../app/identity'
import type { Identity } from '../app/identity'
import { transportFactoryFor } from '../net/createTransport'
import { createRoomSession } from '../net/roomSession'
import type { RoomSession, RoomView } from '../net/roomSession'
import type { SignalStrategy, TransportKind } from '../net/types'
import type { Command } from '../game/types'
import { clearGame, defaultStorage } from '../net/gameStore'

const DEV = import.meta.env.DEV

export interface RoomActions {
  join: (roomCode: string, nickname: string) => void
  leave: () => void
  setReady: (ready: boolean) => void
  setNickname: (nickname: string) => void
  startGame: () => void
  setStrategy: (strategy: SignalStrategy) => void
  /** 发出对局指令（房主本地校验；客户端发给房主校验） */
  sendCommand: (cmd: Command) => void
  /** 房主：跳过掉线玩家的回合 */
  skipDisconnectedTurn: () => void
  /** 房主：选择地图（null = 按人数自动） */
  setMap: (mapId: string | null) => void
}

export interface UseRoomResult {
  view: RoomView
  identity: Identity
  actions: RoomActions
  initialRoomCode: string | null
  debug: { canUseLocal: boolean; kind: TransportKind; strategy: SignalStrategy }
}

function idleView(identity: Identity, kind: TransportKind, strategy: SignalStrategy): RoomView {
  return {
    status: 'idle',
    statusDetail: null,
    kind,
    strategy,
    role: 'idle',
    roomCode: null,
    selfId: identity.playerId,
    nickname: identity.nickname,
    ready: false,
    players: [],
    canStart: false,
    isHost: false,
    hostNickname: null,
    notice: null,
    error: null,
    peerCount: 0,
    game: null,
    mapId: null,
    myTurn: false,
    paused: false,
    pausedReason: 'none',
    canSkipTurn: false,
    offlinePlayers: [],
    log: [],
    events: [],
  }
}

export function useRoom(): UseRoomResult {
  const identity = useMemo<Identity>(
    () => resolveIdentity({ search: window.location.search, dev: DEV }),
    [],
  )
  const urlRoomCode = useMemo(() => roomCodeFromUrl(window.location.search), [])
  const storedRoomCode = useMemo(() => readLastRoom(), [])
  const initialRoomCode = urlRoomCode ?? storedRoomCode

  // DEV 下 ?transport=local 走同机 BroadcastChannel（无网络调试 / 自动化测试）
  const initialKind = useMemo<TransportKind>(() => {
    if (!DEV) return 'trystero'
    const params = new URLSearchParams(window.location.search)
    return params.get('transport') === 'local' ? 'local' : 'trystero'
  }, [])

  const [kind] = useState<TransportKind>(initialKind)
  const [strategy, setStrategyState] = useState<SignalStrategy>('mqtt')
  const [view, setView] = useState<RoomView>(() => idleView(identity, initialKind, 'mqtt'))

  const sessionRef = useRef<RoomSession | null>(null)
  const autoJoined = useRef(false)
  /** 会话生命周期串行队列：保证"旧的 room 完全释放"之后才创建新 room */
  const teardownRef = useRef<Promise<void>>(Promise.resolve())
  const settings = useRef({ kind: initialKind, strategy: 'mqtt' as SignalStrategy })

  // 卸载（含 StrictMode 的模拟卸载）时释放会话；autoJoined 复位以便重新自动重连
  const enqueueTeardown = useCallback((session: RoomSession | null) => {
    if (!session) return teardownRef.current
    teardownRef.current = teardownRef.current.then(() => session.leave()).catch(() => undefined)
    return teardownRef.current
  }, [])

  useEffect(() => {
    return () => {
      const session = sessionRef.current
      sessionRef.current = null
      void enqueueTeardown(session)
      autoJoined.current = false
    }
  }, [enqueueTeardown])


  const startSession = useCallback(
    async (roomCode: string, nickname: string): Promise<RoomSession> => {
      const previous = sessionRef.current
      sessionRef.current = null
      // 关键：必须等旧 room 走完 leave()。Trystero 以 (appId, roomId) 缓存 room 实例，
      // 若在旧 room 释放前再次 joinRoom，会拿到"正在销毁的 room"——WS 开着却不订阅不广播，
      // 表现为刷新后静默失联（实测踩坑）。
      await enqueueTeardown(previous)
      const session = createRoomSession({
        playerId: identity.playerId,
        nickname,
        strategy: settings.current.strategy,
        kind: settings.current.kind,
        transportFactory: transportFactoryFor(settings.current.kind, settings.current.strategy, roomCode),
        onChange: setView,
      })
      sessionRef.current = session
      return session
    },
    [enqueueTeardown, identity.playerId],
  )

  const join = useCallback(
    (roomCode: string, nickname: string) => {
      const clean = nickname.trim().slice(0, 16) || identity.nickname
      if (!identity.ephemeral) {
        writeStoredPlayerId(identity.playerId)
        writeStoredNickname(clean)
      }
      writeLastRoom(roomCode)
      void startSession(roomCode, clean).then((session) => session.join(roomCode))
    },
    [identity, startSession],
  )

  const leave = useCallback(() => {
    clearLastRoom()
    // 明确离开房间 = 放弃这一局：清掉房主侧持久化对局（刷新/关标签页不清，供重连恢复）
    const roomCode = sessionRef.current?.getView().roomCode
    if (roomCode) clearGame(defaultStorage(), roomCode)
    const session = sessionRef.current
    sessionRef.current = null
    void enqueueTeardown(session)
  }, [enqueueTeardown])

  // 刷新页面后自动回到原房间（只在同一标签页会话内生效；离开房间会清除记录）
  useEffect(() => {
    if (autoJoined.current) return
    if (urlRoomCode !== null) return
    if (!storedRoomCode) return
    autoJoined.current = true
    join(storedRoomCode, identity.nickname)
  }, [join, identity.nickname, storedRoomCode, urlRoomCode])

  const setReady = useCallback((ready: boolean) => sessionRef.current?.setReady(ready), [])
  const setNickname = useCallback((nickname: string) => sessionRef.current?.setNickname(nickname), [])
  const startGame = useCallback(() => sessionRef.current?.startGame(), [])
  const sendCommand = useCallback((cmd: Command) => sessionRef.current?.sendCommand(cmd), [])
  const skipDisconnectedTurn = useCallback(() => sessionRef.current?.skipDisconnectedTurn(), [])
  const setMap = useCallback((mapId: string | null) => sessionRef.current?.setMap(mapId), [])


  /** 切换信令策略：房间内切换会离开并以新策略重新加入 */
  const setStrategy = useCallback(
    (next: SignalStrategy) => {
      if (next === settings.current.strategy) return
      settings.current.strategy = next
      setStrategyState(next)
      const code = sessionRef.current?.getView().roomCode
      const nickname = sessionRef.current?.getView().nickname
      if (code && nickname) {
        void startSession(code, nickname).then((session) => session.join(code))
      } else {
        setView((prev) => ({ ...prev, strategy: next }))
      }
    },
    [startSession],
  )

  const actions = useMemo<RoomActions>(
    () => ({ join, leave, setReady, setNickname, startGame, setStrategy, sendCommand, skipDisconnectedTurn, setMap }),
    [join, leave, setReady, setNickname, startGame, setStrategy, sendCommand, skipDisconnectedTurn, setMap],
  )

  return {
    view,
    identity,
    actions,
    initialRoomCode,
    debug: { canUseLocal: DEV, kind, strategy },
  }
}
