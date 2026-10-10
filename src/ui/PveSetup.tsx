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
import { DEEP_DIFFICULTY, isDifficultyUsable } from '../ai'
import type { PlayableDifficulty } from '../ai'
import { DEFAULT_MODEL } from '../ai/advisor/client'
import {
  DEFAULT_ADVISOR_SETTINGS,
  loadAdvisorSettings,
  saveAdvisorSettings,
} from '../ai/advisor/settings'
import type { AdvisorSettings } from '../ai/advisor/settings'
import {
  DEFAULT_HARD_DIFFICULTY,
  HARD_MODE_OPTIONS,
  TIER_COPY,
  TIERS,
  modeLabel,
} from './difficultyCopy'
import type { TierId } from './difficultyCopy'
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

// 难度文案与界面归属在 `./difficultyCopy`（**与联机大厅共用同一份**，避免两处各写一套而走样）。
// 这里只负责渲染：三档难度卡 + 选中「困难」时展开的两种算法模式。


export function PveSetup({ onStart, onNavigate, preferredMapId }: PveSetupProps) {
  const [opponents, setOpponents] = useState(1)
  const [humanSeat, setHumanSeat] = useState(0)
  const [tier, setTier] = useState<TierId>('normal')
  /** 「困难」档选中的算法模式（用内部难度 id 表示，默认「快棋」） */
  const [hardDifficulty, setHardDifficulty] = useState<PlayableDifficulty>(DEFAULT_HARD_DIFFICULTY)
  // null = 按人数自动挑；有值 = 玩家手动选的地图
  const [pickedMapId, setPickedMapId] = useState<string | null>(preferredMapId ?? null)

  // ── AI 参谋（可选）：本机偏好，独立于本局配置，存在 localStorage ──────────
  // 首帧同步读一次设置，这样开关的初始状态就是玩家上次保存的。
  const [advisor, setAdvisor] = useState<AdvisorSettings>(() => loadAdvisorSettings())
  /** 折叠的高级项（接口地址 / 模型） */
  const [showAdvanced, setShowAdvanced] = useState(false)

  /**
   * 改设置即存。
   *
   * ⚠️ 写入刻意放在 `setState` **之外**、用 `advisor` 现算，而不是放进 updater 里 ——
   *  React 严格模式下 updater 可能被调用两次，在 updater 里做副作用（写 localStorage）
   *  会写入不一致的中间值；更糟的是"在 effect 清理函数里存"的写法会用**上一次**的
   *  `advisor` 覆盖掉刚改好的值（实测：勾选开关后存进去的仍是 `enabled:false`）。
   */
  const patchAdvisor = (patch: Partial<AdvisorSettings>) => {
    const next = { ...advisor, ...patch }
    setAdvisor(next)
    saveAdvisorSettings(next)
  }

  const total = opponents + 1

  /**
   * 「深推演」只在两人局成立 —— 规则本身在 AI 层（`src/ai/profile.ts` 的
   * `isDifficultyUsable`），单人练习与联机大厅共用同一条，别在这里另写一份。
   *
   * 它的机制是"我走完这回合 → **对手**走完这回合"再评估，这个前提在 3–4 人（多方博弈、非零和）
   * 里不成立，内核会保守回退到一步前瞻 —— 也就是「快棋」的算法。与其让玩家选一个"看起来更狠、
   * 其实一样"的模式，不如直接禁用并说明原因；玩家先选了深推演再把对手数调上去，这里会自动落回「快棋」。
   */
  const deepUnavailable = !isDifficultyUsable(DEEP_DIFFICULTY, total)
  const effectiveHardDifficulty: PlayableDifficulty =
    deepUnavailable && hardDifficulty === DEEP_DIFFICULTY ? DEFAULT_HARD_DIFFICULTY : hardDifficulty
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
                const disabled = option.difficulty === DEEP_DIFFICULTY && deepUnavailable
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

      <section className="panel advisor-panel" data-testid="pve-advisor">
        <h2>
          AI 参谋 <span className="muted small">（可选 · 默认关闭）</span>
        </h2>
        <label className="advisor-toggle">
          <input
            type="checkbox"
            data-testid="pve-advisor-enabled"
            checked={advisor.enabled}
            onChange={(e) => patchAdvisor({ enabled: e.target.checked })}
          />
          <span>
            让大模型当<b>军师</b>：每回合给 AI 一份「作战倾向」（<b>更激进 / 更保守</b>、
            重视经济还是防守…），再由 AI 自己的推演系统去执行。
          </span>
        </label>

        {advisor.enabled ? (
          <div className="advisor-body" data-testid="pve-advisor-body">
            <label className="advisor-field">
              <span className="advisor-label">API Key</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-..."
                data-testid="pve-advisor-key"
                value={advisor.apiKey}
                onChange={(e) => patchAdvisor({ apiKey: e.target.value })}
              />
            </label>

            <button
              type="button"
              className="advisor-advanced-toggle"
              data-testid="pve-advisor-advanced-toggle"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? '收起服务器设置' : '服务器设置（一般不用改）'}
            </button>

            {showAdvanced ? (
              <div className="advisor-advanced" data-testid="pve-advisor-advanced">
                <label className="advisor-field">
                  <span className="advisor-label">接口地址</span>
                  <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={DEFAULT_ADVISOR_SETTINGS.baseUrl}
                    data-testid="pve-advisor-baseurl"
                    value={advisor.baseUrl}
                    onChange={(e) => patchAdvisor({ baseUrl: e.target.value })}
                  />
                </label>
                <label className="advisor-field">
                  <span className="advisor-label">模型</span>
                  <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={DEFAULT_MODEL}
                    data-testid="pve-advisor-model"
                    value={advisor.model}
                    onChange={(e) => patchAdvisor({ model: e.target.value })}
                  />
                </label>
              </div>
            ) : null}

            <p className="muted small" data-testid="pve-advisor-privacy">
              🔒 密钥只保存在<b>你自己这台设备的浏览器里</b>，不会上传、也不会写进游戏文件。
              本项目是纯静态、无服务器的，因此没有更安全的存放处 —— 请自行判断是否填写。
            </p>
            <p className="muted small" data-testid="pve-advisor-fallback">
              任何异常（没网 / 密钥无效 / 超时）都会<b>静默退回</b>原难度，对局绝不会因此中断。
              未开启时行为与改造前完全一致。
            </p>
            <p className="muted small" data-testid="pve-advisor-caveat">
              如实说明：参谋只是给 AI 的搜索<b>换一套参数偏好</b>，不保证变强 ——
              实测中"调参"往往收益有限，它的价值主要在<b>让 AI 的风格更有辨识度</b>。
              另外，参谋结果不会被保存到存档里，因此<b>刷新页面后本回合的倾向可能变化</b>。
            </p>
          </div>
        ) : null}
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
