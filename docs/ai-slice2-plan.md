# AI-4（切片 2）· 搜索层 —— 实施计划

> 阶段：AI-4 · **已实施，但强度验收未通过（`expert` 51.7% 胜 hard < 70% 门槛）→ 不启用**
> 交付报告：`docs/ai-slice2-report.md` · 实测：`docs/ai-bench-slice2.md`
> 基线代码：`2df9825`（切片 0 评估台 + 切片 1 评估器 v2）
> 关联：`AGENTS.md`（单人 AI 难度提升规则）、`docs/ai-diagnosis.md` §6/§9/§10、`docs/ai-slice1-report.md`
> 上一片结论：`hard` 已从"真实地图胜率 11.7%"掰正到 **83.3% 胜 normal**；静态威胁项实测**剧毒**（单项消融 0/16），风险判断留给本切片的真搜索。

---

## 1. 目标

新增 **`expert` 档**：在现有"启发式候选排序 + 单步前瞻"之上，加一层**真正的搜索**——

```
候选生成 → 启发式排序 → 2 层 beam 极小极大 + α-β → 迭代加深（节点预算封顶）→ 执行
```

**验收门槛（未达标即整片回退）**

| 项 | 门槛 | 度量方式 |
| --- | --- | --- |
| 强度 | **`expert` ≥70% 胜 `hard`** | `npm run bench:ai`，真实地图，60 局/对阵，Wilson 95% CI |
| 延迟 | **AI 一个回合的全部操作 ≤30s**（按用户指示修订；等价于单条最坏 ≤750ms） | 评估台耗时统计 + `MAX_AI_STEPS` 推算 |
| 合法性 | **非法指令数 = 0** | 评估台内建断言（`applyCommand` 不接受即抛错） |
| 回归 | 241 单测不回退；`easy`/`normal`/`hard` 行为**逐字不变** | `npm test`、`npm run typecheck`、`npm run build` |
| 非偶然 | 换主种子复跑一次，方向一致 | `--seed` 参数 |

---

## 2. 为什么需要搜索（诊断）

**现有 AI 是 `1 步前瞻的贪心`**：每题只看"这一步之后"的静态分（`src/ai/index.ts` → `pickPlay`）。它无法表达"走位 → 集火"这类**多步组合**，也无法评估**对手的回手**。

切片 1 给出了一条花过实测成本的结论：**把"对手威胁"写成静态评估项是有害的** ——
威胁图多项惩罚相乘后达 ±几千分、压过材料项，AI 变成"择地躲避"而不推进（单项消融 **0/16 胜**）。
结论是把风险判断**交给真搜索**：搜索天然会看到"我走这里 → 对手最优回手 → 我的局面变差"，不需要拍脑袋的惩罚系数。

**性能基座（诊断 §6/§9 实测）**

| 量 | 值 |
| --- | --- |
| 单节点（`applyCommand` 0.047ms + `evaluate` 0.0094ms） | **0.056ms** |
| 中盘分支因子 | **177** |
| 2 层 beam（24×16 ≈ 400 节点） | ≈ **22ms** ✅ |
| 全宽 2 层（177² ≈ 3.1 万节点） | ≈ 1.75s ❌ |
| 3 层 beam（≈6100 节点） | ≈ 340ms（超 expert 的 150ms 预算） |

→ 结论：**beam 必须窄**；`maxDepth` 默认只求到 2 层，靠**迭代加深**在预算富余时尝试 3 层。

---

## 3. 计划（算法与接口）

### 3.1 新增 `src/ai/search.ts`

```ts
export interface SearchParams {
  maxDepth: number          // 迭代加深上限（层 / ply）
  beamWidth: number         // 根层（我的第一步）候选上限
  innerBeamWidth: number    // 根层以下所有层的候选上限（含我的后续步与对手步）
  expansionBudget: number   // 候选枚举次数上限 —— 真正的耗时大头，单独封顶
  nodeBudget: number        // 叶子预算
}

export interface SearchResult {
  cmd: Command
  depth: number   // 实际完成的深度
  nodes: number   // 实际访问节点数（供单测断言 ≤ nodeBudget）
  score: number
}

export function searchCommand(
  state: GameState, playerId: PlayerId, profile: AiProfile,
  data: GameData, random: () => number,
): SearchResult
```

**算法**（每个 ply = 一条指令，与内核 `Command` 一一对应）

1. **迭代加深**：`d = 2, 3, … maxDepth`。每轮在 `nodeBudget` 内跑完；若该轮超预算则**丢弃该轮**、返回上一轮结果（保证不会用半截深度的结果）。
2. **节点** = 一次 `applyCommand`（推进到一个 ply 之后的局面）。
3. **候选排序**：用现成的**免克隆启发式**给候选打分，己方层降序（最强剪枝顺序）、对手层升序。
4. **极小极大 + α-β**：己方层 `max`，对手层 `min`；先访问排序最优的子节点以获得强剪枝。
5. **叶评估**：`evaluate(state, playerId, data, weights)`（v2 全开），终局返回 ±1e6。
6. **平局**：Δ < `TIE_EPSILON`(=2) 用传入 rng 任选 —— 与现有机制一致，**同种子可复现**。
7. **候选卫生**：root 层沿用切片 1 已验证的两条结构修复 —— **候选池剔除 `wait`**（否则会挂机）、**"有动作就做"**（`actThreshold = -Infinity`）。

### 3.2 确定性：用**节点预算**取代"时间盒"（已确认）

诊断 §10 原计划写的是"时间盒迭代加深"。但**墙钟时间会破坏本项目的硬要求**：

> 本项目要求"刷新/重开标签页后 AI 逐帧可复现"（`docs/ai-diagnosis.md`、`pveStore` 的恢复语义、
> 以及评估台的可复现性），前提是决策必须是 `(state, playerId, difficulty, seed)` 的**纯函数**。

墙钟一介入，同一局面在不同负载/机器上会搜到不同深度 → 复现失效。
因此本片改为 **`nodeBudget`（确定性计数）+ `maxDepth`** 封顶：工作量确定 → 结果确定。

**延迟口径（按用户指示修订）**：不再要求"单步 p95 ≤150ms"，改为
**AI 一个回合的全部操作 ≤30 秒**。实现上仍走"单条指令节点预算"（确定性、无状态），
只是把预算放宽到让"最坏回合"仍落在 30s 内：

```
40 条指令/回合（MAX_AI_STEPS）× 单条最坏耗时 ≤ 30s  →  单条最坏 ≤ 750ms
```

实测单条 p95 ≈ 119ms / max ≈ 180ms（真实地图，见 `docs/ai-bench-slice2.md`），
即最坏回合 ≈ 7s，留有充分余量。**没有采用墙钟硬保险**：它一旦触发就复现失效，
属于"该靠调 nodeBudget 修掉的 bug"。

### 3.3 新增 `src/ai/heuristics.ts`（纯搬运，行为不变）

搜索需要在每一层对候选排序，而排序函数 `scorePlay/scoreAttack/scoreMove/scoreProduce` 现在**私有在 `index.ts`** 里。
若 `search.ts` 反向 import `index.ts` 会形成**循环依赖**。因此把它们**原样搬到** `src/ai/heuristics.ts`，
`index.ts` 与 `search.ts` 都从新模块 import。

- **纯搬运**：函数体逐字不动 → `easy/normal/hard` 与既有 241 条单测行为不变。
- 同时把 `TIE_EPSILON` / `FOCUS_FINISH_BONUS` 等常量一并迁出复用。

### 3.4 `src/ai/index.ts` 改动

- `Difficulty` 联合类型加 `'expert'`；`PROFILES` 加 `expert` 项。
- `AiProfile` 加 4 个搜索参数：`searchDepth` / `beamWidth` / `foeBeamWidth` / `nodeBudget`；
  `easy/normal/hard` 全部为 `0` → 走原路径（**逐字不变**）。
- `pickPlay` 开头加一个分派：`profile.searchDepth > 0` → 调 `searchCommand`，否则走现有 1 步前瞻。

**`expert` 草案**（v2 开关与 `hard` **完全相同** → 保证"相对 hard 的增益只来自搜索"，归因干净）

```ts
expert: {
  noisy: false, focusFire: 0.6, cohesion: 0, lookaheadK: 12, deployPlan: DEPLOY_PLAN,
  v2: true, smartProduce: true, economy: 3, threat: 0, defend: 6, repair: 8, counter: 1, scoreAware: true,
  searchDepth: 3, beamWidth: 10, innerBeamWidth: 3, expansionBudget: 72, nodeBudget: 1200,
}
```

> `threat` 仍为 0 —— 它的风险判断由搜索承担，不引入已被证否的静态惩罚。

**beam 为什么是"根层宽、深层窄"（实测驱动的设计）**：本作一个 ply = 一条指令，且
**未结束回合时先后手不变** —— 所以根层以下的节点大多"还是我自己在动"。若每层都按根层宽度
展开，树按 `beamWidth^depth` 爆炸、预算永远搜不完第 3 层，而第 3 层恰恰是"我收手 → 对手回手"
唯一可能出现的地方。因此拆成两个参数：`beamWidth`（根层）与 `innerBeamWidth`（根层以下所有层）。
这个 bug 是单测抓出来的（`预算充足时迭代加深能搜到设定深度` 失败），修完单步 p50 从
≈66ms 降到 ≈32ms、且第 3 层能真正搜完。

**为什么还要 `expansionBudget`（测评阶段暴露的真相）**：诊断 §9 的成本模型是
"单节点 = apply + evaluate ≈ 0.056ms"，据此推算 2 层约 22ms。**实测把这个模型推翻了**：
真正的大头是每展开一个节点都要重新跑 `playCommandsFor`（逐单位 Dijkstra）+ 全量打分，
**一次枚举随军团规模在 1–10ms 之间**（后期 47 个单位、700+ 候选时约 10ms），是叶子评估的
上百倍。只按叶子计数封顶，单步最坏曾冲到 **1475ms**（40 条/回合 ≈ 59s，超出 30s 允许值）。
因此补上"枚举次数"上限 —— 两个预算任一超限就丢弃当前深度、退回上一层的结果。
收窄到 `beam 10 / inner 3 / 枚举 72` 后实测单步 **p50 ≈35ms / p95 ≈255ms / max ≈334ms**
（含 36 单位的大军团），最坏回合 ≈13s。

---

## 4. 影响文件

| 文件 | 改动 |
| --- | --- |
| `src/ai/search.ts` | **新增** —— beam 极小极大 + α-β + 迭代加深（节点预算） |
| `src/ai/heuristics.ts` | **新增** —— 从 `index.ts` 原样搬出的候选打分函数 |
| `src/ai/index.ts` | `Difficulty` 加 `expert`；`PROFILES.expert`；`AiProfile` 加 4 个搜索参数；`pickPlay` 分派 |
| `src/ai/evaluate.ts` | **预计不动**（除非 bench 暴露必须的小修，会单独说明） |
| `scripts/ai-bench.ts` | 加 `expert` 策略；默认对阵加 `expert:hard`、`expert:v1-hard`、`expert:random`；镜像加 `expert:expert` |
| `tests/unit/ai/search.test.ts` | **新增** —— 见第 5 节 |
| `tests/unit/ai/ai.test.ts` | 加 `expert` 能收局 / 永不 resign / 与 hard 同源不回归 |
| `docs/ai-slice2-report.md` | **新增** —— 交付报告（消融、被否决的方案、结构说明） |
| `docs/ai-bench-slice2.md` | **新增** —— 验收实测（含换种子复跑） |
| `docs/tasks.md` | 勾选 AI-4 |
| `package.json` | **不改**（无新依赖；`bench:ai` 工具链不变） |

**不动的边界**：`src/game/**`（内核零改动）、`src/net/**`、`src/ui/**`、`pveStore`（见下）。

---

## 5. 测试计划

**单测 `tests/unit/ai/search.test.ts`**

| 用例 | 断言 |
| --- | --- |
| 恒合法 | 搜索产出的每条指令都能被 `applyCommand` 接受（沿用 `legalCommands` 不变量） |
| **确定性** | 同一 `(state, playerId, seed)` 跑两次 → **同一条指令**、同一 `nodes`（复现前提） |
| 预算纪律 | `result.nodes ≤ nodeBudget`（边界：预算极小时仍返回合法指令） |
| **等价性** | 在小 fixtures 上，与"朴素全宽极小极大（同深度）"选出**同一最优值**——证明 α-β/beam 未改变语义 |
| 回归 | `searchDepth = 0` 时，决策与改造前 `hard` **逐字相同** |
| 深度生效 | `maxDepth = 1` vs `2` 在同一战术局面能选出不同指令，且 2 层更优（可解释的战术用例，如"避免送死/补刀残血"） |

**门禁**：`npm test`（241 + 新增）、`npm run typecheck`、`npm run build`。

**评估台（手动衡量，不进 CI）**

```bash
npm run bench:ai -- --games 8 --pair expert:hard --out tmp/quick.md   # 迭代
npm run bench:ai -- --games 60 --out docs/ai-bench-slice2.md          # 验收
npm run bench:ai -- --games 60 --seed 7 --out tmp/reseed.md           # 换主种子确认非偶然
```

**风险登记**

1. **重演"过度保守"翻车**（切片 1 前车之鉴）→ 门槛式验收 + 评估台把关，不达标整片回退。
2. **`nodeBudget` ↔ p95 换算**要实测校准（机器差异）→ 以本机 p95 为准。
3. **≥3 玩家时极小极大的语义不成立**（非零和）→ 见待确认项 2。
4. **4 人图未验证**（诊断风险 3）→ 本片先不碰，AI-6 补 `ancient_04` bench。

---

## 6. 决议记录（原"待确认"项的最终结果）

1. **时间盒 → 节点预算**：☑ 采纳。另按用户指示把延迟口径从"单步 ≤150ms"放宽为"整回合 ≤30s"（§3.2）。
2. **≥3 玩家（4 人图）**：☑ 采纳"保守回退"。`expert` 仅在 `players.length === 2` 时走搜索；
   3–4 人局回退到 1 步前瞻（即 `hard` 的行为）。已有单测断言"4 人局 expert 决策与 hard 完全一致"。
3. **`expert` 本片不接入 UI**：☑ 采纳。`PveSetup` 选项与 `pveStore` 校验留到 AI-5，Worker 留到 AI-6；
   本片只交付"可被评估台调用的搜索层"，`expert` 在 UI 上暂不可选（守"重计算必须在 Web Worker"）。
4. **抽取 `heuristics.ts`**：☑ 采纳；并把难度档案一并抽到 `profile.ts`（避免 `index ↔ search` 循环依赖）。
   既有 241 条单测全部保持绿色 = 纯搬运、行为不变。

---

## 7. 验收结果（事后补记 · 2026-10-03）

**❌ 强度门槛未通过 → `expert` 不启用**（详细数据见 `docs/ai-bench-slice2.md`）。

| 项 | 门槛 | 实测 | 判定 |
| --- | --- | --- | --- |
| 强度 | expert ≥70% 胜 hard | **51.7%**（60 局） | ❌ |
| 延迟 | 整回合 ≤30s | 单步最坏 ≈334ms ⇒ ≈13s | ✅ |
| 合法性 | 非法指令 0 | 无触发 | ✅ |
| 回归 | 三档行为逐字不变 | 既有单测全绿 | ✅ |

关键修订（计划外、由实测驱动）：

- 新增 `expansionBudget`（**枚举次数**上限）—— 诊断 §9 的 0.056ms/节点成本模型被实测推翻，
  真正的开销是每节点的 `playCommandsFor` + 全量打分（后期约 10ms/次）。只用叶子预算时单步最坏达 1475–2000ms。
- 把 `foeBeamWidth` 改名为 `innerBeamWidth`，语义改为"根层以下所有层"—— 根层不设 beam 会导致迭代加深永远搜不完第 3 层。
- 最终参数：`searchDepth 3 / beamWidth 10 / innerBeamWidth 3 / expansionBudget 72 / nodeBudget 1200`。

未通过的门槛按计划**不进入上线路径**：`expert` 不接入 UI，`hard` 仍是最高档。
后续方向见 `docs/ai-slice2-report.md` §6（先补评估、再做回合级 rollout）。
