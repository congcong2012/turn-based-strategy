/**
 * 难度文案与界面归属 —— **设置页（单人练习）与联机大厅共用的一份**。
 *
 * 背景：难度分两层 —— **三档难度**（简单 / 普通 / 困难），其中「困难」再挂**两种算法模式**。
 * 为什么把原来的「困难」「极难」并成一组：这两者共用**同一套评估器**
 * （v2 开关逐字相同、评估器 v3 全关），唯一区别是**规划机制** ——
 *   - 快棋：固定深度的一步前瞻（挑 12 个最有希望的走法，逐个深克隆局面精确算收益）；
 *   - 深推演：回合级 rollout（替我把这一回合走完 → 把对手整个回合推演一遍 → 回头定第一步）。
 * 所以它们本来就是"同一个难度的两种算法"；并列成两档，玩家会误以为差别在"档位强度"上。
 *
 * 文案规则（AGENTS.md）：写"它会做什么"，而不是"它有多强"；模式还要**明确标注算法**。
 * 联机大厅（AI 补位 / 掉线托管选档）复用同一批名字，避免两处各写一份而走样。
 */

import { PLAYABLE_DIFFICULTIES } from '../ai'
import type { Difficulty, PlayableDifficulty } from '../ai'

/** 界面上的难度档 id（设置页与大厅共用） */
export type TierId = 'easy' | 'normal' | 'hard'
/** 「困难」档下的两种算法模式 */
export type HardModeId = 'lookahead' | 'rollout'

/**
 * 每个**可玩难度档**归到哪一档、叫什么名字。
 *
 * 这张表按 `PLAYABLE_DIFFICULTIES` 穷尽（`Record<PlayableDifficulty, ...>`）：
 * 将来某个档达标要上线时，只改 AI 层那张表，这里会因为缺键而**编译报错**，逼着补文案 —— 不会漏。
 * 档位顺序、模式列表都由它派生（见下），所以界面永远与"AI 层开放的档"一致。
 */
export const PLACEMENT: Record<
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
export const TIERS: TierId[] = [...new Set(PLAYABLE_DIFFICULTIES.map((d) => PLACEMENT[d].tier))]

/**
 * 三档难度各自的文案。
 *
 * 简单 / 普通这两档**直接复用 `PLACEMENT` 里那一档自己的文案**（同一份，不再抄一遍）；
 * 「困难」档要另写一句 —— 它自己的说明是"看得更远…"，而它的两种算法模式各有各的文案
 * （见 `HARD_MODE_OPTIONS`），两者不是一回事。
 */
export const TIER_COPY: Record<TierId, { label: string; hint: string }> = {
  easy: { label: PLACEMENT.easy.label, hint: PLACEMENT.easy.hint },
  normal: { label: PLACEMENT.normal.label, hint: PLACEMENT.normal.hint },
  hard: {
    label: '困难',
    hint: '看得更远；会经营军费、回防被抢的据点、给残血单位回补给，临近回合上限还会算分',
  },
}

export interface HardModeOption {
  /** 存档里写的内部难度 id */
  difficulty: PlayableDifficulty
  /** 模式标识（按钮 testid 用它，比难度 id 更贴近玩家看到的字） */
  mode: HardModeId
  label: string
  hint: string
}

/** 「困难」档下的两种算法模式：由 `PLACEMENT` 里归到「困难」的档派生，顺序同源 */
export const HARD_MODE_OPTIONS: HardModeOption[] = PLAYABLE_DIFFICULTIES.flatMap((difficulty) => {
  const entry = PLACEMENT[difficulty]
  if (entry.tier !== 'hard' || !entry.mode) return []
  return [{ difficulty, mode: entry.mode, label: entry.label, hint: entry.hint }]
})

/** 模式 → 展示名：文案里互相引用时用它，避免名字在多处硬编码 */
export function modeLabel(mode: HardModeId): string {
  return HARD_MODE_OPTIONS.find((o) => o.mode === mode)?.label ?? mode
}

/** 兜底算法模式（「快棋」）：深推演在多人局不可用时落回它 */
export const DEFAULT_HARD_DIFFICULTY: PlayableDifficulty =
  HARD_MODE_OPTIONS.find((o) => o.mode === 'lookahead')?.difficulty ?? 'hard'

/**
 * 某一档在**下拉框 / 一行文案**里的完整名字。
 *
 * 与 `PLACEMENT[d].label` 的区别：后者是"模式名"（快棋 / 深推演），
 * 这里带上它所属的档位（`困难 · 快棋`），因为「困难」之下的两档单看名字分不出层次。
 *
 * 参数放宽到 `Difficulty`：联机侧存的是 `Difficulty`（理论上还能出现未对玩家开放的档）。
 * 不认识的档原样返回 id —— 宁可显示得难看，也不要在这里抛错把大厅打白。
 */
export function difficultyOptionLabel(difficulty: Difficulty): string {
  const entry = PLACEMENT[difficulty as PlayableDifficulty] as
    | (typeof PLACEMENT)[PlayableDifficulty]
    | undefined
  if (!entry) return difficulty
  return entry.tier === 'hard' ? `${TIER_COPY.hard.label} · ${entry.label}` : entry.label
}
