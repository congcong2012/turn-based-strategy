# 里程碑与任务

> 规则：每个里程碑必须**可运行、可测试**，并同步更新 docs/ 下的文档。

## M0 · 设计冻结 ✅

- [x] 10 个游戏设计问题（题材：古代；地图：20×20+）
- [x] MVP GDD：docs/gdd.md（核心循环 / 回合状态机 / 地图单位资源战斗 / 联机与房间 / 胜负 / 明确不做）

## M1 · 可联机大厅（GitHub Pages 静态） ✅

交付物
- [x] Vite + React + TS 工程，可 `pnpm build` 出纯静态 `dist/`
- [x] Trystero（@trystero-p2p/mqtt）P2P 房间，公共信令默认 MQTT
- [x] 页面：昵称、房间码（归一化 + 随机生成）、加入、玩家列表、准备、开始（提示）
- [x] 第一个加入者自动成为房主，UI 显示👑房主标识
- [x] 加入/离开实时更新列表；准备状态经房主权威同步
- [x] 刷新后自动回到原房间（sessionStorage 记忆 + playerId 持久化），不产生重复玩家
- [x] 手动 SDP 降级入口（占位）+ 真实降级手段：信令策略切换 MQTT ↔ Torrent
- [x] GitHub Pages 子路径构建（base 相对路径 + Actions 注入）+ 部署工作流
- [x] 文档：docs/architecture.md、docs/protocol.md、docs/tasks.md

验收结果（本地实跑）

| 验收项 | 结果 |
| --- | --- |
| 两个浏览器同一网址 + 同一房间码 → 互相看到昵称 | ✅ `local.spec.ts` + `p2p.spec.ts`（真实 P2P，两个独立浏览器上下文） |
| 刷新页面后能重新加入房间 | ✅ 两条轨道均通过（真实 P2P 下 5 秒内恢复） |
| 房主标识正确 | ✅ 第一个加入者带👑，且客户端不显示 |
| 构建产物可部署到 GitHub Pages | ✅ `base: './'` 相对路径 + `preview.spec.ts` 无 404、无控制台报错 |
| 单元测试 | ✅ 33 passed |
| E2E | ✅ 10 passed（local 6 / p2p 1 / preview 3） |

## M2 · 游戏内核骨架（下一步）

- [ ] 接入 PixiJS，渲染 24×24 棋盘与相机（缩放 0.5–2.0）
- [ ] 数据驱动：data/units.json、terrain.json、matchup.json、maps/ancient_01.json
- [ ] 房主侧 GameState + 回合状态机（START/ACTION/RESOLVE/HANDOVER）
- [ ] DEPLOY 阶段：部署预算 + 部署区校验 + 双端同步
- [ ] `snapshot` 完整快照 + `patch` 增量同步；断线重连拉取快照
- [ ] 指令与错误码：move / attack / capture / produce / wait / endTurn
- [ ] 确定性随机：房主种子 + 指令日志（为回放预留）

## M3 · 完整对局闭环

- [ ] 收入/生产/维修、占领易主、兵种相克与伤害公式
- [ ] 反击、间接射击（移动后不可攻击）、地形减伤
- [ ] 胜负判定：斩首 / 歼灭 / 30 大回合计分 / 投降
- [ ] 房间满员放开到 2–4 人可选（P2P 星型拓扑，房主权威）
- [ ] E2E：完整一局的最短路径（部署 → 若干回合 → 分出胜负）

## M4 · 打磨与发布

- [ ] 音效占位、移动端触屏可用性、断线重连提示
- [ ] 平衡性数据表调整（基于好友实测）
- [ ] GitHub Pages 正式发布 + 好友局实测（3 局以上）
- [ ] 回放/观战（可选，数据已预留）

## 常用命令

```bash
pnpm install          # 安装依赖
pnpm dev              # 本地开发（http://127.0.0.1:5173）
pnpm test             # 单元测试（33 个）
pnpm build            # 类型检查 + 生产构建（dist/）
pnpm preview          # 预览生产构建（http://127.0.0.1:4173）
pnpm e2e:local        # 本地传输 E2E（无需网络）
pnpm e2e:p2p          # 真实 P2P E2E（需要公网信令）
pnpm e2e              # 全部 E2E（含生产构建验收）
```

> 首次运行 E2E 需要 `pnpm exec playwright install chromium`（约 170MB）。
> CI 只跑单元测试 + 构建；E2E 作为本地质量门（真实 P2P 依赖公共信令，不适合放进部署流水线）。

## GitHub Pages 部署清单

1. **仓库 Settings → Pages → Build and deployment → Source 必须选 `GitHub Actions`**
   （若选的是「Deploy from a branch」，Pages 会把仓库根目录当站点，直接返回源码版 index.html → 白屏）；
2. 推送到 `main` 或 `master` 会自动触发 `.github/workflows/deploy.yml`（也可手动 Run workflow）；
3. 工作流会跑单元测试 → `pnpm build` → 上传 `dist/` → 发布到 `https://<user>.github.io/<repo>/`；
4. 本地可先自检子路径是否正常（复现线上环境）：

   ```bash
   pnpm build
   node scripts/serve-subpath.mjs turn-based-strategy 4180   # 参数传仓库名，不要传 /repo/
   # 浏览器打开 http://127.0.0.1:4180/turn-based-strategy/
   ```

   Windows/Git Bash 注意：命令行里形如 `/repo/` 的参数会被 MSYS 转换成 `C:/Program Files/Git/repo/`。
