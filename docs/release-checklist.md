# 发版回归清单（每次发版照做）

> 目标：**任何一次发版都不靠记忆**。按顺序执行，任一步失败就停下来修，修完从第 1 步重跑。
> 预计耗时：约 6–8 分钟（不含真人验收）。

## 0. 发版前确认

- [ ] 当前分支干净（`git status`），并且就是要发的那个 commit
- [ ] `package.json` 的 `version` 已经是本次要发的版本号（如 `1.0.0`）
- [ ] `CHANGELOG.md` 顶部已写好本次条目（含日期与验收记录表）
- [ ] 仓库 Settings → Pages → Build and deployment → **Source = GitHub Actions**
      （选「Deploy from a branch」会直接返回源码版 index.html，表现为白屏）

## 1. 静态检查与单元测试

```bash
pnpm typecheck      # 期望：无输出（tsc 通过）
pnpm test           # 期望：129 passed
```

通过标准：**0 failed**。经济数值改过的话，额外看曲线：

```bash
pnpm exec vitest run tests/unit/balance.test.ts   # 打印 30 回合资金/兵力曲线
```

## 2. 生产构建

```bash
pnpm build          # 期望：0 error；记录主包与 Pixi 分包体积
```

通过标准：构建无 error；`dist/index.html` 里的资源路径是 `./assets/...`（相对路径，子路径部署必需）。

## 3. 端到端回归（4 条轨道，全绿才算过）

```bash
pnpm exec playwright test --project=local     # 28 passed（约 2.5 分钟，不需要公网）
pnpm exec playwright test --project=mobile    # 2 passed（Pixel 5 视口 + 触摸）
pnpm exec playwright test --project=preview   # 3 passed（dist 产物 + 子路径）
pnpm exec playwright test --project=p2p       # 1 passed（真实 WebRTC + 公共信令，抖动可重试一次）
pnpm exec playwright test --project=manual    # 1 passed（手动直连 SDP 交换，约 1 分钟）
```

通过标准：**0 failed**。
`p2p` 依赖公共信令、`manual` 依赖裸 WebRTC 打洞，两者都会受网络与机器负载影响：
**偶发失败先单跑一次**（`--project=p2p` / `--project=manual`）确认，仍失败才当缺陷处理。

## 4. 子路径复现（线上环境的本地替身）

```bash
pnpm build
node scripts/serve-subpath.mjs turn-based-strategy 4180
# 浏览器打开 http://127.0.0.1:4180/turn-based-strategy/
```

通过标准：能进主页、资源无 404、能建房间（这一步专门抓「本地好、线上白屏」）。

## 5. 用户可见清单（手测，每次发版都要点一遍）

| # | 检查项 | 期望 |
| --- | --- | --- |
| 1 | 打开线上地址 | 落在**主页**（不是直接进大厅），标题与三个入口正常 |
| 2 | 主页「单人练习」 | 标注「开发中」，点击弹出说明弹层，能关闭 |
| 3 | 主页「规则速查」 | 兵种/克制/地形/经济表格有数据；「返回主页」可用 |
| 4 | 页脚 | 显示 `v<版本号> · 日期 · commit`；「❤ 请我喝杯茶」能打开收款码弹层，**二维码图片显示正常** |
| 5 | 「联机对战」→ 大厅 | 昵称、房间码、房间密码输入框都在；房间码归一化（小写→大写） |
| 6 | 房主设密码建房 | 房内出现「已加密」徽章与密码提示 |
| 7 | 「复制邀请链接」 | 链接形如 `...?room=ABC23D&key=密码`；好友点开时房间码**与密码**都已填好 |
| 8 | 密码不一致 | 两边都能进房但互相看不见，页面**不报错**；提示语说明了这一点（不是 bug） |
| 9 | 开局 | 部署（预算 3000 / 最多 4 单位）→ 行动 → 结束回合，双方状态一致 |
| 10 | 刷新页面 | 自动回到原房间/对局（加密房也不会因为丢密码失联） |
| 11 | 房主刷新 | 客户端显示「房主已断线，游戏暂停」，房主回来后恢复整局 |
| 12 | 「诊断信息」 | 折叠面板可复制，内容含**版本号**、房间码、密码状态、连接状态、最近错误 |
| 13 | 手机浏览器 | 棋盘整盘可见、能缩放、移动/攻击需要再点一次确认 |

## 6. 真人验收（跨网络，发版必做）

两台设备、**两个不同网络**（如：家里宽带 + 手机 4G/5G，最好不同运营商）：

- [ ] 双方互相看到昵称与👑房主标识
- [ ] 完整打完一局的关键流程：部署 → 行动 → 结束回合 → 占领/战斗战报同步
- [ ] 其中一方刷新页面 → 自动回到对局
- [ ] 房主刷新 → 另一方暂停 → 房主回来恢复整局
- [ ] 至少验证一次**投降/结算**与「返回大厅」

记录方式：把结论填进 `CHANGELOG.md` 本次版本的「验收记录」表。

## 7. 打标签与部署

```bash
git add -A
git commit -m "release: v1.0.0"
git tag -a v1.0.0 -m "v1.0.0"
git push origin HEAD
git push origin v1.0.0
```

- [ ] GitHub Actions 的 deploy 工作流**绿**（`https://github.com/congcong2012/turn-based-strategy/actions`）
- [ ] 线上地址打开后，页脚版本号与本次 tag 一致（版本号对不上 = 看的还是旧产物，强制刷新/清缓存）
- [ ] **跑线上自检**（真实公网，含加密房与刷新重连，约 2 分钟）：

  ```bash
  node scripts/verify-live.mjs
  # 期望：线上自检结果：15/15 通过，退出码 0
  # 本地复现线上子路径：LIVE_URL=http://127.0.0.1:4180/turn-based-strategy/ node scripts/verify-live.mjs
  ```

- [ ] 把自检输出粘进 `CHANGELOG.md` 该版本的「线上自检结果」
- [ ] 建议在 GitHub 上把该 tag 发布为 Release，正文直接用 CHANGELOG 对应小节

## 8. 失败处理

| 现象 | 处置 |
| --- | --- |
| 单测/E2E 失败 | **不发版**。修完从第 1 步重跑全套（不要只重跑失败那条） |
| 线上白屏 | 检查 Pages Source 是否为 GitHub Actions；检查 `dist/index.html` 资源路径是否为相对路径 |
| 线上资源 404 | 说明 base 被改成了绝对路径（`VITE_BASE` 只接受 `/repo/` 形式） |
| 只有部分玩家连不上 | 让对方点「切换信令」→「手动直连」→ 发回诊断信息 |
| 版本号不对 | CI 没跑 / 缓存没刷新；重跑工作流并强刷（Ctrl+F5） |
