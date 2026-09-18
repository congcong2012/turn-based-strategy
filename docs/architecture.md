# 架构文档（M1：联机大厅）

> 状态：M1 已完成并通过验收 · 依赖 GDD：docs/gdd.md
> 本文档描述**当前已实现的**架构，非目标架构。

## 1. 技术栈（实际版本）

| 层 | 选型 | 版本 |
| --- | --- | --- |
| 构建 | Vite | 8.3.0 |
| 框架 | React + TypeScript | 19.3.0 / 7.0.2 |
| 网络 | Trystero（作用域包 @trystero-p2p/*） | 0.25.4 |
| 测试 | Vitest + Playwright | 5.0.1 / 1.63.0 |
| 运行时 | Node / pnpm | 24.19.0 / 11.23.0 |
| 托管 | GitHub Pages（纯静态） | — |

### ADR-1：为什么是 @trystero-p2p/* 而不是 trystero

`trystero@0.25.x` 已改为**废弃垫片**：`trystero/mqtt` 等子路径导入即抛错
（源码见 `node_modules/trystero/dist/deprecate.mjs`）。官方已拆分为作用域包，
因此使用 `@trystero-p2p/core | mqtt | torrent`。API 也随之为**新风格**：

```ts
const room = joinRoom(config, roomId, callbacks)
const action = room.makeAction<Wire>('wire')
action.onMessage = (data, ctx) => { /* ctx.peerId */ }
await action.send(data, { target: peerId })
room.onPeerJoin = (peerId) => {}
room.onPeerLeave = (peerId) => {}
```

### ADR-2：默认信令策略 = MQTT（依据是实测，不是偏好）

本机实测公共信令可达性：

| 信令 | 端点 | 结果 |
| --- | --- | --- |
| MQTT | broker.emqx.io:8084 | ✅ 可连（CONNACK ~1.4s） |
| MQTT | broker-cn.emqx.io:8084 | ✅ 可连 |
| MQTT | broker.hivemq.com:8884 | ✅ 可连 |
| MQTT | test.mosquitto.org:8081 | ❌ 连接错误 |
| Torrent | tracker.openwebtorrent.com | ✅ 可连 |
| Nostr | relay.damus.io / nos.lol | ❌ 全部超时 |

因此默认 `mqtt`，并在 UI 提供 `torrent` 一键降级（切换策略会离开房间并以新策略重新加入）。

### ADR-3：房主选举

`hostHello` 握手 + 计时器，纯函数实现（src/app/hostElection.ts）：

1. 加入即广播 `hello`，等待 3 秒（CLAIM_WAIT_MS）；
2. 收到 `hostHello` → 承认对方为房主（第二个及之后加入者天然是客户端）；
3. 超时无人应答 → 自任房主并广播 `hostHello`（第一个加入者即房主）；
4. 竞态（双方几乎同时自任）→ 按 **"先加入者优先"（joinedAt）** 收敛，同一时刻再用 playerId 字典序兜底。
   公共信令握手可能超过 3 秒，后加入者也会误自任房主；用加入时间裁决才能保住
   "第一个进入房间的人成为房主"的语义（线上实测踩到过：后加入者反而抢到房主）。
   joinedAt 是各端 hello 里复制过来的值，因此两端算出的结果必然一致；时钟偏差只会选错赢家，不会造成两端不一致；
5. 房主掉线 → 5 秒宽限期（HOST_LOST_GRACE_MS）后由剩余最早加入者接管；
6. **接管只在 LOBBY 阶段允许**，与 GDD 8.5「游戏内不做主机迁移」一致；
7. 房主收到新玩家 `hello` 时立即回 `hostHello`，避免新玩家空等 3 秒后误自任房主。

### ADR-4：房主权威的大厅名单

- 客户端只发**意图**：`ready{ready}`、`nick{nickname}`；
- 房主维护权威 `LobbySnapshot` 并广播 `lobby`；
- 快照带**单调递增 `rev`**，客户端只接受更新的快照（丢弃竞态窗口里的重排/过期快照）；
- 客户端不自己判定谁是房主、不自己算 canStart，只渲染房主下发的状态。

### ADR-5：身份与重连

Trystero 的 `selfId` 是**每次加载新生成**的（`genId(20)`），不能当玩家身份用。
因此本项目自带 `playerId`（localStorage 持久化 UUID）+ 昵称；房间内以 `playerId` 识别玩家：

- 刷新 → 新 peerId + 同 playerId → 房主按 `playerId` 幂等 upsert，不产生幽灵玩家；
- 若刷新后旧 peerId 的 leave 事件晚于新连接建立，则跳过移除（避免误删）；
- 重连（换连接）时准备状态重置为未准备。

### ADR-6：传输层抽象

`Transport` 接口统一 `trystero` 与 `local`（BroadcastChannel）两种实现：

- 生产：`createTrysteroTransport`（动态 import 策略包，按需分包）；
- DEV：`?transport=local` 走 BroadcastChannel，可在无网络时双开调试，也是 E2E 的确定性轨道；
- 单元测试：`tests/unit/support/memoryHub.ts` 提供内存传输，可暂停投递以复现竞态。

业务逻辑（src/net/roomSession.ts）不依赖 React、不依赖浏览器，因此可以纯函数式单测。

### ADR-7：GitHub Pages 子路径与路由

- `vite.config.ts` 的 `base` **固定用相对路径 `'./'`**：产物写成 `./assets/xxx.js`，
  挂在 `https://<user>.github.io/<repo>/` 下自然解析到 `/<repo>/assets/...`，换仓库名无需改任何配置。
  可选 `VITE_BASE=/<repo>/` 覆盖，但会做格式校验（见下）；
- 路由**只用 query 参数** `?room=ABC123`，因此在 Pages 上**不需要 404.html 兜底**；
- 开发服务器固定绑定 `127.0.0.1`（Windows 上 localhost 会解析到 ::1，导致 Playwright 探活失败）；
- `public/.nojekyll` 随构建产出，防止将来改用分支部署时被 Jekyll 处理。

> **踩坑（线上白屏真实案例）**：第一次部署后 `https://<user>.github.io/<repo>/` 白屏。
> 现场取证：返回的 HTML 里是 `<script type="module" src="/src/main.tsx">`
> ——**这是源码版 index.html**，说明 Pages 当时用的是「分支部署：master / (root)」，
> 浏览器拿到的 TSX 无法执行，于是白屏；同时 `assets/` 返回 404。
> 另外还发现两个坑：
> 1. **工作流没触发**：仓库默认分支是 `master`，而工作流只监听 `main` → 改为 `[main, master]`；
> 2. **Git Bash(MSYS) 会篡改绝对路径**：`VITE_BASE=/turn-based-strategy/` 被转换成
>    `C:/Program Files/Git/turn-based-strategy/`，构建产物直接写坏。
>    命令行参数同理（`node scripts/serve-subpath.mjs /repo/` 也会被转换）。
>    因此：CI 不再注入 `VITE_BASE`，改回相对路径；`vite.config.ts` 对非法值做校验并回退；
>    `scripts/serve-subpath.mjs` 只接收**仓库名**（内部自行拼 `/repo/`）。

### ADR-8：PixiJS vs Phaser（M2 前给出结论）

**推荐 PixiJS**。理由：本作是"确定性状态机 + 自绘 20×24 格子"，React 负责 UI 外壳、
Pixi 只负责棋盘渲染；Phaser 的场景/物理/输入/资源加载体系对本项目是冗余负载，
且会把状态与渲染耦合起来。M1 未安装任何渲染库（大厅不需要画布），M2 接入 PixiJS。

## 2. 模块分层

```
src/
├─ main.tsx / App.tsx            入口与外壳
├─ ui/                           Lobby / PlayerList / ManualSdpPanel（纯展示 + 事件回调）
├─ hooks/useRoom.ts              React 绑定：身份解析、会话创建、生命周期串行化
├─ net/
│  ├─ types.ts                   Wire 协议、LobbySnapshot、Transport 接口
│  ├─ createTransport.ts         传输工厂（trystero | local）
│  ├─ trysteroTransport.ts       Trystero 实现（含策略动态 import、DEV 调试钩子）
│  ├─ localTransport.ts          BroadcastChannel 实现（DEV/测试）
│  └─ roomSession.ts             ★ 房间状态机：选举 + 权威名单 + 协议编排（无 React 依赖）
└─ app/
   ├─ roomCode.ts                房间码归一化 / 校验 / 随机生成
   ├─ identity.ts                playerId 与昵称持久化、URL 房间码、刷新后自动回到房间
   ├─ hostElection.ts            房主选举纯函数
   └─ lobbyReducer.ts            大厅名单归约纯函数
```

数据流：`Transport 事件 → roomSession →（纯函数）hostElection / lobbyReducer → RoomView → React`。

## 3. 踩坑记录（M1 最重要的一条）

**现象**：真实 P2P 下，玩家刷新页面后永远无法重新配对；两边 peer 列表恒为空；
浏览器控制台无任何报错；MQTT WebSocket 处于 open 状态；但页面收发 MQTT 报文计数恒为 0
（用裸 WebSocket 手写 MQTT CONNECT 从同一页面测试，CONNACK 1.4 秒内正常返回，证明网络无问题）。

**根因**：Trystero 以 `(appId, roomId)` 缓存 room 实例（`strategy.mjs`：`occupiedRooms[appId][roomId]`），
且该缓存**直到 `leave()` 走完才删除**。若在其释放前再次 `joinRoom` 同一房间，
拿到的是**正在销毁的 room 对象**——WebSocket 还在，但既不订阅也不广播，于是静默失联。
触发路径：React StrictMode 下"刷新自动重连"的 mount → cleanup → mount 双调用，
导致 join → dispose → join。

**修复**：会话生命周期**串行化**（src/hooks/useRoom.ts 的 `teardownRef` 队列）：
新建会话前必须 `await` 旧会话的 `leave()`：
```ts
const previous = sessionRef.current
sessionRef.current = null
await enqueueTeardown(previous)   // 等旧 room 真正从 occupiedRooms 释放
const session = createRoomSession({ ... })
```
修复后刷新重连在 5 秒内完成（测试：`tests/e2e/p2p.spec.ts`）。

**教训**：第三方库的"静默失败"最贵。定位手段是**分层判别实验**：
先确认网络（裸 WS+MQTT 握手）→ 再确认信令流量（报文计数）→ 再确认库状态（room.getPeers()）→ 最后读库源码。

## 4. 已知限制（M1）

| 限制 | 说明 | 计划 |
| --- | --- | --- |
| 依赖公共信令 | 好友局可用，公共中转抖动会延迟配对 | 备用 Torrent 策略 + M2 起考虑局域网/手动 SDP |
| 仅 2 人 | 房间满员第 3 人被拒绝 | GDD 仍按 2–4 人设计，M2 起放开 |
| LOBBY 阶段才允许房主接管 | 游戏内房主掉线只暂停 | 与 GDD 8.5 一致 |
| 手动 SDP 面板仅为占位 | Trystero 不暴露 SDP 注入点 | 真实降级 = 策略切换 |
| 信令策略切换会重新加入房间 | 会短暂离开房间 | 可接受 |

## 5. 成本与合规

无后端 / 无数据库 / 无 Docker / 无付费服务；GitHub Pages 与公共信令均免费。
生产构建不包含任何 DEV 调试入口（`?as=`、`?transport=local` 仅在 `import.meta.env.DEV` 下生效，已有测试守护）。
