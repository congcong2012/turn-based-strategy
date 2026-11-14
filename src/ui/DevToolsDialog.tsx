/**
 * 开发者工具：手调 AI 参数。
 *
 * 定位：给想"自己拧一拧看看"的玩家一个入口，**不是**面向所有人的功能 ——
 * 所以入口做得很小（首页底部一行小字），面板里也把"只影响单人练习"写在最上面。
 *
 * 交互取舍：
 *  - 数值用滑杆 + 数字输入并存：滑杆方便试探，输入框方便精确复现某个值；
 *  - 每项都显示"默认多少"，否则玩家不知道自己在偏哪边；
 *  - 保存后**立即生效**（下次 AI 决策就会读），不需要重开对局 ——
 *    调参最有意思的部分就是"改一下、看下一步怎么走"。
 */

import { useEffect, useMemo, useState } from 'react'
import { PROFILES } from '../ai/profile'
import {
  TUNING_FIELDS,
  TUNING_TOGGLES,
  clearAiTuning,
  loadAiTuning,
  saveAiTuning,
} from '../app/aiTuning'
import type { AiTuning } from '../app/aiTuning'

export function DevToolsDialog() {
  const [open, setOpen] = useState(false)
  const [tuning, setTuning] = useState<AiTuning>({})
  const [saved, setSaved] = useState(false)

  // 打开时读一次当前值（不在面板常驻时读，避免每次渲染都碰 localStorage）
  useEffect(() => {
    if (!open) return
    setTuning(loadAiTuning())
    setSaved(false)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  /** 对照用的基准：困难档（玩家最常拿来试的档） */
  const base = PROFILES.hard
  const changed = useMemo(
    () =>
      TUNING_FIELDS.filter((f) => typeof tuning[f.key] === 'number').length +
      TUNING_TOGGLES.filter((t) => typeof tuning[t.key] === 'boolean').length,
    [tuning],
  )

  const setNumber = (key: string, value: number) => setTuning((prev) => ({ ...prev, [key]: value }))
  const setBool = (key: string, value: boolean) => setTuning((prev) => ({ ...prev, [key]: value }))

  return (
    <>
      <button
        type="button"
        className="devtools-link"
        data-testid="devtools-open"
        onClick={() => setOpen(true)}
        title="手调 AI 参数（只影响单人练习）"
      >
        开发者工具
      </button>

      {open ? (
        <div className="overlay" data-testid="devtools-dialog" onClick={() => setOpen(false)}>
          <div className="overlay-card devtools-card" onClick={(event) => event.stopPropagation()}>
            <h2>开发者工具 · AI 参数</h2>
            <p className="muted small">
              只影响<b>单人练习</b>里的 AI（联机的 AI 补位不受影响）。保存后<b>下一手立即生效</b>，
              不用重开对局。想还原就点「恢复默认」。
            </p>

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
                const current =
                  typeof tuning[toggle.key] === 'boolean' ? (tuning[toggle.key] as boolean) : undefined
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

            <div className="row devtools-actions">
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
              <button type="button" data-testid="devtools-close" onClick={() => setOpen(false)}>
                关闭
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
        </div>
      ) : null}
    </>
  )
}
