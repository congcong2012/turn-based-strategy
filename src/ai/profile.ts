/**
 * AI 难度档案（策略表）。
 *
 * 从 `index.ts` 抽出（切片 2）：搜索层 `search.ts` 也需要读策略参数，
 * 若把它留在 `index.ts` 会形成 `index ↔ search` 的循环依赖，故独立成模块。
 * `index.ts` 仍对外 re-export 这些名字，外部 import 路径不变。
 *
 * 关键：`easy` / `normal` 的取值**刻意与"加 v2 之前"逐字一致** ——
 * 加上 v2 开关后同样遵守这条（这两档的 v2 开关全部为 0 / false，行为零变化）。
 *
 * 困难档靠什么变强？实测（`scripts/ai-bench.ts`，真实地图，60 局/对阵）：
 *  - v1 的 hard 只把前瞻候选 5 → 12 并打开 `cohesion`，结果在真实地图上**倒挂**：
 *    hard 仅 11.7% 胜 normal（`docs/ai-baseline.md`）。根因是评估器把经济压到噪声级
 *    （村落值 200 分 < 一次攻击 220 分），而 cohesion 又惩罚分散占点。
 *  - v2 改为五类开关（经济 / 威胁 / 守土 / 补给 / 比分）+ 生产按性价比与克制选兵，
 *    `cohesion` 归零，实测把 hard 掰正到 83.3% 胜 normal（`docs/ai-bench-slice1.md`）。
 *
 * 曾试过"第二步：扣掉对手回手威胁"的手工惩罚项，反而退回 50% —— 过度保守，已放弃；
 * 对手建模改由 v2 的**零和威胁项**（双方同额度）承担，避免拍脑袋的单侧惩罚。
 */

import type { EvaluateWeights } from './evaluate'

export type Difficulty = 'easy' | 'normal' | 'hard' | 'master' | 'expert' | 'oracle'

/**
 * **对玩家开放**（设置页能选到）的难度档 —— 运行时单一事实源。
 *
 * 规则：只有**实测达到强度门槛**、且行为差异能被玩家感知的档才允许写进这里。
 * `master` / `expert` / `oracle` 都还留在 `PROFILES` 里但**刻意不暴露**
 * （实测未达门槛，见 `docs/ai-difficulty.md`）。
 *
 * 设置页的选项顺序、以及存档里"哪些难度算合法"都由它派生 ——
 * 将来某个档达标要上线时，**只改这一处**即可，UI 与存档校验会一起跟上。
 */
export const PLAYABLE_DIFFICULTIES = ['easy', 'normal', 'hard'] as const

export type PlayableDifficulty = (typeof PLAYABLE_DIFFICULTIES)[number]

/** 判断一个值是不是"对玩家开放"的难度档（存档校验用） */
export function isPlayableDifficulty(value: unknown): value is PlayableDifficulty {
  return typeof value === 'string' && (PLAYABLE_DIFFICULTIES as readonly string[]).includes(value)
}

/** 部署计划：3 个兵刚好用满 3000 预算 */
export const DEPLOY_PLAN = ['sword', 'spear', 'sword']

export interface AiProfile {
  /** 弱档：决策带噪（随机挑、偶尔漏操作、部署随意） */
  noisy: boolean
  /** 集火权重：乘在"残血目标价值"上（越大越执着于补刀） */
  focusFire: number
  /** 抱团权重：向己方单位重心靠拢才有的分（0 = 不抱团；**v2 起困难档不再使用**） */
  cohesion: number
  /** 精确比较（每个候选深克隆一次状态）的候选数上限 */
  lookaheadK: number
  /** 部署计划；空数组表示"随机部署" */
  deployPlan: string[]
  /** v2 标记：启用 v2 的"有动作就做"语义（不再因启发式分为负而过手） */
  v2: boolean
  /** v2 生产策略：按"每千军费战力 + 克制 + 占领手缺口"选兵（关闭则沿用 v1 的"越贵越优先"） */
  smartProduce: boolean
  /** v2 经济：据点收入的时间价值权重（0 = v1 行为） */
  economy: number
  /** v2 威胁：预计承受伤害的惩罚权重（0 = v1 的粗糙"2 格内敌人数"） */
  threat: number
  /** v2 守土：敌方占领进度的紧急度（0 = 完全不管） */
  defend: number
  /** v2 补给：残血单位驻守己方据点的价值（0 = 完全不管） */
  repair: number
  /** v2 克制：出兵时按"对敌阵平均伤害"加权的强度（0 = 只按造价） */
  counter: number
  /** v2 比分：临近回合上限时按 GDD 9.2 计分表算账 */
  scoreAware: boolean

  // —— 切片 3（评估器 v3）：默认 0，只有 master / expert 打开 ——

  /** E1：`pending`（已付费未出场）按造价的这个比例计入材料分 */
  pendingMaterial: number
  /** E2：兵种克制的价值 —— 单位"对敌阵平均伤害"折算的系数 */
  counterValue: number
  /** E3：远程单位"能打到敌、而敌打不到我"的站位加成（× 造价） */
  rangedSafety: number
  /** E4：暴露面 —— 仅"会被打死"档触发（× 造价） */
  exposure: number

  // —— 切片 2：搜索层参数（0 = 不搜索，走原 1 步前瞻路径） ——

  /**
   * 搜索深度上限（层 / ply，每个 ply = 一条指令）。
   * 仅在**两人局**生效：`players.length === 2` 时极小极大的"对手 = 另一人"才成立；
   * 3–4 人局是非零和，本切片保守地回退到 1 步前瞻（即 hard 的行为）。
   */
  searchDepth: number
  /** 根层（我的第一步）候选上限：按启发式排序后保留前 N 条 */
  beamWidth: number
  /**
   * 深层（根层以下的每一层，**既包括我的后续步、也包括对手的步**）候选上限。
   *
   * 为什么深层要比根层窄得多：本作一个 ply = 一条指令，且**未结束回合时先后手不变** ——
   * 所以根层以下的节点大多"还是我自己在动"。若每层都按根层的宽度展开，
   * 树会按 `beamWidth^depth` 爆炸（16³ ≈ 4k 节点），预算永远搜不完第 3 层，
   * 而第 3 层恰恰是"我收手 → 对手回手"唯一可能出现的地方。
   * 收窄深层后 3 层的节点上界 ≈ root + root×inner + root×inner² ≈ 500，可完整搜完。
   */
  innerBeamWidth: number
  /**
   * 单条指令的**候选枚举次数上限**（确定性安全阀）。
   *
   * 为什么除了 `nodeBudget` 还要它：实测（`docs/ai-bench-slice2.md`）真正的耗时大头是
   * `playCommandsFor` 的 Dijkstra + 全量打分，而它的成本随军团规模暴涨（后期 47 个单位、
   * 700+ 候选时，**一次枚举 ≈10ms**，是叶子评估 0.06ms 的上百倍）。
   * 只按叶子计数根本挡不住"枚举太多"：实测单步最坏曾到 1475ms。
   * 因此再按"枚举次数"封顶 —— 两者都超限就丢弃当前深度、退回上一层的结果。
   */
  expansionBudget: number
  /**
   * 单条指令的**叶子预算**（确定性"时间盒"）。
   *
   * 为什么不用墙钟：本项目要求"刷新后 AI 逐帧可复现"，决策必须是
   * `(state, playerId, difficulty, seed)` 的纯函数；墙钟会让同一局面在不同负载下
   * 搜到不同深度 → 复现失效。节点计数是确定性的，配合实测延迟校准即可。
   */
  nodeBudget: number

  // —— 切片 4：回合级 rollout（0 = 不启用） ——

  /**
   * rollout 时"我这一回合"最多再走几条指令（`0` = 不替我走完这一回合）。
   * 起点指令之后，我按启发式贪心把回合走完，这样评估的是"我的计划执行完"的局面。
   */
  rolloutMySteps: number
  /** rollout 时"对手这一回合"最多走几条指令 —— **本机制的核心**：看见对手整整一回合的动态 */
  rolloutFoeSteps: number
  /**
   * 对手回合内每一步的挑棋方式：`0` = 纯启发式贪心；`>0` = 用该宽度的 **1 步前瞻**（与 `hard` 一致）。
   * 用贪心会低估威胁（贪心比 hard 弱），从而让 AI 过于自信。
   */
  rolloutFoeLookahead: number
  /** 单条指令的**候选枚举次数上限**（rollout 的成本大头同样是枚举，故同样封顶） */
  rolloutBudget: number
}

/** 不打开任何 v2 开关的默认值（easy / normal 逐字沿用 v1 行为） */
const V1_SWITCHES = {
  v2: false,
  smartProduce: false,
  economy: 0,
  threat: 0,
  defend: 0,
  repair: 0,
  counter: 0,
  scoreAware: false,
} as const

/** 不启用搜索（easy / normal / hard 走原 1 步前瞻路径，行为与切片 1 逐字一致） */
const SEARCH_OFF = {
  searchDepth: 0,
  beamWidth: 0,
  innerBeamWidth: 0,
  nodeBudget: 0,
  expansionBudget: 0,
} as const

/**
 * 评估器 v3 的开关，默认全关 —— 关掉时 `evaluate` 的返回值与切片 1 **逐字一致**，
 * 因此 easy / normal / hard 与全部既有单测都不受影响。
 */
const V3_EVAL_OFF = {
  pendingMaterial: 0,
  counterValue: 0,
  rangedSafety: 0,
  exposure: 0,
} as const

/** 不启用回合级 rollout（easy / normal / hard / master / expert 走各自原路径） */
const ROLLOUT_OFF = {
  rolloutMySteps: 0,
  rolloutFoeSteps: 0,
  rolloutFoeLookahead: 0,
  rolloutBudget: 0,
} as const

/**
 * 回合级 rollout 的参数（`oracle` 档使用）。
 * 由 `docs/ai-bench-rollout.md` 的实测校准：根候选 6 条、我走完 6 步、对手走完 8 步。
 */
const ROLLOUT_ON = {
  rolloutMySteps: 6,
  rolloutFoeSteps: 8,
  rolloutFoeLookahead: 8,
  rolloutBudget: 140,
} as const

/**
 * 评估器 v3 的取值（`master` 档使用）。含义：
 *  - `pendingMaterial 0.8`：下单即计入 80% 造价的材料分（修"下单即亏分"）
 *  - `counterValue 2`：每 1 点"对敌阵平均伤害"值 2 分（兵种克制的价值）
 *  - `rangedSafety 0.2`：远程单位"能打敌、敌打不到我"按造价 20% 加分
 *  - `exposure 0.5`：会被打死的暴露位按造价 50% 扣分（仅致命档）
 * 这几个具体数值由 `npm run bench:ai` 的逐项消融校准，见 `docs/ai-bench-eval.md`。
 */
const V3_EVAL_ON = {
  pendingMaterial: 0.8,
  counterValue: 2,
  rangedSafety: 0.2,
  exposure: 0.5,
} as const

export const PROFILES: Record<Difficulty, AiProfile> = {
  easy: { noisy: true, focusFire: 0.15, cohesion: 0, lookaheadK: 0, deployPlan: [], ...V1_SWITCHES, ...SEARCH_OFF, ...V3_EVAL_OFF, ...ROLLOUT_OFF },
  normal: {
    noisy: false,
    focusFire: 0.15,
    cohesion: 0,
    lookaheadK: 5,
    deployPlan: DEPLOY_PLAN,
    ...V1_SWITCHES,
    ...SEARCH_OFF,
    ...V3_EVAL_OFF,
    ...ROLLOUT_OFF,
  },
  hard: {
    noisy: false,
    focusFire: 0.6,
    cohesion: 0,
    lookaheadK: 12,
    deployPlan: DEPLOY_PLAN,
    v2: true,
    smartProduce: true,
    economy: 3,
    // 威胁项**暂不启用**：实测（v2-threat 单项消融 vs normal，16 局）0 胜率 ——
    // 多家围攻相乘后该惩罚达到 ±几千分，压过材料项，AI 变成"择地躲避"而不推进；
    // 0.5 的温和档也没有增益（62.5% vs 68.8%）。风险判断改由切片 2 的真搜索承担。
    threat: 0,
    defend: 6,
    repair: 8,
    counter: 1,
    scoreAware: true,
    ...SEARCH_OFF,
    ...V3_EVAL_OFF,
    ...ROLLOUT_OFF,
  },
  /**
   * 大师档（切片 3 · 评估器 v3）：**在 `hard` 之上只打开评估器 v3 的四个开关**，不加搜索。
   *
   * 为什么要单独留一档：把"评估改进"与"搜索改进"的功劳拆开 ——
   * `master vs hard` 衡量评估，`expert vs master` 衡量搜索（两者评估开关完全一致）。
   * 与 `expert` 一样**暂不接入 UI**（`PveSetup` / `pveStore` 仍只有三档）。
   */
  master: {
    noisy: false,
    focusFire: 0.6,
    cohesion: 0,
    lookaheadK: 12,
    deployPlan: DEPLOY_PLAN,
    v2: true,
    smartProduce: true,
    economy: 3,
    threat: 0,
    defend: 6,
    repair: 8,
    counter: 1,
    scoreAware: true,
    ...SEARCH_OFF,
    ...V3_EVAL_ON,
    ...ROLLOUT_OFF,
  },
  /**
   * 神谕档（切片 4 · 回合级 rollout）：**评估用 `hard` 那一套（v3 全关）+ 回合级 rollout**。
   *
   * 为什么评估退回 hard 的：v3 四项已被实测证否（`master` 仅 53.3% 胜 hard），
   * 因此本档**只改机制**，把"评估"这个变量按住不动，才能干净地回答"回合级 rollout 值不值"。
   * 与 `master` / `expert` 一样**暂不接入 UI**（`PveSetup` / `pveStore` 仍只有三档）。
   */
  oracle: {
    noisy: false,
    focusFire: 0.6,
    cohesion: 0,
    lookaheadK: 12,
    deployPlan: DEPLOY_PLAN,
    v2: true,
    smartProduce: true,
    economy: 3,
    threat: 0,
    defend: 6,
    repair: 8,
    counter: 1,
    scoreAware: true,
    ...SEARCH_OFF,
    ...V3_EVAL_OFF,
    // 根候选宽度沿用 beamWidth（6 条）
    beamWidth: 6,
    ...ROLLOUT_ON,
  },
  /**
   * 专家档 = **`master`（评估器 v3）+ 搜索层**。
   *
   * 归因设计：`expert` 与 `master` 的评估开关逐字相同，唯一差别是搜索 → `expert vs master`
   * 干净地衡量"搜索值多少分"；`master` 与 `hard` 的差别只在评估 → `master vs hard` 衡量评估。
   *
   * ⚠️ **切片 2 验收未通过**：在**旧评估**下 expert 仅 51.7% 胜 hard（60 局，CI 39.3–63.8%），
   * 远低于 ≥70% 门槛；换 beam 配置更差（31.3%）。结论：搜索放大不了评估的短板 —— 先补评估
   * （切片 3），再重测（见 `docs/ai-slice2-report.md` / `docs/ai-eval-report.md`）。
   * 因此本档**默认不接入 UI**（`PveSetup` / `pveStore` 仍只有三档）。
   */
  expert: {
    noisy: false,
    focusFire: 0.6,
    cohesion: 0,
    lookaheadK: 12,
    deployPlan: DEPLOY_PLAN,
    v2: true,
    smartProduce: true,
    economy: 3,
    threat: 0,
    defend: 6,
    repair: 8,
    counter: 1,
    scoreAware: true,
    // 评估器 v3：与 `master` 完全一致 —— 这样 `expert vs master` 只差"搜索"这一件事，归因干净。
    ...V3_EVAL_ON,
    // 迭代加深到 3 层（3 层是"能看到对手回手"的最小深度：root 我 → 我收手 → 对手）。
    // 成本 ≈ 枚举次数 × 单次枚举耗时（1–10ms，随军团规模变化），因此两个预算一起封顶：
    //   枚举上限 72 → 3 层需要 10 + 10×5 = 60 次枚举，能搜完且有余量；
    //   叶子上限 1200 → 3 层的叶子不过数百，远不吃紧。
    // 实测单步 p50 ≈ 数十 ms、最坏 ≈ 数百 ms（真实地图，含 47 单位的大军团），
    // 40 条/回合的最坏值 <30s（见 docs/ai-bench-slice2.md）。
    searchDepth: 3,
    beamWidth: 10,
    innerBeamWidth: 3,
    expansionBudget: 72,
    nodeBudget: 1200,
    ...ROLLOUT_OFF,
  },
}

/** 取某档难度的策略参数（返回副本，防止外部误改策略表；对战评估台用它构造对照档案） */
export function profileFor(difficulty: Difficulty): AiProfile {
  return { ...PROFILES[difficulty] }
}

/** 把策略参数翻译成评估权重（v2/v3 开关与评估器的接线只在这一处） */
export function evalWeights(profile: AiProfile): EvaluateWeights {
  return {
    cohesion: profile.cohesion,
    economy: profile.economy,
    threat: profile.threat,
    defend: profile.defend,
    repair: profile.repair,
    scoreAware: profile.scoreAware,
    pendingMaterial: profile.pendingMaterial,
    counterValue: profile.counterValue,
    rangedSafety: profile.rangedSafety,
    exposure: profile.exposure,
  }
}
