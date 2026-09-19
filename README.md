# 古代战棋 · 可联机回合制战略游戏

一款**纯静态、零服务器成本**的联机回合制战棋：好友打开一个网址、输入同一个 6 位房间码即可开局，**2–4 人**混战。
所有游戏逻辑跑在房主浏览器里，通过 WebRTC 直连同步，部署在 GitHub Pages 上。

**线上地址**：https://congcong2012.github.io/turn-based-strategy/

---

## 怎么玩

1. 打开上面的网址（手机浏览器也可以，支持双指缩放）
2. 填昵称 → 输入 6 位房间码（或让房主点「复制邀请链接」，把带 room 参数的链接发给你）
3. 所有人点「准备」→ 房主点「开始游戏」（房主可在大厅选地图，不选则按人数自动挑）
4. **部署阶段**：预算 3000、最多 4 个单位，点兵种再点己方半场放置
5. **行动阶段**：点己方单位 → 蓝格移动 / 红格攻击；站在据点上是「占领」，兵营可「生产」
6. **淘汰制**：攻陷某人的王城或将其全歼即淘汰该玩家，最后存活者获胜；打满 30 大回合则按分数判定

| 规则要点 | 数值 |
| --- | --- |
| 收入 / 回合 | 王城 1200 + 兵营 300×2 + 村落 400×N（基础 1800） |
| 兵营产能 | 每座每回合 2 个单位（出场位：兵营格 → 相邻空格 → 顺延） |
| 单位上限 | 每方 32 |
| 胜负 | 攻陷王城 / 全歼 / 30 回合计分 / 投降 |

完整设计见 docs/gdd.md。

## 断线重连

- **你刷新页面**：自动回到原房间与对局，不需要重新输房间码
- **房主刷新**：房主回来后会从本地存档恢复整局并同步给你，期间你这边显示「房主已断线，游戏暂停」
- **对手掉线**：席位与部队都会保留；如果正好轮到他，房主可以点「跳过其回合」
- **点「离开/返回大厅」** 才会清掉房主侧的存档（刷新或关标签页不会，否则没法恢复）

## 本地开发

```bash
pnpm install
pnpm dev            # http://127.0.0.1:5173
pnpm test           # 单元测试（88 个）
pnpm e2e            # 端到端测试（19 个，含真实 P2P 与移动端）
pnpm build          # 类型检查 + 生产构建
pnpm preview        # 预览构建产物
```

调试：

- 同一台机器上开两个标签页免网络调试：`?transport=local`（仅 DEV 生效）
- 线上排查：加 `?debug=1` 后可在控制台读到 `window.__atGame` 与 `window.__atBoard`
- 经济数值调整：改 `src/data/*.json`，再跑 `pnpm exec vitest run tests/unit/balance.test.ts` 看 30 回合资金曲线

## 部署

推送到 `main`/`master` 会自动触发 `.github/workflows/deploy.yml`：跑单测 → `pnpm build` → 上传 `dist/` → 发布到 GitHub Pages。

> 仓库 Settings → Pages → Build and deployment → **Source 必须选 GitHub Actions**。
> 若选「Deploy from a branch」，Pages 会把仓库根目录当站点，直接返回源码版 index.html，表现为白屏。

构建产物用相对路径（base 为 `./`），换成任何仓库名都能直接跑，无需改配置。

## 技术栈

TypeScript + React 19 + PixiJS 8（棋盘渲染，动态分包）+ Vite 8；
网络用 Trystero（`@trystero-p2p/mqtt` 公共信令，备用 `torrent`）建立 WebRTC DataChannel；
测试用 Vitest + Playwright。**无后端、无数据库、无付费服务。**

架构与关键决策见 docs/architecture.md，通信协议见 docs/protocol.md，里程碑见 docs/tasks.md。

## 已知限制

- 一房 2–4 人（3 人以上自动使用四人地图「四战之地」）
- 依赖公共信令中转，配对偶尔需要几秒（信令抖动时可切 Torrent）
- 游戏内不做主机迁移（房主掉线只暂停等待）
- 暂无观战与回放（回放所需数据已预留：房主种子 + 完整状态）