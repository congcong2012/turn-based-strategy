/**
 * AI 参数面板（可复用）：设置弹层里用一次，单人局内的「调参」弹层里再用一次。
 *
 * 只负责"改哪几个数、怎么存"，**不负责弹层外壳** —— 两处的容器不同
 * （设置里是一段区域，局内是独立的浮层），外壳各自实现，面板保持一份。
 */

import { useEffect, useMemo, useState } from 'react'
import { PROFILES } from '../ai/profile'
import { TUNING_FIELDS, TUNING_TOGGLES, clearAiTuning, loadAiTuning, saveAiTuning } from '../app/aiTuning'
import type { AiTuning } from '../app/aiTuning'

export function AiTuningPanel({ plainActions = false }: { plainActions?: boolean } = {}) {
  const [tuning, setTuning] = useState<AiTuning>(() => loadAiTuning())
  const [saved, setSaved] = useState(false)

  // 别的入口（例如局内弹层）保存后，再切回来要看到最新值
  useEffect(() => {
    setTuning(loadAiTuning())
  }, [])

  /** 对照用的基准：困难档（玩家最常拿来试的档） */
  const base = PROFILES.hard
  const changed = useMemo(
    () =>
      TUNING_FIELDS.filter((f) => typeof tuning[f.key] === 'number').length +
      TUNING_TOGGLES.filter((t) => typeof tuning[t.key] === 'boolean').length,
    [tuning],
  )

  const setNumber = (key: string, value: number) => {
    setTuning((prev) => ({ ...prev, [key]: value }))
    setSaved(false)
  }
  const setBool = (key: string, value: boolean) => {
    setTuning((prev) => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  return (
    <div data-testid="ai-tuning-panel">
      <div className="devtools-grid" data-testid="devtools-fields">
        {TUNING_FIELDS.map((field) => {
          const current = typeof tuning[field.key] === 'number' ? (tuning[field.key] as number) : undefined
          const fallback = base[field.key] as number
          const value = current ?? fallback
          return (
            <label className="devtools-row" key={field.key as string}>
              <span className="devtools-label">
                {field.label}
                <em className="muted small">{field.hint}</em>
              </span>
              <span className="devtools-control">
                <input
                  type="range"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={value}
                  data-testid={'devtools-' + (field.key as string)}
                  onChange={(event) => setNumber(field.key as string, Number(event.target.value))}
                />
                <input
                  type="number"
                  className="devtools-number"
                  data-testid={'devtools-' + (field.key as string) + '-number'}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={value}
                  onChange={(event) => setNumber(field.key as string, Number(event.target.value))}
                />
                <span className={'devtools-default' + (current === undefined ? ' is-default' : '')}>
                  {current === undefined ? '默认' : `默认 ${fallback}`}
                </span>
              </span>
            </label>
          )
        })}
      </div>

      <div className="devtools-toggles">
        {TUNING_TOGGLES.map((toggle) => {
          const current = typeof tuning[toggle.key] === 'boolean' ? (tuning[toggle.key] as boolean) : undefined
          const fallback = base[toggle.key] as boolean
          const value = current ?? fallback
          return (
            <label className="devtools-toggle" key={toggle.key as string}>
              <input
                type="checkbox"
                checked={value}
                data-testid={'devtools-' + (toggle.key as string)}
                onChange={(event) => setBool(toggle.key as string, event.target.checked)}
              />
              <span>
                {toggle.label}
                <em className="muted small">
                  {' '}
                  {toggle.hint}（默认{fallback ? '开' : '关'}）
                </em>
              </span>
            </label>
          )
        })}
      </div>

      <div className={'row devtools-actions' + (plainActions ? ' is-plain' : '')}>
        <button
          type="button"
          data-testid="devtools-reset"
          onClick={() => {
            clearAiTuning()
            setTuning({})
            setSaved(true)
          }}
        >
          恢复默认
        </button>
        <button
          type="button"
          className="primary"
          data-testid="devtools-save"
          onClick={() => {
            saveAiTuning(tuning)
            setSaved(true)
          }}
        >
          保存
        </button>
        <span className="muted small" data-testid="devtools-status">
          {saved ? '已保存，下一手生效' : changed > 0 ? `已改 ${changed} 项（未保存）` : '未改动'}
        </span>
      </div>

      <p className="muted small">
        提示：把「抱团」调大最容易复现"兵挤成一团"；「守土」调 0 可以关掉回防；
        「前瞻宽度」调到 0 会变成纯启发式（更快、更笨）。
      </p>
    </div>
  )
}
