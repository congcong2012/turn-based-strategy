# 架构文档（v1.0.0）

> 状态：M1–M7 与 v1.0.0 发版包均已完成并通过验收 · 依赖 GDD：docs/gdd.md
> 本文档描述**当前已实现的**架构，非目标架构。发版流程见 docs/release-checklist.md。

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

### ADR-16：手动直连（SDP 交换）与连接状态机（M7）

**手动直连**：AGENTS.md 要求「公共信令不稳定时提供手动交换 SDP 的降级方案」。
实现要点是**复用同一个 Transport 接口**：`manualTransport.ts` 用裸 `RTCPeerConnection` + 一条 DataChannel，
把 SDP 打包成 `AT1:<base64>` 连接码（房主出 offer，好友回 answer），其余（hello/hostHello/lobby/game/cmd）
与 Trystero 路径完全一致。因此限流、重连、房主权威、指令校验全都不用改。
代价与限制（UI 与文档都写明）：仅 2 人、需要带外渠道、无 TURN 时对称 NAT 后可能连不上。

**连接状态机**：`deriveConnectionState()` 是纯函数，输入「角色 / 传输状态 / peer 数 / 名单人数 / 是否对局中」，
输出 `idle|connecting|connected|waiting|reconnecting|failed`，UI 与诊断面板共用同一份文案表。
把它抽成纯函数的好处是：5 种状态的组合可以在单测里全覆盖，不必靠慢速 E2E 去凑网络故障。

### ADR-15：多人（2–4 人）与淘汰制（M6）

引擎从设计之初就是「玩家数组 + 回合索引」，因此扩到 4 人只需要：
1. **地图注册表**：DATA.maps + MAP_LIST，地图自带 deployZones（数量 = 可容纳玩家数）；
2. **淘汰制**取代「斩首即胜」：GameState.eliminated[]，王城易主或部队归零 → 淘汰该玩家
   （部队撤离、据点归中立），只剩 1 人时结算；2 人局下与旧规则完全等价；
3. **回合轮转跳过淘汰者**，并正确判断「是否绕回第一位玩家」来决定大回合 +1；
4. 计分只统计幸存者（回合上限时）。

沿用一条经验：**凡是引擎里用到 DATA 默认参数的地方，都要能被注入的 data 覆盖**——
M2 的 applyWinCheck、M6 的 resign 都因为漏传 data 在自定义地图上崩过。

### ADR-14：渲染层的两个「静默杀手」（M5 实录）

1. **PixiJS 默认优先 WebGPU**：在没有可用 GPU 的环境（Playwright 移动端模拟等）Application.init()
   既不抛错也不 resolve，表现是「棋盘一片空白且控制台干净」。现在显式 preference: 'webgl'，
   并且 BoardCanvas 对 mount 失败给出可见提示（data-testid=board-error）。
2. **小屏适配**：MIN_SCALE 原为 0.5，24×24 棋盘（1152px）在 393px 宽的手机上放不下，
   相机中心偏移为负 → 投影坐标落到画布外 → 点击命中 HUD。现在下限 0.2（整盘可见），
   并给相机加了边界（棋盘不会被拖到完全看不见）。

排查手法值得复用：**先量数（canvas 是否存在 / 投影坐标 / 命中元素），再看控制台**——
这两个问题都不会在控制台留下痕迹。

### ADR-13：平衡靠模拟，不靠手感

所有数值在 `src/data/*.json`，因此可以**用真实数据跑离线模拟**：
`tests/unit/balance.test.ts` 模拟一个"贪心花钱"的玩家（每个空闲生产位都买得起的最贵兵种，
按节奏占领村落），输出 30 回合的资金/兵力曲线，并把结论写成断言。

M4 的经济修订正是这么做出来的：模拟显示旧配置在第 13 回合满编、期末闲置资金 10 万，
且**单独提高产能完全无效**（受上限所限），于是改为"降产出 + 提产能 + 放宽上限"三管齐下。
以后调数值先跑这个文件看曲线，再决定是否改。

**v1.1.0 补充：兵种平衡用"对决表"**（`tests/unit/matchup.test.ts`）。
经济看曲线，兵种看**满血 1v1**：双方平原相邻、轮流"攻击 → 对方反击"，用真实公式
`computeDamage`（含攻方 HP 比例衰减）跑到一方阵亡，输出「交手次数 + 双方剩余血量」，
并把"谁克谁"写成断言。玩家反馈"刀盾兵没有存在价值"正是靠这张表定位的：
它对轻骑 60（抢了长枪兵的活）、对长枪只有 45（正面还打不过），于是改为反步兵专精
（对长枪 75 / 对弓兵 80 / 对轻骑 45 / 对重骑 12）。
注意"基础伤害高"不等于"打得赢"——HP、反击、先后手都会改变结果，所以必须跑对决表而不是看矩阵。

### ADR-12：动画、战报与分包

- 渲染层对比新旧状态自行决定动画：单位位置变化 → 220ms 补间；掉血 → 380ms 红色光环；
- PixiJS 改为**动态 import**：主包从 530KB 降到 281KB（gzip 88KB），只在真正进入对局时加载；
- 战报（`src/game/logText.ts`）是纯函数：房主与客户端各自把 `GameEvent` 翻译成中文，
  客户端通过 `game.events` 拿到同一条事件流。

### ADR-17：房间密码 = Trystero 的密钥派生，而不是"应用层校验"（v1.0.0）

需求是"给房间加一个可选密码"。三种做法：

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| A. 应用层校验 | 在 `hello` 里带密码，房主比对，不一致就踢 | ❌ 密码会明文进 P2P 信道；踢人前已经配对成功，还要额外写一套拒绝逻辑 |
| B. 房间码拼密码 | 把密码混进 `roomId` | ❌ 密码会出现在公共信令的 topic 里，等于公开 |
| **C. 交给 Trystero** | `joinRoom({ password })` | ✅ **采用** |

Trystero 的 `password` 参与 SDP 密钥派生（`genKey`）**并且**参与握手校验
（`createPasswordHandshake`）。因此密码是**连接层**的事：

- 密码一致 → 正常配对，行为与无密码房间完全相同（协议、房主选举、对局逻辑零改动）；
- 密码不一致 → 两端**根本配不上对**，页面上表现为一直"连接中 / 等待对手"，**不会报错**。

最后一点是这套方案的唯一代价，也是唯一需要"设计"的地方：**静默失败必须被解释**。
因此 UI 做了三件事：

1. 房内显示「已加密」徽章 + 一行提示：「密码不一致会一直等待对手，不会有报错」；
2. 「复制邀请链接」在加密房里自动带上 `&key=<密码>`，好友点开即自动填入（链接 = 钥匙，提示只发给好友）；
3. 记住密码（`sessionStorage`）：刷新后自动重连必须复用同一个密码，否则会静默失联。

密码只暴露布尔值（`RoomView.passwordEnabled`）给 UI，诊断面板写"已设房间密码"而不回显明文；
手动直连（走带外 SDP）不参与密码机制，UI 会说明这一点。

密码错误时 Trystero 会抛出英文错误（`incorrect room password when decrypting offer`）。
虽然"配不上对"这件事本身是预期的，但把英文原文丢给玩家毫无帮助，而且这不是信令问题：
`src/net/transportErrorText.ts` 把已知传输错误翻成中文可执行提示，
`recoveryHint(state, strategy, detail)` 在密码问题上**不再建议切换信令**。

### ADR-18：主页、路由与版本号（v1.0.0）

- **路由只用 query / hash**（`src/app/route.ts`，纯函数 `parseRoute`）：GitHub Pages 是纯静态托管，
  没有服务端 rewrite，用 history 路由就必须额外搞 `404.html` 兜底。规则固定为：
  带合法 `?room=` → 大厅（**老邀请链接不能失效**）→ `#/rules` / `?page=rules` → 规则页 → 其它 → 主页。
  切页只写 hash，刷新与后退都停在原地。
- **版本号在构建期注入**（`vite.config.ts` 的 `define`：`__APP_VERSION__` 取自 package.json，
  `__BUILD_TIME__` 取构建时刻，`__GIT_SHA__` 取 CI 的 `GITHUB_SHA`）。
  单一版本源 = `package.json`，页脚与诊断面板共用 `versionLine()`。
  排查联机问题时，"你那边是什么版本"是第一个要问的问题，所以两个地方都显示。
- **捐赠收款码是静态图片**（`public/donate-qrcode.png` + `import.meta.env.BASE_URL`）：
  不引入任何第三方脚本/图片外链，符合"纯静态、零成本、不收集数据"的约束。

### ADR-19：刷新重连的"静默分裂"——三个真实缺陷与修法（v1.0.0）

发版前用真实网络（两个浏览器上下文 + 公共 MQTT）跑"刷新页面后重连"时，出现了一个
**只有真实 P2P 才暴露、本地调试传输完全看不到**的故障：刷新后列表里只剩自己，并且自己显示"你是房主"，
两边都以为自己是房主，互相忽略对方的名单快照，卡到再刷新为止。

排查手法：给会话加**临时**诊断（按类型统计收发消息 + 每个会话实例的选举状态），
在真实网络下打印，一次就跑出了完整时间线。三个缺陷层层叠加：

**缺陷 1：离开的会话会"复活"。**
`join()` 里 `await transportFactory(...)` 要几百毫秒（动态 import + 建连）。若这期间发生了
`leave()`（React StrictMode 的"挂载→卸载→再挂载"、用户秒点离开），回调返回后传输才就绪，
`activate()` 会把**已经离开的会话救活**：它继续跑 tick、继续自任房主、继续 `onChange` 覆盖界面。
→ 加 `closed` 标志：`teardown()` 置位，`join()` 在 await 之后检查，若已作废就 `await created.leave()` 直接释放传输。

**缺陷 2：StrictMode 下创建了两个会话。**
自动加入是异步的（要 await 会话串行队列），而 StrictMode 的卸载发生在这个 await 之前，
于是卸载时 `sessionRef.current` 还是 null —— 第一个会话既没被释放，又被第二个会话顶掉，
成了"幽灵会话"：不在 `sessionRef` 里、没人释放它，却仍在跑。
→ 两处修：卸载时**不复位** `autoJoined`（刷新会重新加载模块，本来就不需要）；`startSession` 加**世代守卫**，
等待期间若已有更新的会话，就把自己 `dispose()` 掉（调用方的 `join()` 会因为 disposed 立刻返回）。
再配合 `useRoom` 的清理路径 `leave()` 之后补一个 `dispose()`（硬止损）。

**缺陷 3：继承了一个已建连的房间，谁都不再自我介绍。**
新会话若直接复用了旧 room（Trystero 按 `(appId, roomId)` 缓存），两端都不会再触发 `onPeerJoin`，
于是谁都不发 `hello`，双方各自等待 3 秒后**都自任房主**。
→ `activate()` 对"加入前就已经连上的 peer"补一次定向 `hello`；`runTick` 的兜底从"没有 peer 才重发"
扩展为"有 peer 但名单里除自己没有任何在线玩家也重发"（上限 8 次，不会刷屏）。

**顺带修掉的裁决缺陷**：`hostHello` 现在携带发起方的 `joinedAt`。
原来裁决"谁该当房主"要查 `records[otherId]`，而"对方的 hostHello 先于对方的 hello 到达"是常见情形，
此时只能退回 playerId 字典序；一旦字典序有利于自己，就会**永久分裂**（双方都自认房主且不再重新裁决）。
带上 joinedAt 后，无论消息先后都能算出同一结果。降级方在降级后会立刻重新自我介绍，
以便拿到新房主的权威名单（否则会停在"等待对手"）。

回归测试：`tests/unit/hostElection.test.ts`（hostHello 先到的裁决）、
`tests/unit/roomSession.test.ts`（leave 期间完成的 join 不得复活、继承房间也能收敛为客户端）、
`tests/e2e/p2p.spec.ts`（真实网络下真实刷新重连，修复后从"60 秒超时失败"变成 13 秒通过）。

### ADR-20：单人练习（PVE）= 纯前端本地会话，不引入任何网络与后端（v1.2.0）

**决策**：PVE 不走 `roomSession`/`Transport`，而是新增 `src/app/pveSession.ts` —— 它自己持有
`GameState`、自己调 `applyCommand`，并对外产出**与联机同形状的 `RoomView`**。

**为什么不是"复用 roomSession + 内存传输"**：那条路会把大厅阶段、3 秒房主选举等待、
"≥2 人才能开始"的校验一起带进来，与"单人、点开就玩、零网络"的产品定义相冲突。
而 `RoomView` 只是 UI 契约，用本地会话直接产出它，成本很低、收益是**棋盘与交互 100% 复用**。

**权威模型不变**：人类指令与 AI 指令都经 `applyCommand`，两侧跑同一份规则代码，
所以 PVE 不产生"第二套规则"。房主权威在这里退化为"本机即权威"，语义一致。

**不做存档**：联机持久化是为了"房主刷新后给对手补发快照"；单人没有对端，刷新即结束更简单，
也避免把"刷新后恢复 AI 回合"这套状态机塞进 `gameStore`。

**会话只在 `start()` 时创建**（不是挂载时），因此 React StrictMode 的双挂载不会凭空开一局。

### ADR-21：合法指令枚举 + 贪心 AI（用"免克隆打分"绕开深克隆的 O(n²)）

**约束**：`applyCommand` 每次调用都 `JSON.parse(JSON.stringify(state))` 深克隆整个状态。
若 AI 对每个候选都 apply 一次来做 1-ply 搜索，代价是「候选数 × 深克隆」，
在 24×24、每方数个单位的局面下会明显拖慢回合。

**做法**：
1. `src/game/legalCommands.ts` 提供 `legalCommandsFor(state, playerId)`，**校验逻辑与
   `commands.ts` 一一对应**，并用单测守住核心不变量：*枚举出的每一条指令都必须被 `applyCommand` 接受*；
2. `src/ai/index.ts` 的候选打分是**纯读启发式**（`computeDamage` / `chebyshevDistance` / `distanceToHq`），
   **只有最终选中的那一条**才 `applyCommand`；
3. "普通"难度额外对启发式 top-K（K≤5）做一步前瞻（`evaluate(after) - evaluate(before)`），
   用一个很小的 K 换取明显的棋力提升；
4. 每回合设 `MAX_AI_STEPS` 上限 + 兜底 `endTurn`，**保证必然终止**；AI 永不 `resign`。

**难度差异**：`easy` 在 top-3 里带噪随机、约 25% 概率跳过单位动作、部署随意；
`normal` 完整贪心 + 攻击前瞻 + 按计划部署。

**随机性边界**：内核保持**零随机**（战斗完全确定）；随机只存在于 `src/ai/rng.ts`（mulberry32），
种子来自 `PveConfig.seed`，因此同种子必然复现（已有单测）。

**顺带修掉的一个内核缺陷**：`startTurn` 的生产出场在评估"兵营四邻"时没有做边界检查，
而 `moveCost → terrainAt` 对越界坐标**是抛错而不是返回 null** —— 于是一旦某座兵营位于地图边缘
（如测试夹具里的 `bk-B(6,0)`）且本回合要出第二个兵，整局会崩在 `越界: 6,-1`。
官方地图的兵营恰好都不在边缘，所以一直没暴露。已加边界判断，并在 `tests/unit/game/flow.test.ts`
补了回归用例。

### ADR-22：`GameScreen` 用 `mode` 门控复用，而不是为单人写第二套界面

单人局要的棋盘、选中逻辑、移动/攻击高亮、生产面板、战报，与联机**完全一样**；
只有少数片段是联机专属。因此给 `GameScreen` 加 `mode?: 'online' | 'pve'`（默认 `'online'`），
在 `pve` 下隐藏：连接徽章、房间号、暂停横幅、连接帮助、掉线提示、诊断面板，
并把"等待对手…"改成"等待 AI…"、结算遮罩从"返回大厅"改成"再来一局 / 返回主页"。

**关键约束**：`mode === 'online'` 时行为**逐字节不变**，由既有 E2E
（`game` / `reconnect` / `multiplayer` / `connection-status` / `release`）把关。

**路由优先级**：`App.tsx` 的顺序是「单人局 > 联机对局 > 单人设置 > 规则 > 主页 > 大厅」。
单人局排在联机对局之前，因此**不需要**先 `leave()` 联机会话 —— 它永远抢不到渲染权。

## 2. 模块分层

```
src/
├─ main.tsx / App.tsx            入口与外壳（按路由选页：单人局 > 对局 > 单人设置 > 规则 > 主页 > 大厅）
├─ version.ts                    构建期注入的版本信息（页脚 / 诊断面板共用）
├─ ui/                           纯展示 + 事件回调
│  ├─ HomePage.tsx               主页（联机对战 / 单人练习 / 规则速查）
│  ├─ PveSetup.tsx               单人练习设置页（对手数量 / 我的阵营 / 难度）
│  ├─ RulesPanel.tsx             规则速查（全部由 src/data/*.json 渲染）
│  ├─ AppFooter.tsx              页脚：版本号 + 规则入口 + 捐赠入口
│  ├─ DonateDialog.tsx           捐赠弹层（静态收款码图片）
│  └─ Lobby / PlayerList / ManualSdpPanel / GameScreen / BoardCanvas ...
├─ hooks/
│  ├─ useRoom.ts                 React 绑定：身份解析、会话创建、生命周期串行化
│  └─ usePveGame.ts              单人绑定：把本地会话包装成同形状的 { view, actions }
├─ game/                         纯规则内核（无 React / 无渲染 / 可纯单测）
│  ├─ types.ts                   GameState / Unit / Command / ErrorCode / GameEvent
│  ├─ data.ts                    加载并索引 src/data/*.json
│  ├─ board.ts                   棋盘查询（单位、据点、部署区、深拷贝）
│  ├─ movement.ts                Dijkstra 可达范围 / 路径 / 射程
│  ├─ combat.ts                  确定性伤害公式与反击判定
│  ├─ state.ts                   回合状态机（START/RESOLVE/HANDOVER）、经济、胜负、计分
│  ├─ commands.ts                指令校验与执行（权威的唯一入口）
│  ├─ legalCommands.ts           ★ 合法指令枚举（AI 的候选集；校验与 commands 一一对应）
│  ├─ journal.ts                 战报/事件累积器（联机与单人共用）
│  └─ logText.ts                 事件 → 中文战报（纯函数）
├─ ai/                           本地 AI（纯函数：状态 → 下一条 Command）
│  ├─ rng.ts                     确定性 PRNG（随机只存在于 AI 层，内核保持零随机）
│  ├─ evaluate.ts                局面评估（材料 / 据点 / 王城威胁 / 资金）
│  └─ index.ts                   nextCommand：贪心 + 一步前瞻，两档难度
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
   ├─ route.ts                   极简路由（query/hash）→ 主页 / 大厅 / 规则页 / 单人练习
   ├─ pveSession.ts              ★ 单人会话：本地持有 GameState 并驱动 AI，产出 RoomView
   ├─ roomCode.ts                房间码归一化 / 校验 / 随机生成
   ├─ identity.ts                playerId、昵称、URL 房间码与房间密码、本标签页房间记忆
   ├─ hostElection.ts            房主选举纯函数
   └─ lobbyReducer.ts            大厅名单归约纯函数
```

数据流（联机）：`Transport 事件 → roomSession →（纯函数）hostElection / lobbyReducer → RoomView → React`。
数据流（单人）：`pveSession →（纯函数）applyCommand / nextCommand → RoomView → React`，**全程不经网络**。

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

## 4. 已知限制（v1.0.0）

| 限制 | 说明 | 计划 |
| --- | --- | --- |
| 依赖公共信令 | 好友局可用，公共中转抖动会延迟配对 | 备用 Torrent 策略 + 手动直连（M7 已实现） |
| 房间上限 4 人 | 第 5 人会被拒绝（`roomFull`） | 按需放开，但四人图之外还要补地图 |
| 游戏内不做主机迁移 | 房主掉线只暂停等待；接管只在 LOBBY 阶段允许 | 与 GDD 8.5 一致 |
| 手动直连仅 2 人且需带外通信 | 无 TURN，双方都在对称 NAT 后可能连不上 | 家庭网络实测可用（跨运营商已验收） |
| 房间密码不一致时**静默等待** | 连接层拒绝配对，页面上没有"密码错误"这种报错 | UI 已明确解释 + 邀请链接自动带密码 |
| 手动直连不使用房间密码 | 该链路不经过信令 | UI 说明即可 |
| 全量广播状态 | 4 人局状态仅几十 KB | 状态变大后再做增量补丁 |
| 无观战 / 回放 | 数据已预留（种子 + 完整状态 + 指令流） | 见 docs/tasks.md 的 M8 待办 |
| 单人练习（PVE）不做存档 | 刷新即结束本局（联机才需要"房主刷新后给对手补发"的持久化） | 可按需求用 `gameStore` 加一个合成 key |
| PVE 为自由混战，无组队 | 内核没有"队伍"概念，胜负始终按个人判定 | 若要做 2v2 需在内核引入队伍与按队伍判胜 |
| 3 人局会空出一角 | 3 方打四角图时，第 4 角的中立王城+兵营会被弃置，可被任意一方占领（+1800/回合），但**不会淘汰任何人** | 设置页已明确提示；如需完全对称需新增 3 人图 |

## 5. 成本与合规

无后端 / 无数据库 / 无 Docker / 无付费服务；GitHub Pages 与公共信令均免费。
生产构建不包含任何 DEV 调试入口（`?as=`、`?transport=local` 仅在 `import.meta.env.DEV` 下生效，已有测试守护）。