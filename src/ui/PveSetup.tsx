/**
 * 单人练习（PVE）设置页：选对手数量 / 地图 / 我的阵营 / 难度 → 开始。
 *
 * 地图默认按对手数量自动挑（2 人用古道渡口，3–4 人用四战之地），
 * 也可以手动指定 —— 包括**地图编辑器做的自制地图**（可用的自制图会带「自制」标记）。
 *
 * "我的阵营 = 出生角"同时决定出手顺序：**0 号角先手**（内核里 players[0] 先行动）。
 */

import { useMemo, useState } from 'react'
import { defaultMapFor, getMap, hasMap } from '../game/data'
import type { MapDef } from '../game/data'
import type { Page } from '../app/route'
import type { PveConfig } from '../app/pveSession'
import { listPveMaps } from '../app/mapStore'
import { PLAYABLE_DIFFICULTIES } from '../ai'
import type { PlayableDifficulty } from '../ai'
import { AppFooter } from './AppFooter'

export interface PveSetupProps {
  onStart: (config: PveConfig) => void
  onNavigate: (page: Page) => void
  /** 从地图编辑器「用这张图开始单人练习」跳过来时，预选这张地图 */
  preferredMapId?: string
}

/** 按部署区在地图上的方位，给出生角一个人话名字（北/南/西北/东南…） */
function zoneLabel(map: MapDef, index: number): string {
  const zone = map.deployZones[index]
  if (!zone) return '第 ' + (index + 1) + ' 角'
  const vertical = zone.y1 < map.height / 2 ? '北' : zone.y0 > map.height / 2 ? '南' : ''
  const horizontal = zone.x1 < map.width / 2 ? '西' : zone.x0 > map.width / 2 ? '东' : ''
  if (horizontal && vertical) return horizontal + vertical
  if (vertical) return vertical + '方'
  if (horizontal) return horizontal + '侧'
  return '中部'
}

/**
 * 难度分两层：**三档难度**（简单 / 普通 / 困难），其中「困难」再挂**两种算法模式**。
 *
 * 为什么把原来的「困难」「极难」并成一组：这两者共用**同一套评估器**
 * （v2 开关逐字相同、评估器 v3 全关），唯一区别是**规划机制** ——
 *   - 快棋：固定深度的一步前瞻（挑 12 个最有希望的走法，逐个深克隆局面精确算收益）；
 *   - 深推演：回合级 rollout（替我把这一回合走完 → 把对手整个回合推演一遍 → 回头定第一步）。
 * 所以它们本来就是"同一个难度的两种算法"；并列成两档，玩家会误以为差别在"档位强度"上。
 *
 * 文案规则（AGENTS.md）：写"它会做什么"，而不是"它有多强"；模式还要**明确标注算法**。
 */
type TierId = 'easy' | 'normal' | 'hard'
/** 「困难」档下的两种算法模式 */
type HardModeId = 'lookahead' | 'rollout'

/**
 * 每个**可玩难度档**归到哪一档、叫什么名字。
 *
 * 这张表按 `PLAYABLE_DIFFICULTIES` 穷尽（`Record<PlayableDifficulty, ...>`）：
 * 将来某个档达标要上线时，只改 AI 层那张表，这里会因为缺键而**编译报错**，逼着补文案 —— 不会漏。
 * 档位顺序、模式列表都由它派生（见下），所以界面永远与"AI 层开放的档"一致。
 */
const PLACEMENT: Record<
  PlayableDifficulty,
  { tier: TierId; mode?: HardModeId; label: string; hint: string }
> = {
  easy: {
    tier: 'easy',
    label: '简单',
    hint: '出手随意，偶尔干脆不动；部署也随便摆',
  },
  normal: {
    tier: 'normal',
    label: '普通',
    hint: '会抢据点、挑性价比高的架打、集火残血；关键一步会算一下后果',
  },
  hard: {
    tier: 'hard',
    mode: 'lookahead',
    label: '快棋',
    hint: '一步前瞻 —— 挑出 12 个最有希望的走法，逐个摆上去、精确算出收益再选最好的。基本秒回',
  },
  oracle: {
    tier: 'hard',
    mode: 'rollout',
    label: '深推演',
    hint: '回合推演 —— 先替我走完这一回合，再把对手的整个回合推演一遍（他每步也按「快棋」挑棋），然后回头定第一步。平时几秒，后期大军团偶尔要等一两分钟',
  },
}

/** 玩家看到的难度档顺序：由 `PLACEMENT` 派生，声明顺序即展示顺序（简单 → 普通 → 困难） */
const TIERS: TierId[] = [...new Set(PLAYABLE_DIFFICULTIES.map((d) => PLACEMENT[d].tier))]

/**
 * 三档难度各自的文案。
 *
 * 简单 / 普通这两档**直接复用 `PLACEMENT` 里那一档自己的文案**（同一份，不再抄一遍）；
 * 「困难」档要另写一句 —— 它自己的说明是"看得更远…"，而它的两种算法模式各有各的文案
 * （见 `HARD_MODE_OPTIONS`），两者不是一回事。
 */
const TIER_COPY: Record<TierId, { label: string; hint: string }> = {
  easy: { label: PLACEMENT.easy.label, hint: PLACEMENT.easy.hint },
  normal: { label: PLACEMENT.normal.label, hint: PLACEMENT.normal.hint },
  hard: {
    label: '困难',
    hint: '看得更远；会经营军费、回防被抢的据点、给残血单位回补给，临近回合上限还会算分',
  },
}

interface HardModeOption {
  /** 存档里写的内部难度 id */
  difficulty: PlayableDifficulty
  /** 模式标识（按钮 testid 用它，比难度 id 更贴近玩家看到的字） */
  mode: HardModeId
  label: string
  hint: string
}

/** 「困难」档下的两种算法模式：由 `PLACEMENT` 里归到「困难」的档派生，顺序同源 */
const HARD_MODE_OPTIONS: HardModeOption[] = PLAYABLE_DIFFICULTIES.flatMap((difficulty) => {
  const entry = PLACEMENT[difficulty]
  if (entry.tier !== 'hard' || !entry.mode) return []
  return [{ difficulty, mode: entry.mode, label: entry.label, hint: entry.hint }]
})

/** 模式 → 展示名：文案里互相引用时用它，避免名字在多处硬编码 */
function modeLabel(mode: HardModeId): string {
  return HARD_MODE_OPTIONS.find((o) => o.mode === mode)?.label ?? mode
}

/** 兜底算法模式（「快棋」）：深推演在多人局不可用时落回它 */
const DEFAULT_HARD_DIFFICULTY: PlayableDifficulty =
  HARD_MODE_OPTIONS.find((o) => o.mode === 'lookahead')?.difficulty ?? 'hard'

/**
 * 「深推演」对应的档位。它在多人局不可用（见 `deepUnavailable`）；
 * 万一将来这张表里没有这个模式，下面的比较恒为 false —— 等价于"不存在深推演"，不会误判。
 */
const DEEP_HARD_DIFFICULTY = HARD_MODE_OPTIONS.find((o) => o.mode === 'rollout')?.difficulty

export function PveSetup({ onStart, onNavigate, preferredMapId }: PveSetupProps) {
  const [opponents, setOpponents] = useState(1)
  const [humanSeat, setHumanSeat] = useState(0)
  const [tier, setTier] = useState<TierId>('normal')
  /** 「困难」档选中的算法模式（用内部难度 id 表示，默认「快棋」） */
  const [hardDifficulty, setHardDifficulty] = useState<PlayableDifficulty>(DEFAULT_HARD_DIFFICULTY)
  // null = 按人数自动挑；有值 = 玩家手动选的地图
  const [pickedMapId, setPickedMapId] = useState<string | null>(preferredMapId ?? null)

  const total = opponents + 1

  /**
   * 「深推演」只在两人局成立。
   *
   * 它的机制是"我走完这回合 → **对手**走完这回合"再评估，这个前提在 3–4 人（多方博弈、非零和）
   * 里不成立，内核会保守回退到一步前瞻 —— 也就是「快棋」的算法。与其让玩家选一个"看起来更狠、
   * 其实一样"的模式，不如直接禁用并说明原因；玩家先选了深推演再把对手数调上去，这里会自动落回「快棋」。
   */
  const deepUnavailable = total > 2
  const effectiveHardDifficulty: PlayableDifficulty =
    deepUnavailable && hardDifficulty === DEEP_HARD_DIFFICULTY ? DEFAULT_HARD_DIFFICULTY : hardDifficulty
  /** 真正写进配置、交给会话的难度档 */
  const effectiveDifficulty: PlayableDifficulty = tier === 'hard' ? effectiveHardDifficulty : tier
  // 可选地图：内置 + 自制，且席位够用（例如 2 人图不会出现在 4 人局里）
  const candidates = useMemo(() => listPveMaps(total), [total])
  const autoMapId = defaultMapFor(total)
  // `hasMap` 是必须的：地图可能存在于本地列表却还没注册进运行时表，
  // 那时 getMap 会直接抛错把整页打成白屏。宁可回退到自动挑的内置图。
  const effectiveMapId =
    pickedMapId && hasMap(pickedMapId) && candidates.some((m) => m.id === pickedMapId)
      ? pickedMapId
      : autoMapId
  const map = getMap(effectiveMapId)
  const mapInfo = candidates.find((m) => m.id === effectiveMapId)
  const isCustomMap = mapInfo?.custom ?? false

  // 改变对手数量时，把阵营收敛到合法范围
  const seat = Math.min(humanSeat, total - 1)

  /** 3–4 人用四角图；3 人时会空出一角（该角王城为中立），这里明确告知玩家 */
  const neutralCornerHint =
    opponents === 2 ? '本局地图有 4 个角、只坐 3 方，空出的那一角会留下无主王城：占领后每回合多 1800 军费，但不淘汰任何人。' : null

  const seats = useMemo(() => Array.from({ length: total }, (_, i) => i), [total])

  const start = () => {
    onStart({
      opponents,
      humanSeat: seat,
      difficulty: effectiveDifficulty,
      mapId: effectiveMapId,
      // 种子决定"简单"难度抽到什么随机数；普通 / 困难是确定性策略。
      // 用时间戳保证每局不同，同时让同一局（含刷新恢复后）完全可复现。
      seed: Date.now() % 2147483647,
    })
  }

  return (
    <div className="app pve-setup" data-testid="pve-setup">
      <header className="app-header">
        <h1>单人练习</h1>
        <p className="muted">
          和本地 AI 打一局：<b>不需要联网、不需要服务器</b>。规则与联机对战完全一致。
        </p>
      </header>

      <section className="panel">
        <h2>对手数量</h2>
        <div className="unit-picker" data-testid="pve-opponents">
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              type="button"
              data-testid={'pve-opponents-' + n}
              className={opponents === n ? 'picked' : ''}
              onClick={() => setOpponents(n)}
            >
              <b>{n}</b> 个 AI
              <span className="muted small"> 共 {n + 1} 方</span>
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>地图</h2>
        <div className="unit-picker" data-testid="pve-map-picker">
          <button
            type="button"
            data-testid="pve-map-auto"
            className={pickedMapId === null ? 'picked' : ''}
            onClick={() => setPickedMapId(null)}
          >
            自动
            <span className="muted small"> 按人数挑（{getMap(autoMapId).name}）</span>
          </button>
          {candidates.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              data-testid={'pve-map-' + candidate.id}
              className={effectiveMapId === candidate.id ? 'picked' : ''}
              onClick={() => setPickedMapId(candidate.id)}
            >
              {candidate.name}
              {candidate.custom ? <span className="muted small"> 自制</span> : null}
              <span className="muted small"> {candidate.width}×{candidate.height} · {candidate.players} 方</span>
            </button>
          ))}
        </div>
        <p className="muted small" data-testid="pve-map-hint">
          当前：{mapInfo?.name ?? effectiveMapId}（{map.width}×{map.height}，{total} 方
          {isCustomMap ? ' · 自制地图' : ''}）
        </p>
        <button type="button" data-testid="pve-open-editor" onClick={() => onNavigate('editor')}>
          打开地图编辑器
        </button>
      </section>

      <section className="panel">
        <h2>我的阵营</h2>
        <p className="muted small">阵营（出生角）同时决定出手顺序：<b>0 号先手</b>。</p>
        <div className="unit-picker" data-testid="pve-seats">
          {seats.map((i) => (
            <button
              key={i}
              type="button"
              data-testid={'pve-seat-' + i}
              className={seat === i ? 'picked' : ''}
              onClick={() => setHumanSeat(i)}
            >
              {zoneLabel(map, i)}
              <span className="muted small"> {i === 0 ? '先手' : '后手'}</span>
            </button>
          ))}
        </div>
        {neutralCornerHint ? (
          <p className="muted small" data-testid="pve-neutral-hint">
            {neutralCornerHint}
          </p>
        ) : null}
      </section>

      <section className="panel">
        <h2>难度</h2>
        <div className="unit-picker" data-testid="pve-difficulty">
          {TIERS.map((value) => (
            <button
              key={value}
              type="button"
              data-testid={'pve-difficulty-' + value}
              className={tier === value ? 'picked' : ''}
              onClick={() => setTier(value)}
            >
              {TIER_COPY[value].label}
              <span className="muted small"> {TIER_COPY[value].hint}</span>
            </button>
          ))}
        </div>

        {tier === 'hard' ? (
          <div className="hard-mode" data-testid="pve-hard-modes">
            <p className="muted small" data-testid="pve-hard-modes-intro">
              「{TIER_COPY.hard.label}」有两种算法：<b>评估水平完全相同</b>，只差在
              <b>怎么算下一步</b>，照你想要的节奏挑一个。
            </p>
            <div className="unit-picker">
              {HARD_MODE_OPTIONS.map((option) => {
                const disabled = option.difficulty === DEEP_HARD_DIFFICULTY && deepUnavailable
                return (
                  <button
                    key={option.difficulty}
                    type="button"
                    data-testid={'pve-hard-mode-' + option.mode}
                    className={effectiveHardDifficulty === option.difficulty ? 'picked' : ''}
                    disabled={disabled}
                    onClick={() => setHardDifficulty(option.difficulty)}
                  >
                    {option.label}
                    <span className="muted small"> {option.hint}</span>
                  </button>
                )
              })}
            </div>
            {/* 如实标注强度：这一档没有达到项目自定的上线门槛，玩家有权知道 */}
            <p className="muted small" data-testid="pve-hard-mode-strength">
              如实标注：{modeLabel('rollout')}对「{modeLabel('lookahead')}」的实测胜率约 <b>62%</b>
              （120 局）—— 确实更强，但没达到本项目自定的 65% 门槛，优势不显著。想要出手快就选
              「{modeLabel('lookahead')}」。
            </p>
            {deepUnavailable ? (
              <p className="muted small" data-testid="pve-hard-mode-scope-hint">
                「{modeLabel('rollout')}」暂时只在<b>两人局</b>可选：它的做法是"我走完这回合，再把你这一整个回合推演一遍"，
                而 3 人以上是多方混战，这个前提不成立（会退回「{modeLabel('lookahead')}」的算法，选它反而名不副实）。
              </p>
            ) : null}
          </div>
        ) : null}

        <p className="muted small" data-testid="pve-difficulty-fairness">
          难度只改变 AI 的<b>决策水平</b>：AI 与你用<b>完全相同的规则</b>，
          军费、据点收入、单位上限、行动点一项都不多给 —— 不会靠加资源来"变强"。
        </p>
      </section>

      <section className="panel">
        <button type="button" className="primary block" data-testid="pve-start" onClick={start}>
          开始对局
        </button>
        <button type="button" className="block" data-testid="back-home" onClick={() => onNavigate('home')}>
          返回主页
        </button>
      </section>

      <AppFooter onNavigate={onNavigate} />
    </div>
  )
}
