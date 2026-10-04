# 单人 AI 架构（AI-6）

> 面向维护者。读这份文档能回答：**AI 的决策是怎么产生的、为什么可复现、成本花在哪、
> 想加一档难度要动哪些文件、哪些事还没做。**
>
> 演进过程与逐项实测见 `docs/ai-diagnosis.md`、`ai-baseline.md`、`ai-slice1-report.md`、
> `ai-slice2-report.md`、`ai-eval-report.md`、`ai-rollout-report.md`。
> 面向玩家的难度说明见 `docs/ai-difficulty.md`。

## 1. 模块地图

| 文件 | 职责 | 是否纯函数 |
| --- | --- | --- |
| `src/ai/rng.ts` | 确定性 PRNG（`mulberry32`）与种子散列（`hashSeed`） | ✅ |
| `src/ai/heuristics.ts` | **候选打分**：免克隆，用 `computeDamage` / `chebyshevDistance` 直接估算；含平局打破 `pickTieBreak` | ✅ |
| `src/ai/evaluate.ts` | **局面评估**：材料 / 位置 / 据点 / 收入…；v2 开关（经济·威胁·守土·补给·克制·比分）与 v3 开关（pending·克制价值·远程安全·暴露面）默认关闭 | ✅ |
| `src/ai/profile.ts` | **难度档案表** `PROFILES`（唯一事实源）+ `PLAYABLE_DIFFICULTIES`（对玩家开放的档） | ✅ |
| `src/ai/index.ts` | **决策入口**：`nextCommand(state, playerId, difficulty, data, rng)`，按档案分派到"一步前瞻 / 搜索 / rollout" | ✅ |
| `src/ai/search.ts` | 切片 2：beam 极小极大 + α-β + 迭代加深（`expert` 档用） | ✅ |
| `src/ai/rollout.ts` | 切片 4：回合级 rollout（`oracle` 档用） | ✅ |

游戏侧接线：

| 文件 | 职责 |
| --- | --- |
| `src/app/pveSession.ts` | 本地会话：自己持有 `GameState`，人类与 AI 的指令都走同一个 `applyCommand`；对外产出与联机同形状的 `RoomView` |
| `src/app/pveStore.ts` | 对局存档（localStorage 单槽 `ancient-tactics.pve`）；难度合法性取自 `PLAYABLE_DIFFICULTIES` |
| `src/hooks/usePveGame.ts` | 把会话接进 React，并在终局时清档 |
| `src/ui/PveSetup.tsx` | 设置页：对手数 / 阵营 / 难度；难度文案按 `Record<PlayableDifficulty, …>` 穷尽，**加档会编译报错** |
| `scripts/ai-bench.ts` | 对战评估台（`npm run bench:ai`） |

## 2. 决策流水线

```
pickPlay(state, playerId)
  ├─ 候选生成   legalCommandsFor → playCommandsFor(state, playerId, data)
  │               └─ 过滤：剔除 endTurn；v2 档剔除 wait（"原地不动"启发式分恒为 0，
  │                  一旦开启威胁类权重就会击败所有有风险的走位 → AI 集体挂机，实测 0/16 胜）
  ├─ 候选打分   scorePlay(...)       ← 免克隆启发式，快但糙
  ├─ 排序取前 K
  └─ 规划（按档案三选一）
       ├─ 一步前瞻  对前 lookaheadK 名各 apply 一次、比较 evaluate 差值   （easy 之外的所有档兜底路径）
       ├─ 浅层搜索  searchCommand(...)   两人局 + searchDepth > 0        （expert）
       └─ 回合 rollout rolloutCommand(...) 两人局 + rolloutFoeSteps > 0  （oracle）
```

部署阶段是另一条路径（`pickDeploy`）：按 `deployPlan` 出兵，落点选"离敌方王城最近"，
困难档另加"贴近已有友军"的成阵奖励；简单档兵种与落点都随机。

**执行器**：`pveSession` 反复调用 `nextCommand`，每步之间隔 `DEFAULT_ACTION_DELAY_MS = 450ms`
（让棋盘上的动作看得清），直到拿到 `endTurn`；`MAX_AI_STEPS = 40` 是兜底闸门，保证任何情况下都会交出控制权。

## 3. 三条硬约束（改代码时别破坏）

### 3.1 纯函数、零随机

游戏内核 `src/game/**` 保持零随机；AI 的随机数**无状态派生**：

```ts
mulberry32(hashSeed(seed, state.rev, state.turnSeq, state.turnIndex, playerId, difficulty))
```

**为什么不能"开局建一个生成器整局复用"**：生成器内部游标无法序列化，刷新恢复后 AI 会从
随机数序列头部重来、走出与刷新前不同的分支。改成纯函数派生后，同一个 `(种子, 局面)` 必然给出同一个决策。

> ⚠️ 唯一的随机消费点是 `TIE_EPSILON` 平局打破（并列候选之间按种子任选）。
> 这不是为了"加变化"，而是**让评估台能积累独立样本** —— 否则两个确定性 AI 互打永远是同一盘棋。

### 3.2 公平：AI 读的就是玩家看得到的

本作**没有战争迷雾**（GDD 明文，视野字段预留但不生效），UI 侧栏对每名玩家都列出
据点 / 单位 / 资金 / 得分与**所有玩家**的生产队列。
因此 AI 读完整 `GameState` **等于玩家可见信息**，不存在作弊读取。

**将来若加入迷雾**：AI 的裁剪必须与 UI 同源（同一份可见性函数），否则就会变成作弊 AI。

### 3.3 难度只改决策质量

禁止给 AI 额外军费 / 视野 / 行动点 / 改数值。难度差异只能来自
`PROFILES` 里的决策参数（前瞻宽度、评估开关、搜索/rollout 参数）。

## 4. 成本模型（很重要，别再用"单节点耗时"估）

**真正的开销大头是候选枚举** `playCommandsFor`（内部跑 Dijkstra 算移动范围），
成本随军团规模暴涨：后期 47 个单位、700+ 候选时**一次枚举约 10ms**，
比叶子评估（约 0.06ms）高两个数量级。所以搜索/rollout 都用**枚举次数**封顶：

| 上限 | 作用 |
| --- | --- |
| `expansionBudget` | 单条指令的枚举次数上限（搜索层） |
| `rolloutBudget` | 单条指令的枚举次数上限（rollout） |
| `nodeBudget` | 叶子预算（确定性"时间盒"） |
| `MAX_AI_STEPS` | 每回合指令数硬闸门（40） |

**为什么用计数而不是墙钟**：项目要求"刷新后 AI 逐帧可复现"，决策必须是
`(state, playerId, difficulty, seed)` 的纯函数。墙钟会让同一局面在不同负载下搜到不同深度 → 复现失效。

**延迟口径**：不看单步，看 **AI 一整回合的全部操作 ≤ 30s**。
换算：`最坏回合 ≈ 单步 max × MAX_AI_STEPS(40)`。

## 5. 线程模型（当前：主线程；Worker 是未做的前置）

现状：`nextCommand` 在**主线程同步执行**，但 `pveSession` 用 `schedule()` 把每一步拆成单独的 tick，
所以每一步之间界面是活的。`easy` / `normal` / `hard` 单步都在毫秒级，玩家无感。

`oracle` 单步 p50 ≈ 139ms、p95 ≈ 407ms、**max ≈ 1784ms**（加厚对手模型后的配置）
—— 换算成整回合（`MAX_AI_STEPS = 40`）最坏约 **71s**，远超"整回合 ≤30s"的约定；
切片 2 验收时还出现过一次**未复现的 `max 8436ms` 离群值**。

> **因此：任何比 `hard` 重的档，上线前必须先搬进 Web Worker。**（AI-6 待办，尚未实施。）
> 迁移要点：`nextCommand` 已经是纯函数，Worker 只需 `postMessage({state, playerId, difficulty, seed})`
> → 回 `{command}`；难点在把 `pveSession` 的 AI 驱动从"同步 `stepAi`"改成"await 结果再 apply"，
> 且**不能破坏可复现性**（结果只依赖入参，不依赖时序）。

## 6. 怎么验证改动

```bash
npm test                                             # 单测（AI 相关在 tests/unit/ai/）
npm run bench:ai -- --games 8 --pair hard:normal --out tmp/a.md   # 快速迭代（8 种子 = 16 局）
npm run bench:ai -- --games 30 --pair oracle:hard --out docs/ai-bench-rollout.md  # 正式验收（60 局）
```

- **`--games N` 实际跑 2N 局**（N 个种子 × 双方互换座位）。
- 胜率给 **Wilson 95% 置信区间**；样本量不足时区间会很宽，别过度解读。
- 评估台同时输出行为指标（占领/局、维修/局）与决策耗时 p50/p95/max。
- ⚠️ **强度结论一律以真实地图的评估台为准**：fixtures 小图（8×8）没有隘口、开局就能斩首，
  曾给出与真实 24×24 地图完全相反的结论（小图 8/8、真实 11.7%）。

## 7. 想加一档难度？

1. 在 `src/ai/profile.ts` 的 `PROFILES` 里加一档（先**不要**放进 `PLAYABLE_DIFFICULTIES`）。
2. 用评估台做单项消融与整体对照（≥60 局），对照当前最高档，门槛 ≥65% 且 Wilcoxon/Wilson CI 下界 >50%。
3. 跑延迟：单步 max × 40 ≤ 30s；否则先做 Worker。
4. **达标后**才把该档加进 `PLAYABLE_DIFFICULTIES` —— 这一步会连锁触发：
   设置页缺文案 → 编译报错；存档校验自动接受新档；`tests/unit/pveStore.test.ts` 会自动覆盖它。
5. 更新 `docs/ai-difficulty.md`，并在 `CHANGELOG.md` 记录实测数据。
