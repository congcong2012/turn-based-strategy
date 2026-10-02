/**
 * AI 对战评估台（切片 0 立项，切片 1 扩充对照策略与行为指标）。
 *
 * 用法：
 *   npm run bench:ai                            # 默认矩阵（30 种子 × 座位互换 + 镜像局）
 *   npm run bench:ai -- --games 8 --pair hard:normal --out tmp/a.md   # 快速迭代
 *   npm run bench:ai -- --games 60 --seed 7 --out docs/ai-bench-full.md  # 换主种子复现
 *
 * 方法学：
 *  - 真实数据（src/data）+ 2 人图（defaultMapFor(2)）；
 *  - 每局一个独立 rng（hashSeed(masterSeed, gameIndex)），同参数可完整复现；
 *  - normal / hard 的多样性来自 TIE_EPSILON 平局打破（src/ai/index.ts）——
 *    没有它，确定性难度互打永远只有"座位互换"两个独立对局；
 *  - 胜率为 Wilson 95% 置信区间；样本量不足时区间会很宽，别过度解读。
 *
 * 对照策略（回答"新实现是否真的更强"）：
 *  - `v1-hard`：v2 开关全关的困难档快照（= 加 v2 之前的行为），回归对照；
 *  - `random`：在合法指令上均匀随机（不学不动），底线门槛；
 *  - 将来可加 turtle / rusher / greedy-capture 脚本对手（见 docs/ai-diagnosis.md §8）。
 *
 * 产物：控制台摘要 + 一份 markdown 报告。不进 CI：它是"手动衡量工具"。
 */

import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { nextCommand, nextCommandWith } from '../src/ai'
import type { AiProfile } from '../src/ai'
import { hashSeed, mulberry32 } from '../src/ai/rng'
import { applyCommand } from '../src/game/commands'
import { DATA, defaultMapFor } from '../src/game/data'
import { legalCommandsFor } from '../src/game/legalCommands'
import { createGame, currentPlayer } from '../src/game/state'
import type { Command, GameState, PlayerId } from '../src/game/types'

// ---------------------------------------------------------------- 策略

type Policy = (state: GameState, playerId: PlayerId, rng: () => number) => Command

/**
 * v1 困难档快照：v2 开关全部关闭 —— 与"加 v2 之前"的 hard 逐字一致。
 * 改动这里会让"新 hard vs v1-hard"的对照失去意义，所以数值写死。
 */
const V1_HARD: AiProfile = {
  noisy: false,
  focusFire: 0.6,
  cohesion: 3,
  lookaheadK: 12,
  deployPlan: ['sword', 'spear', 'sword'],
  v2: false,
  smartProduce: false,
  economy: 0,
  threat: 0,
  defend: 0,
  repair: 0,
  counter: 0,
  scoreAware: false,
}

/** 消融基准：打开 v2 语义，但所有具体开关关闭（用来单独衡量"有动作就做"这一改动） */
const V2_BASE: AiProfile = { ...V1_HARD, cohesion: 0, v2: true }

/**
 * v2 单项消融档案：定位"哪个开关在帮忙、哪个在帮倒忙"。
 * 每个档案只开一个开关（除 `v2-all` 为完整困难档），都从同一个基准出发 ——
 * 这样任何胜负差异都能归因到那一个开关上。
 */
const V2_VARIANTS: Record<string, AiProfile> = {
  'v2-actonly': { ...V2_BASE },
  'v2-eco': { ...V2_BASE, economy: 3 },
  'v2-threat': { ...V2_BASE, threat: 3 },
  'v2-defend': { ...V2_BASE, defend: 6 },
  'v2-supply': { ...V2_BASE, repair: 8 },
  'v2-produce': { ...V2_BASE, smartProduce: true, counter: 1 },
  'v2-score': { ...V2_BASE, scoreAware: true },
  /** 两个实测最有效的开关组合 */
  'v2-ed': { ...V2_BASE, economy: 3, defend: 6 },
  /** 经济权重加倍（看"更贪的经济"会不会更好） */
  'v2-eco5': { ...V2_BASE, economy: 5 },
  /** 温和威胁（配合"候选池剔除 wait"的结构修复后重测） */
  'v2-ed-t05': { ...V2_BASE, economy: 3, defend: 6, threat: 0.5 },
  /** 只缺威胁的完整档 */
  'v2-all-nothreat': {
    ...V2_BASE,
    smartProduce: true,
    economy: 3,
    defend: 6,
    repair: 8,
    counter: 1,
    scoreAware: true,
  },
  'v2-all': {
    ...V2_BASE,
    smartProduce: true,
    economy: 3,
    defend: 6,
    repair: 8,
    counter: 1,
    scoreAware: true,
  },
}

const POLICIES: Record<string, Policy> = {
  easy: (s, p, rng) => nextCommand(s, p, 'easy', DATA, rng),
  normal: (s, p, rng) => nextCommand(s, p, 'normal', DATA, rng),
  hard: (s, p, rng) => nextCommand(s, p, 'hard', DATA, rng),
  'v1-hard': (s, p, rng) => nextCommandWith(s, p, V1_HARD, DATA, rng),
  ...Object.fromEntries(
    Object.entries(V2_VARIANTS).map(([name, profile]) => [
      name,
      ((s: GameState, p: PlayerId, rng: () => number) => nextCommandWith(s, p, profile, DATA, rng)) as Policy,
    ]),
  ),
  /** 底线：在全部合法指令上均匀随机（消耗本局 rng，保持可复现） */
  random: (s, p, rng) => {
    if (s.phase === 'GAME_OVER') return { type: 'endTurn' }
    const cmds = legalCommandsFor(s, p, DATA)
    if (cmds.length === 0) return { type: 'endTurn' }
    return cmds[Math.floor(rng() * cmds.length)] ?? { type: 'endTurn' }
  },
}

// ---------------------------------------------------------------- 参数

interface BenchArgs {
  /** 每个对阵组合的种子数（再 ×2 座位互换 = 实际局数） */
  games: number
  /** 主种子：决定整批对局的全部随机性 */
  seed: number
  /** 报告输出路径 */
  out: string
  /** 单局步数保险丝（正常对局远低于此） */
  maxSteps: number
  /** 指定对阵（可重复）；为空则跑默认矩阵 + 镜像局 */
  pairs: Array<[string, string]>
}

const DEFAULT_PAIRS: Array<[string, string]> = [
  ['hard', 'normal'],
  ['hard', 'v1-hard'],
  ['hard', 'random'],
  ['normal', 'easy'],
  ['normal', 'random'],
  ['hard', 'easy'],
]

const DEFAULT_MIRRORS: Array<[string, string]> = [
  ['easy', 'easy'],
  ['normal', 'normal'],
  ['hard', 'hard'],
]

function parseArgs(argv: string[]): BenchArgs {
  const args: BenchArgs = { games: 30, seed: 20261002, out: 'docs/ai-baseline.md', maxSteps: 4000, pairs: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === '--games' && value) args.games = Math.max(1, Math.floor(Number(value)))
    else if (key === '--seed' && value) args.seed = Math.floor(Number(value))
    else if (key === '--out' && value) args.out = value
    else if (key === '--max-steps' && value) args.maxSteps = Math.max(100, Math.floor(Number(value)))
    else if (key === '--pair' && value) {
      const [a, b] = value.split(':')
      if (a && b) args.pairs.push([a, b])
    }
  }
  return args
}

// ---------------------------------------------------------------- 单局

interface GameResult {
  winner: PlayerId | null
  rounds: number
  steps: number
  finished: boolean
  /** 全场的据点易主次数与维修触发次数（行为指标） */
  captures: number
  repairs: number
}

/** 双方按各自策略打完整一局；每步决策耗时按策略名分桶记录（毫秒） */
function playGame(
  seats: [Policy, Policy],
  seatNames: [string, string],
  gameIndex: number,
  masterSeed: number,
  maxSteps: number,
  decisionMs: Record<string, number[]>,
): GameResult {
  const players: PlayerId[] = ['A', 'B']
  const policyOf: Record<PlayerId, Policy> = { A: seats[0], B: seats[1] }
  const nameOf: Record<PlayerId, string> = { A: seatNames[0], B: seatNames[1] }
  const rng = mulberry32(hashSeed('ai-bench', masterSeed, gameIndex))
  let state: GameState = createGame(defaultMapFor(2), players, DATA)
  let steps = 0
  let captures = 0
  let repairs = 0

  while (state.phase !== 'GAME_OVER' && steps < maxSteps) {
    steps += 1
    const player = state.phase === 'DEPLOY' ? state.players.find((p) => !state.deploy[p]?.done) : currentPlayer(state)
    if (!player) break
    const policy = policyOf[player]
    const ownersBefore = state.buildings.map((b) => b.owner).join(',')
    const t0 = performance.now()
    const cmd = policy(state, player, rng)
    const bucket = decisionMs[nameOf[player]] ?? (decisionMs[nameOf[player]] = [])
    bucket.push(performance.now() - t0)
    const result = applyCommand(state, player, cmd, DATA)
    if (!result.ok) throw new Error('评估台产出的指令非法: ' + JSON.stringify(cmd) + ' → ' + result.code)
    state = result.state
    if (state.buildings.map((b) => b.owner).join(',') !== ownersBefore) captures += 1
    if (result.events.some((e) => e.type === 'repair')) repairs += 1
  }
  return { winner: state.winner, rounds: state.round, steps, finished: state.phase === 'GAME_OVER', captures, repairs }
}

// ---------------------------------------------------------------- 统计

/** Wilson 95% 置信区间（对小样本 / 极端胜率比正态近似稳得多） */
function wilson(wins: number, total: number): [number, number] {
  if (total === 0) return [0, 0]
  const z = 1.96
  const p = wins / total
  const denom = 1 + (z * z) / total
  const center = (p + (z * z) / (2 * total)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom
  return [Math.max(0, center - half), Math.min(1, center + half)]
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((q / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

function pct(x: number): string {
  return (x * 100).toFixed(1) + '%'
}

function round1(x: number): string {
  return x.toFixed(1)
}

// ---------------------------------------------------------------- 对阵

interface PairRow {
  label: string
  games: number
  winsFirst: number
  winsSecond: number
  draws: number
  unfinished: number
  /** 先手（座位 0）胜场：衡量先后手平衡 */
  winsSeat0: number
  avgRounds: number
  avgSteps: number
  avgCaptures: number
  avgRepairs: number
}

function runPair(first: string, second: string, args: BenchArgs, decisionMs: Record<string, number[]>): PairRow {
  const row: PairRow = {
    label: first + ' vs ' + second,
    games: 0,
    winsFirst: 0,
    winsSecond: 0,
    draws: 0,
    unfinished: 0,
    winsSeat0: 0,
    avgRounds: 0,
    avgSteps: 0,
    avgCaptures: 0,
    avgRepairs: 0,
  }
  const policyFirst = POLICIES[first]
  const policySecond = POLICIES[second]
  if (!policyFirst || !policySecond) throw new Error('未知策略：' + (!policyFirst ? first : second))

  let gameIndex = 0
  for (let s = 0; s < args.games; s += 1) {
    // 同一对种子打两场：互换座位（先后手）。gameIndex 只增不减 → 每局 rng 独立
    for (const swap of [false, true]) {
      gameIndex += 1
      const seats: [Policy, Policy] = swap ? [policySecond, policyFirst] : [policyFirst, policySecond]
      const names: [string, string] = swap ? [second, first] : [first, second]
      const r = playGame(seats, names, hashSeed(first, second, gameIndex), args.seed, args.maxSteps, decisionMs)
      row.games += 1
      if (!r.finished) row.unfinished += 1
      if (r.winner === 'A') row.winsSeat0 += 1
      const winnerName = r.winner === 'A' ? names[0] : r.winner === 'B' ? names[1] : null
      if (winnerName === null) row.draws += 1
      else if (winnerName === first) row.winsFirst += 1
      else row.winsSecond += 1
      row.avgRounds += r.rounds
      row.avgSteps += r.steps
      row.avgCaptures += r.captures
      row.avgRepairs += r.repairs
    }
  }
  row.avgRounds /= row.games
  row.avgSteps /= row.games
  row.avgCaptures /= row.games
  row.avgRepairs /= row.games
  return row
}

function pairTable(rows: PairRow[], firstLabel = '前者'): string {
  return [
    '| 对阵 | 局数 | ' + firstLabel + '胜 | 后者胜 | 平 | ' + firstLabel + '胜率（95% CI） | 先手胜率 | 平均回合 | 占领/局 | 维修/局 |',
    '| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |',
    ...rows.map((r) => {
      const [lo, hi] = wilson(r.winsFirst, r.games)
      return (
        '| ' + r.label + ' | ' + r.games + ' | ' + r.winsFirst + ' | ' + r.winsSecond + ' | ' + r.draws +
        ' | ' + pct(r.winsFirst / r.games) + '（' + pct(lo) + '–' + pct(hi) + '）' +
        ' | ' + pct(r.winsSeat0 / r.games) +
        ' | ' + round1(r.avgRounds) + ' | ' + round1(r.avgCaptures) + ' | ' + round1(r.avgRepairs) + ' |'
      )
    }),
  ].join('\n')
}

/** 镜像表：同档自对弈时"前者/后者胜"无意义，有意义的分解是先手 vs 后手 */
function mirrorTable(rows: PairRow[]): string {
  const lines = [
    '| 对阵 | 局数 | 先手胜 | 后手胜 | 平 | 先手胜率（95% CI） | 平均回合 | 占领/局 | 维修/局 |',
    '| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |',
  ]
  for (const r of rows) {
    const seat1 = r.games - r.draws - r.unfinished - r.winsSeat0
    const [lo, hi] = wilson(r.winsSeat0, r.games)
    lines.push(
      '| ' + r.label + ' | ' + r.games + ' | ' + r.winsSeat0 + ' | ' + seat1 + ' | ' + r.draws +
      ' | ' + pct(r.winsSeat0 / r.games) + '（' + pct(lo) + '–' + pct(hi) + '）' +
      ' | ' + round1(r.avgRounds) + ' | ' + round1(r.avgCaptures) + ' | ' + round1(r.avgRepairs) + ' |',
    )
  }
  return lines.join('\n')
}

function timingTable(decisionMs: Record<string, number[]>): string {
  const lines = ['| 策略 | 决策次数 | p50 | p95 | max |', '| --- | ---: | ---: | ---: | ---: |']
  for (const name of Object.keys(decisionMs)) {
    const sorted = [...decisionMs[name]].sort((a, b) => a - b)
    if (sorted.length === 0) continue
    lines.push(
      '| ' + name + ' | ' + sorted.length + ' | ' + percentile(sorted, 50).toFixed(2) + 'ms | ' +
      percentile(sorted, 95).toFixed(2) + 'ms | ' + (sorted[sorted.length - 1] ?? 0).toFixed(2) + 'ms |',
    )
  }
  return lines.join('\n')
}

function gitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return '(未知)'
  }
}

// ---------------------------------------------------------------- 主流程

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const decisionMs: Record<string, number[]> = {}

  const started = Date.now()
  const pairs = args.pairs.length > 0 ? args.pairs : DEFAULT_PAIRS
  const pairRows = pairs.map(([a, b]) => runPair(a, b, args, decisionMs))
  const mirrorRows = args.pairs.length > 0 ? [] : DEFAULT_MIRRORS.map(([a, b]) => runPair(a, b, args, decisionMs))
  const wallSeconds = ((Date.now() - started) / 1000).toFixed(1)

  const ladderLines = pairRows
    .filter((r) => r.label.startsWith('hard vs '))
    .map((r) => {
      const rate = r.winsFirst / r.games
      return '- ' + (rate > 0.5 ? '✅' : '⚠️') + ' ' + r.label + '：hard 胜率 ' + pct(rate) + (rate > 0.5 ? '' : ' ← 未过半')
    })

  const report = [
    '# AI 对战评估报告',
    '',
    '- 生成时间：' + new Date().toISOString(),
    '- 代码版本：' + gitCommit(),
    '- 参数：每对阵 ' + args.games + ' 种子 × 2 座位互换；主种子 ' + args.seed + '；地图 defaultMapFor(2)；真实数据 src/data',
    '- 方法：每局独立 rng；normal/hard 的局间差异来自 TIE_EPSILON 平局打破；胜率为 Wilson 95% CI',
    '- 行为指标：占领/局（全场据点易主次数）、维修/局（据点回血触发次数）',
    '- 评估台总耗时：' + wallSeconds + 's',
    '',
    '## 对阵结果',
    '',
    pairTable(pairRows),
    '',
    ...(mirrorRows.length > 0 ? ['## 镜像对局（同档自对弈：观察先后手平衡与平局率）', '', mirrorTable(mirrorRows), ''] : []),
    '## 单步决策耗时（主线程实测）',
    '',
    timingTable(decisionMs),
    '',
    '## 结论',
    '',
    ...(ladderLines.length > 0 ? ladderLines : ['- （本次为指定对阵，未做阶梯判定）']),
    '',
  ].join('\n')

  mkdirSync(dirname(args.out), { recursive: true })
  writeFileSync(args.out, report)
  console.log(report)
  console.log('报告已写入 ' + args.out)
}

main()
