import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  clearLastRoom,
  readLastRoom,
  readLastRoomPassword,
  resolveIdentity,
  roomCodeFromUrl,
  roomPasswordFromUrl,
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
  /** 加入房间；password 为可选房间密码（参与 WebRTC 密钥派生，密码不一致则互相看不见） */
  join: (roomCode: string, nickname: string, password?: string) => void
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
  /** 手动直连：开始配对（host = 生成邀请码，guest = 等待粘贴邀请码） */
  startManualPairing: (roomCode: string, role: 'host' | 'guest', nickname: string) => void
  /** 手动直连：提交对方的连接码 */
  submitManualCode: (code: string) => void
  /** 一键重连 */
  retryConnection: () => void
}

export interface UseRoomResult {
  view: RoomView
  identity: Identity
  actions: RoomActions
  initialRoomCode: string | null
  /** 邀请链接里带的房间密码（?key=），用于预填加入表单 */
  initialRoomKey: string | null
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
    passwordEnabled: false,
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
    connection: 'idle',
    transportStatus: 'idle',
    transportDetail: null,
    manual: null,
    errors: [],
  }
}

export function useRoom(): UseRoomResult {
  const identity = useMemo<Identity>(
    () => resolveIdentity({ search: window.location.search, dev: DEV }),
    [],
  )
  const urlRoomCode = useMemo(() => roomCodeFromUrl(window.location.search), [])
  const urlRoomKey = useMemo(() => roomPasswordFromUrl(window.location.search), [])
  const storedRoomCode = useMemo(() => readLastRoom(), [])
  const storedRoomPassword = useMemo(() => readLastRoomPassword(), [])
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
  /** 当前房间密码（切换信令策略后重新加入时要复用；刷新后从 sessionStorage 恢复） */
  const passwordRef = useRef<string | null>(storedRoomPassword)

  // 卸载（含 StrictMode 的模拟卸载）时释放会话；autoJoined 复位以便重新自动重连
  const enqueueTeardown = useCallback((session: RoomSession | null) => {
    if (!session) return teardownRef.current
    // leave() 会广播 bye 并把视图复位；dispose() 是硬止损：该会话对象此后永不复活
    // （两者都要：只有 leave 时，正在等待传输就绪的 join() 仍可能在 leave 之后把会话救活）
    teardownRef.current = teardownRef.current
      .then(() => session.leave())
      .then(() => session.dispose())
      .catch(() => undefined)
    return teardownRef.current
  }, [])

  useEffect(() => {
    return () => {
      const session = sessionRef.current
      sessionRef.current = null
      void enqueueTeardown(session)
      // 注意：这里**不要**复位 autoJoined。
      // DEV 的 StrictMode 会"挂载 → 卸载 → 再挂载"，而自动加入是异步的
      // （创建会话要 await 会话串行队列）：卸载时 sessionRef 可能还是 null，
      // 于是第一个会话既没被释放、又会被第二个会话顶掉 —— 它继续跑 tick、
      // 继续自任房主、继续 onChange 覆盖界面，表现为"刷新后列表里只剩自己、还显示自己是房主"。
      // 刷新页面会重新加载整个模块，本来就不需要靠复位来恢复自动加入。
    }
  }, [enqueueTeardown])


  /** 会话世代：并发/交错创建时，只让最新的那个存活（旧的立刻释放） */
  const generationRef = useRef(0)

  const startSession = useCallback(
    async (roomCode: string, nickname: string): Promise<RoomSession> => {
      const generation = generationRef.current + 1
      generationRef.current = generation
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
      if (generation !== generationRef.current) {
        // 等待期间又有更新的会话被创建（例如 StrictMode 的双挂载）→ 这一个直接作废，
        // 否则它会成为"幽灵会话"：不在 sessionRef 里、没人释放它，却仍在跑、仍在改界面。
        // 调用方的 session.join() 会因为 disposed 立刻返回，不会再建连。
        session.dispose()
        void session.leave()
        return session
      }
      sessionRef.current = session
      return session
    },
    [enqueueTeardown, identity.playerId],
  )

  const join = useCallback(
    (roomCode: string, nickname: string, password?: string) => {
      const clean = nickname.trim().slice(0, 16) || identity.nickname
      const key = password?.trim().slice(0, 64) || null
      passwordRef.current = key
      if (!identity.ephemeral) {
        writeStoredPlayerId(identity.playerId)
        writeStoredNickname(clean)
      }
      writeLastRoom(roomCode, key)
      void startSession(roomCode, clean).then((session) => session.join(roomCode, key ?? undefined))
    },
    [identity, startSession],
  )

  const leave = useCallback(() => {
    clearLastRoom()
    passwordRef.current = null
    // 明确离开房间 = 放弃这一局：清掉房主侧持久化对局（刷新/关标签页不清，供重连恢复）
    const roomCode = sessionRef.current?.getView().roomCode
    if (roomCode) clearGame(defaultStorage(), roomCode)
    const session = sessionRef.current
    sessionRef.current = null
    void enqueueTeardown(session)
  }, [enqueueTeardown])

  // 刷新页面后自动回到原房间（同一标签页会话内生效；点「离开房间」会清除记录）
  useEffect(() => {
    if (autoJoined.current) return
    if (!storedRoomCode) return
    // 链接里是**另一个**房间码 → 尊重链接意图（只预填，等用户点加入）；
    // 链接里的房间就是刚才那个（用邀请链接进来的标签页刷新）→ 直接回到房间。
    if (urlRoomCode !== null && urlRoomCode !== storedRoomCode) return
    autoJoined.current = true
    // 带密码的房间：sessionStorage 里存了密码，刷新后照旧自动回到原房间；
    // 链接里带了更新的密码则以链接为准。
    join(storedRoomCode, identity.nickname, urlRoomKey ?? storedRoomPassword ?? undefined)
  }, [join, identity.nickname, storedRoomCode, storedRoomPassword, urlRoomCode, urlRoomKey])

  const setReady = useCallback((ready: boolean) => sessionRef.current?.setReady(ready), [])
  const setNickname = useCallback((nickname: string) => sessionRef.current?.setNickname(nickname), [])
  const startGame = useCallback(() => sessionRef.current?.startGame(), [])
  const sendCommand = useCallback((cmd: Command) => sessionRef.current?.sendCommand(cmd), [])
  const skipDisconnectedTurn = useCallback(() => sessionRef.current?.skipDisconnectedTurn(), [])
  const setMap = useCallback((mapId: string | null) => sessionRef.current?.setMap(mapId), [])
  const startManualPairing = useCallback(
    (roomCode: string, role: 'host' | 'guest', nickname: string) => {
      const clean = roomCode
      const displayName = nickname.trim().slice(0, 16) || identity.nickname
      if (!identity.ephemeral) {
        writeStoredPlayerId(identity.playerId)
        writeStoredNickname(displayName)
      }
      // 手动直连不走信令，不使用房间密码
      passwordRef.current = null
      writeLastRoom(clean)
      void startSession(clean, displayName).then((session) => session.startManualPairing(clean, role))
    },
    [identity, startSession],
  )
  const submitManualCode = useCallback((code: string) => {
    void sessionRef.current?.submitManualCode(code)
  }, [])
  const retryConnection = useCallback(() => sessionRef.current?.retryConnection(), [])


  /** 切换信令策略：房间内切换会离开并以新策略重新加入 */
  const setStrategy = useCallback(
    (next: SignalStrategy) => {
      if (next === settings.current.strategy) return
      settings.current.strategy = next
      setStrategyState(next)
      const code = sessionRef.current?.getView().roomCode
      const nickname = sessionRef.current?.getView().nickname
      if (code && nickname) {
        const password = passwordRef.current ?? undefined
        writeLastRoom(code, password)
        void startSession(code, nickname).then((session) => session.join(code, password))
      } else {
        setView((prev) => ({ ...prev, strategy: next }))
      }
    },
    [startSession],
  )

  const actions = useMemo<RoomActions>(
    () => ({
      join,
      leave,
      setReady,
      setNickname,
      startGame,
      setStrategy,
      sendCommand,
      skipDisconnectedTurn,
      setMap,
      startManualPairing,
      submitManualCode,
      retryConnection,
    }),
    [
      join,
      leave,
      setReady,
      setNickname,
      startGame,
      setStrategy,
      sendCommand,
      skipDisconnectedTurn,
      setMap,
      startManualPairing,
      submitManualCode,
      retryConnection,
    ],
  )

  return {
    view,
    identity,
    actions,
    initialRoomCode,
    initialRoomKey: urlRoomKey,
    debug: { canUseLocal: DEV, kind, strategy },
  }
}
