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
 * 难度文案：**行为差异要能被玩家感知**（AGENTS.md 的规则要求），
 * 所以每一档写的都是"它会做什么"，而不是"它有多强"。
 *
 * 这张表按 `PLAYABLE_DIFFICULTIES` 穷尽（`Record<PlayableDifficulty, ...>`）：将来某个档
 * 达标要上线时，只改 AI 层那张表，这里会因为缺键而**编译报错**，逼着补文案 —— 不会漏。
 */
const DIFFICULTY_COPY: Record<PlayableDifficulty, { label: string; hint: string }> = {
  easy: {
    label: '简单',
    hint: '出手随意，偶尔干脆不动；部署也随便摆',
  },
  normal: {
    label: '普通',
    hint: '会抢据点、挑性价比高的架打、集火残血；关键一步会算一下后果',
  },
  hard: {
    label: '困难',
    hint: '看得更远；会经营军费、回防被抢的据点、给残血单位回补给，临近回合上限还会算分',
  },
}

const DIFFICULTY_OPTIONS = PLAYABLE_DIFFICULTIES.map((value) => ({
  value,
  ...DIFFICULTY_COPY[value],
}))

export function PveSetup({ onStart, onNavigate, preferredMapId }: PveSetupProps) {
  const [opponents, setOpponents] = useState(1)
  const [humanSeat, setHumanSeat] = useState(0)
  const [difficulty, setDifficulty] = useState<PlayableDifficulty>('normal')
  // null = 按人数自动挑；有值 = 玩家手动选的地图
  const [pickedMapId, setPickedMapId] = useState<string | null>(preferredMapId ?? null)

  const total = opponents + 1
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
      difficulty,
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
          {DIFFICULTY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              data-testid={'pve-difficulty-' + option.value}
              className={difficulty === option.value ? 'picked' : ''}
              onClick={() => setDifficulty(option.value)}
            >
              {option.label}
              <span className="muted small"> {option.hint}</span>
            </button>
          ))}
        </div>
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
