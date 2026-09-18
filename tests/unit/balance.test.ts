/**
 * 经济平衡回归测试（M4）
 *
 * 背景：M3 之前 HQ 2000 / 兵营 500 / 村落 500、产能 1/营/回合、上限 20，
 * 玩家在第 13 回合就会满编，此后**收入没有任何消费渠道**，30 回合期末余额高达 10 万 —— 典型"钱花不完"。
 * 结论（模拟得出）：瓶颈不是产能，而是"上限打满后没有出口"，因此同时做了三件事：
 *   0. 据点收入重排：兵营 300 < 村落 400 < 王城 1200（村落是中立经济目标，收益高于开局就有的兵营）
 *   1. 降产出（HQ 1200 / 兵营 300 / 村落 400）
 *   2. 提产能（每座兵营每回合 2 单，第二个落在相邻空格）
 *   3. 放宽上限（20 → 32）
 * 本文件用**真实 src/data/*.json** 跑模拟，把结论固化成断言，防止以后调数值时回退。
 *
 * 运行：pnpm exec vitest run tests/unit/balance.test.ts
 */
import { describe, expect, it } from 'vitest'
import { DATA } from '../../src/game/data'

interface EcoConfig {
  name: string
  hq: number
  barracks: number
  village: number
  perBarracks: number
  cap: number
  startFunds: number
}

interface Row { round: number; villages: number; income: number; spend: number; funds: number; army: number }

const BARRACKS_PER_PLAYER = 2
const ROUNDS = 30
const VILLAGES_PER_SIDE = 6

function simulate(cfg: EcoConfig): { rows: Row[]; capRound: number | null; finalFunds: number; totalIncome: number; totalSpend: number } {
  const costs = DATA.unitList.map((u) => u.cost).sort((a, b) => b - a)
  let funds = cfg.startFunds
  let army = 0
  let villages = 0
  const rows: Row[] = []
  let capRound: number | null = null
  let totalIncome = 0
  let totalSpend = 0

  for (let round = 1; round <= ROUNDS; round += 1) {
    // 占领节奏：每 2 回合拿下一座中立村落，上限 6 座
    if (round % 2 === 0 && villages < VILLAGES_PER_SIDE) villages += 1

    const income = cfg.hq + cfg.barracks * BARRACKS_PER_PLAYER + cfg.village * villages
    funds += income
    totalIncome += income

    // 贪心：每个空闲生产位都买"买得起的最贵兵种"
    let spend = 0
    let slots = BARRACKS_PER_PLAYER * cfg.perBarracks
    while (slots > 0 && army < cfg.cap) {
      const pick = costs.find((c) => c <= funds)
      if (pick === undefined) break
      funds -= pick
      spend += pick
      totalSpend += pick
      army += 1
      slots -= 1
    }
    rows.push({ round, villages, income, spend, funds, army })
    if (capRound === null && army >= cfg.cap) capRound = round
  }
  return { rows, capRound, finalFunds: funds, totalIncome, totalSpend }
}

/** 当前真实配置（直接读 src/data/*.json，改数值会立刻反映到断言里） */
function liveConfig(): EcoConfig {
  return {
    name: '当前配置',
    hq: DATA.buildings.hq.income,
    barracks: DATA.buildings.barracks.income,
    village: DATA.buildings.village.income,
    perBarracks: DATA.rules.unitsPerBarracksPerTurn,
    cap: DATA.rules.unitCap,
    startFunds: DATA.rules.startFunds,
  }
}

/** M3 之前的旧配置（保留为对照，证明问题真实存在过） */
function oldConfig(): EcoConfig {
  return { name: 'M3 旧配置', hq: 2000, barracks: 500, village: 500, perBarracks: 1, cap: 20, startFunds: 4000 }
}

function report(cfg: EcoConfig) {
  const r = simulate(cfg)
  console.log('\n--- ' + cfg.name + ' ---')
  console.log('回合  村落   收入   支出    余额   兵力')
  for (const row of r.rows) {
    if (row.round % 5 !== 0 && row.round !== 1) continue
    const pad = (n: number) => String(n).padStart(6, ' ')
    console.log(String(row.round).padStart(4) + pad(row.villages) + pad(row.income) + pad(row.spend) + pad(row.funds) + pad(row.army))
  }
  console.log('期末余额 ' + r.finalFunds + ' · 触顶回合 ' + (r.capRound ?? '未触顶') + ' · 总支出 ' + r.totalSpend + '/' + r.totalIncome)
  return r
}

describe('经济平衡（读真实 src/data/*.json）', () => {
  it('旧配置确实"钱花不完"（问题基线）', () => {
    const old = simulate(oldConfig())
    expect(old.capRound).not.toBeNull()
    expect(old.capRound as number).toBeLessThanOrEqual(15) // 很早就满编
    expect(old.finalFunds).toBeGreaterThan(50000) // 之后收入全部变成死钱
  })

  it('当前配置：满编来得晚、期末余额可控、基础收入不足以长期过剩', () => {
    const live = report(liveConfig())

    // 1) 不会早早满编（否则后期又没事可做）
    expect(live.capRound === null || live.capRound >= 22).toBe(true)
    // 2) 期末闲置资金不超过约 3 回合收入（满编发生在第 28 回合，之后只剩 2 回合可花）
    const lateIncome = live.rows[live.rows.length - 1].income
    expect(live.finalFunds).toBeLessThanOrEqual(lateIncome * 3)
    // 3) 只靠基础收入也养不起两座兵营满负荷造最便宜兵种 → 村落争夺有实际价值
    const baseIncome = DATA.buildings.hq.income + DATA.buildings.barracks.income * BARRACKS_PER_PLAYER
    const cheapest = Math.min(...DATA.unitList.map((u) => u.cost))
    const maxSpend = BARRACKS_PER_PLAYER * DATA.rules.unitsPerBarracksPerTurn * cheapest
    expect(baseIncome).toBeLessThan(maxSpend)
    // 4) 上限放宽后，中期（第 15 回合）不该出现巨额闲置资金
    const midGame = live.rows.find((r) => r.round === 15)
    expect(midGame?.funds ?? 0).toBeLessThan(6000)
  })

  it('据点收入关系：兵营 < 村落 < 王城（村落是需要争夺的经济目标）', () => {
    // 兵营的价值在产能（开局就有），村落是中立、需要占领的经济目标，因此收益更高
    expect(DATA.buildings.barracks.income).toBeLessThan(DATA.buildings.village.income)
    expect(DATA.buildings.village.income).toBeLessThan(DATA.buildings.hq.income)
  })
})
