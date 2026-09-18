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

### ADR-9：游戏内核是纯函数，渲染与 React 都不碰规则

`src/game/**` 只做"状态 → 新状态 + 事件"的纯计算，不依赖 React / Pixi / 网络：

```
applyCommand(state, playerId, cmd, data) → { ok: true, state, events } | { ok: false, code }
```

- 房主本地执行；客户端把同一条指令发给房主执行；**两端跑的是同一份代码**，但只有房主的结果是权威的；
- 数值全部来自 `src/data/*.json`（兵种/地形/据点/克制矩阵/规则/地图），改平衡不用改代码；
- 因此 70+ 条规则可以用纯单测覆盖（移动范围、伤害、反击、占领、经济、回合、胜负），不需要浏览器。

### ADR-10：渲染层只负责"画"和"点"

`src/render/boardApp.ts`（PixiJS 8）把权威状态画成棋盘，并把鼠标位置换算成格子坐标；
它不判断任何合法性——点哪里都交给 `applyCommand` 拒绝。这样渲染层可以随时替换/优化。
DEV 下会暴露 `window.__atBoard.project(x,y)`（格子→屏幕坐标），让 E2E 能用**真实鼠标点击**驱动 canvas。

### ADR-11：断线重连 = 房主侧状态持久化 + 暂停等待（不做主机迁移）

**问题**：房主浏览器刷新后，内存里的权威状态就没了；客户端不能接管（GDD 8.5 游戏内不做主机迁移）。

**方案**：只有房主写一份持久化对局（`src/net/gameStore.ts`，localStorage，
键 `ancient-tactics.game.<房间码>`），每次指令通过后落盘：

| 场景 | 行为 |
| --- | --- |
| 房主刷新/崩溃后回来 | 自动重进房间 → 3 秒当选房主 → 读回持久化对局 → 广播 lobby + game，客户端无缝继续 |
| 恢复条件 | 持久化对局里的**所有玩家都已回到房间**才恢复；对局已结束（GAME_OVER）不恢复 |
| 对手刷新 | 房主把该席位标记为离线（**不移出名单**），对手回来后标记在线 + 单播完整状态 |
| 轮到掉线玩家 | 对局停滞：双方看到"对手已断线"；房主可"跳过其回合" |
| 房主掉线中 | 客户端整体冻结（`pausedReason = 'host-offline'`），只等待房主回来，**不抢房主** |
| 明确离开房间 | 清除持久化对局（刷新/关标签页不清，否则无法恢复） |

选举阶段（`hostElection.phase`）随对局阶段切换成 DEPLOY/PLAYING，从而自动落实"LOBBY 之外不允许接管"。

### ADR-12：动画、战报与分包

- 渲染层对比新旧状态自行决定动画：单位位置变化 → 220ms 补间；掉血 → 380ms 红色光环；
- PixiJS 改为**动态 import**：主包从 530KB 降到 281KB（gzip 88KB），只在真正进入对局时加载；
- 战报（`src/game/logText.ts`）是纯函数：房主与客户端各自把 `GameEvent` 翻译成中文，
  客户端通过 `game.events` 拿到同一条事件流。

## 2. 模块分层

```
src/
├─ main.tsx / App.tsx            入口与外壳
├─ ui/                           Lobby / PlayerList / ManualSdpPanel（纯展示 + 事件回调）
├─ hooks/useRoom.ts              React 绑定：身份解析、会话创建、生命周期串行化
├─ game/                         纯规则内核（无 React / 无渲染 / 可纯单测）
│  ├─ types.ts                   GameState / Unit / Command / ErrorCode / GameEvent
│  ├─ data.ts                    加载并索引 src/data/*.json
│  ├─ board.ts                   棋盘查询（单位、据点、部署区、深拷贝）
│  ├─ movement.ts                Dijkstra 可达范围 / 路径 / 射程
│  ├─ combat.ts                  确定性伤害公式与反击判定
│  ├─ state.ts                   回合状态机（START/RESOLVE/HANDOVER）、经济、胜负、计分
│  ├─ commands.ts                指令校验与执行（房主权威的唯一入口）
│  └─ logText.ts                 事件 → 中文战报（纯函数）
├─ render/
│  └─ boardApp.ts                PixiJS 棋盘渲染 + 相机 + 点击换算
├─ data/                         数据驱动：units/terrain/buildings/matchup/rules/maps/*.json
├─ net/
│  ├─ types.ts                   Wire 协议、LobbySnapshot、Transport 接口
│  ├─ createTransport.ts         传输工厂（trystero | local）
│  ├─ trysteroTransport.ts       Trystero 实现（含策略动态 import、DEV 调试钩子）
│  ├─ localTransport.ts          BroadcastChannel 实现（DEV/测试）
│  ├─ gameStore.ts               房主侧对局持久化（断线重连）
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

### 踩坑 2：PixiJS 在 React StrictMode 下把整棵组件树带崩

**现象**：进入对局后界面全白，控制台报 `this._cancelResize is not a function`。
**根因**：StrictMode 会"挂载 → 卸载 → 再挂载"，`Application.init()` 还没完成时 `destroy()` 就被调用，
Pixi 内部在未初始化的 Application 上调私有方法直接抛错，React 渲染树随之卸载。
**修复**：`BoardApp` 记录 `initialized/destroyed`，`init()` 完成后若已 destroyed 就直接收尾；
`destroy()` 在未初始化时不碰 `Application.destroy()`。

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
