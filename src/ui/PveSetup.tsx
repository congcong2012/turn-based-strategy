/**
 * 单人练习（PVE）设置页：选对手数量 / 我的阵营 / 难度 → 开始。
 *
 * 说明：地图由"对手数量"决定（2 人用古道渡口，3–4 人用四战之地），
 * 而"我的阵营 = 出生角"同时决定出手顺序：**0 号角先手**（内核里 players[0] 先行动）。
 */

import { useMemo, useState } from 'react'
import { getMap, defaultMapFor, MAP_LIST } from '../game/data'
import type { MapDef } from '../game/data'
import type { Page } from '../app/route'
import type { PveConfig, PveDifficulty } from '../app/pveSession'
import { AppFooter } from './AppFooter'

export interface PveSetupProps {
  onStart: (config: PveConfig) => void
  onNavigate: (page: Page) => void
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

export function PveSetup({ onStart, onNavigate }: PveSetupProps) {
  const [opponents, setOpponents] = useState(1)
  const [humanSeat, setHumanSeat] = useState(0)
  const [difficulty, setDifficulty] = useState<PveDifficulty>('normal')

  const total = opponents + 1
  const mapId = defaultMapFor(total)
  const map = getMap(mapId)
  const mapInfo = MAP_LIST.find((m) => m.id === mapId)

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
      // 种子只影响"简单"难度的随机性；用时间戳保证每局不同
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
        <p className="muted small" data-testid="pve-map-hint">
          地图：{mapInfo?.name ?? mapId}（{map.width}×{map.height}，{total} 方）
        </p>
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
          <button
            type="button"
            data-testid="pve-difficulty-easy"
            className={difficulty === 'easy' ? 'picked' : ''}
            onClick={() => setDifficulty('easy')}
          >
            简单
            <span className="muted small"> 出手随意，会漏操作</span>
          </button>
          <button
            type="button"
            data-testid="pve-difficulty-normal"
            className={difficulty === 'normal' ? 'picked' : ''}
            onClick={() => setDifficulty('normal')}
          >
            普通
            <span className="muted small"> 会抢据点、会集火残血</span>
          </button>
        </div>
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
