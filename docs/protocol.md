# 通信协议（M1：大厅阶段）

> 本文档是 GDD 第 8.6 节协议清单在 M1 的**已实现子集**。M2 起在同一 `wire` action 上扩展游戏指令。

## 1. 房间与传输

- `appId`：`ancient-tactics-mvp-v1`（常量，见 src/net/trysteroTransport.ts）
- `roomId`：`${appId}::${roomCode}`，房间码 6 位，字符集 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
- 传输：Trystero WebRTC DataChannel；信令策略 `mqtt`（默认）/ `torrent`（降级）
- 所有业务消息走同一个 action：`room.makeAction('wire')`
- 信封字段 `from` 一律是**玩家 playerId**（不是 peerId），用于身份绑定与重连识别

## 2. 消息表（M1）

| 类型 | 方向 | 载荷 | 说明 |
| --- | --- | --- | --- |
| `hello` | 双向（加入时广播 + peer 加入时单播） | `from, nickname, joinedAt` | 身份广播；收到后回一份（每个 peerId 只回一次） |
| `hostHello` | 房主 → 全体/单播 | `from, hostId` | 房主声明；新人加入时房主立即单播，避免其误自任 |
| `lobby` | 房主 → 全体 | `from, lobby: LobbySnapshot` | **权威房间名单快照** |
| `ready` | 客户端 → 房主 | `from, ready` | 准备意图（房主自己走本地路径） |
| `nick` | 客户端 → 房主 | `from, nickname` | 改名意图 |
| `roomFull` | 房主 → 单播 | `from` | 房间已满，被拒玩家自动退回加入界面 |
| `startHint` | 房主 → 全体 | `from` | 开始游戏提示（M1 只提示，M2 起改为进入 DEPLOY） |
| `bye` | 双向 | `from` | 显式离开 |
| `game` | 房主 → 全体/单播 | `from, state: GameState` | **M2 权威对局状态**：每次指令通过后广播；新玩家加入/重连时单播补发 |
| `cmd` | 客户端 → 房主 | `from, cmd: Command` | 指令意图（房主校验后才会生效） |
| `cmdRejected` | 房主 → 单播 | `from, code: ErrorCode` | 指令被拒绝，状态不变 |

### 对局指令（Command，M2 子集）

| 指令 | 阶段 | 说明 |
| --- | --- | --- |
| `deploy{unitType,x,y}` | DEPLOY | 在己方部署区放置单位（预算 3000 / 最多 4 个） |
| `deployDone` | DEPLOY | 确认部署；双方都确认后进入 PLAYING |
| `move{unitId,x,y}` | PLAYING | 移动（每单位每回合 1 次；路径由房主 Dijkstra 重算校验） |
| `attack{unitId,targetId}` | PLAYING | 攻击（射程/间接单位"移动后不可攻击"校验，含反击结算） |
| `capture{unitId}` | PLAYING | 占领（仅可占领兵种；进度 +floor(HP/10)，易主在回合结算生效） |
| `produce{buildingId,unitType}` | PLAYING | 兵营生产（立即扣费，下一回合 START 出场） |
| `wait{unitId}` | PLAYING | 待机（结束该单位本回合行动） |
| `endTurn` | PLAYING | 结束回合（RESOLVE → HANDOVER → 下一玩家 START） |
| `resign` | 任意 | 投降（不受回合归属限制） |

> **M2 用完整状态广播**（`game`），而不是增量补丁：24×24 地图 + 数十单位的完整状态只有几 KB，
> 2 人好友局下带宽与序列化成本可忽略，换来的是"不可能出现增量同步 bug"。等状态规模变大再改增量。

### LobbySnapshot

```ts
type LobbyPlayer = {
  playerId: string; nickname: string
  ready: boolean; isHost: boolean; connected: boolean
}
type LobbySnapshot = {
  roomCode: string
  phase: 'LOBBY' | 'DEPLOY' | 'PLAYING' | 'PAUSED' | 'GAME_OVER'
  hostId: string
  players: LobbyPlayer[]
  maxPlayers: number   // M1 = 2
  canStart: boolean    // 房主计算：≥2 名在线玩家且全部已准备
  rev: number          // 单调递增；客户端只接受更新的快照
}
```

## 3. 时序

### 3.1 加入与选举

```
A 加入  → 广播 hello
        → 3 秒内无人应答 → 自任房主，广播 hostHello
B 加入  → 广播 hello
        → A 收到 hello：单播 hostHello 给 B，并把 B 加入权威名单，广播 lobby
        → B 收到 hostHello：承认 A 为房主（role = client）
        → B 收到 lobby：渲染玩家列表
```

> **握手慢于 3 秒时**：B 会先自任房主并广播 hostHello；两端收到对方声明后按
> **joinedAt 更早者胜**裁决（同刻才比 playerId 字典序），输的一方静默降级并采纳赢家的 lobby。
> 因此最终结果仍然是"第一个进入房间的人是房主"，且两端必然一致。

### 3.2 准备与开始

```
B 点准备 → 发 ready{true} → A 更新名单 → 广播 lobby(rev+1) → B 渲染"已准备"
A 点开始 → 校验 canStart（服务端校验，客户端无法越权）
        → 广播 startHint（M1：仅提示）
```

### 3.3 断线 / 重连 / 掉线

| 场景 | 行为 |
| --- | --- |
| 玩家刷新 | 新 peerId + 同 playerId → 房主幂等 upsert（ready 重置）→ 广播 lobby |
| 玩家关闭页面 | peer 离开 → 房主从名单移除 → 广播 lobby |
| 房主掉线 | 其余玩家等待 5 秒；仍无房主则由**最早加入的剩余玩家**接管（仅 LOBBY） |
| 旧连接晚到的 leave | 若该 playerId 已绑定新 peerId，则忽略该 leave（不误删） |

## 4. 校验与拒绝

M1 的"服务端校验"体现在房主侧：
- 只有房主会写名单；客户端发来的 `ready`/`nick` 只影响自己那一行（`from` 决定，不可伪造他人）；
- 非当前房主的 `lobby` 消息被忽略；
- 房间满员时拒绝新玩家（`roomFull`）；
- 过期 `lobby` 快照按 `rev` 丢弃。

M2 起扩展为 GDD 8.6 的完整指令集与错误码
（`move/attack/capture/produce/wait/endTurn` + `NOT_YOUR_TURN / OUT_OF_RANGE / ...`）。

## 5. 单元测试覆盖

- `hostElection.test.ts`：选举全部规则（含竞态、宽限期、阶段限制）
- `lobbyReducer.test.ts`：名单归约（幂等、满员、canStart、重连重置）
- `roomSession.test.ts`：**双端内存传输**跑完整协议（互见、准备同步、竞态收敛、离开、接管、重连、满员拒绝、改名）
