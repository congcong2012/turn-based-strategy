/**
 * 完整战斗日志面板：把**整局**战报按回合铺出来，可滚动回看。
 *
 * 与屏幕边角那个「最近战报」小列表的分工：
 *  - 小列表（`GameScreen` 里的 `event-log`）= 最近 12 条，扫一眼"刚刚发生了什么"；
 *  - 本面板 = 从第 0 回合到当前的全部战报，用来复盘"这局到底怎么打成这样的"。
 *
 * 数据来源是 `RoomView.rounds`，由**房主权威维护并随状态广播** ——
 * 所以中途加入、刷新页面之后，这里依然是完整的（不会只剩半截）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogRound } from '../game/journal'

export interface BattleLogProps {
  rounds: LogRound[]
  /** 我的昵称：用于「只看和我有关」过滤（战报里的玩家名就是昵称） */
  selfName: string
  /** 关闭面板 */
  onClose: () => void
}

/** 回合标题文案：0 回合是"开局部署"，其余是"第 N 回合" */
function roundTitle(round: number): string {
  return round === 0 ? '开局部署' : '第 ' + round + ' 回合'
}

export function BattleLog({ rounds, selfName, onClose }: BattleLogProps) {
  const [query, setQuery] = useState('')
  const [onlyMine, setOnlyMine] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  /** 首次渲染后自动滚到底部：玩家打开面板时最想看的是"刚刚发生了什么" */
  const scrolledRef = useRef(false)

  const mine = selfName.trim()

  const filtered = useMemo(() => {
    const needle = query.trim()
    if (!needle && !onlyMine) return rounds
    return rounds
      .map((r) => ({
        round: r.round,
        lines: r.lines.filter(
          (line) => (needle ? line.includes(needle) : true) && (onlyMine && mine ? line.includes(mine) : true),
        ),
      }))
      .filter((r) => r.lines.length > 0)
  }, [rounds, query, onlyMine, mine])

  const totalLines = useMemo(() => filtered.reduce((n, r) => n + r.lines.length, 0), [filtered])

  useEffect(() => {
    if (scrolledRef.current) return
    const el = listRef.current
    if (!el) return
    scrolledRef.current = true
    el.scrollTop = el.scrollHeight
  }, [])

  // Esc 关闭：与其它弹层一致的习惯
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" data-testid="battle-log" onClick={onClose}>
      <div
        className="overlay-card battle-log-card"
        role="dialog"
        aria-label="完整战斗日志"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="battle-log-head">
          <h2>战斗日志</h2>
          <span className="muted small" data-testid="battle-log-count">
            共 {filtered.length} 个回合 · {totalLines} 条
          </span>
        </div>

        <div className="battle-log-tools">
          <input
            type="search"
            data-testid="battle-log-search"
            placeholder="搜索（部队名 / 玩家名 / 据点）"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className="field inline">
            <input
              type="checkbox"
              data-testid="battle-log-only-mine"
              checked={onlyMine}
              onChange={(event) => setOnlyMine(event.target.checked)}
            />
            <span className="muted small">只看和我有关</span>
          </label>
        </div>

        <div className="battle-log-list" data-testid="battle-log-list" ref={listRef}>
          {filtered.length === 0 ? (
            <p className="muted small">
              {rounds.length === 0 ? '本局还没有战报。' : '没有匹配的战报。'}
            </p>
          ) : (
            filtered.map((r) => (
              <section key={r.round} className="battle-log-round">
                <h3>{roundTitle(r.round)}</h3>
                <ol>
                  {r.lines.map((line, index) => (
                    // 同一回合内行只追加、不重排；用「回合+下标」足够稳定
                    // biome-ignore lint/suspicious/noArrayIndexKey: 战报行是不可变文本，只追加不重排
                    <li key={r.round + '-' + index}>{line}</li>
                  ))}
                </ol>
              </section>
            ))
          )}
        </div>

        <div className="battle-log-foot">
          <button type="button" data-testid="battle-log-close" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
