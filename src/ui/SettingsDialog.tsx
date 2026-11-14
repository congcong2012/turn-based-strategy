/**
 * 设置（首页入口，排在「地图编辑器」下面）。
 *
 * 三件事：
 *  1. **声音**：主音量 + 音效开关（以前只有一个开关藏在局内 HUD 里）；
 *  2. **我的颜色**：指定自己阵营的颜色（棋盘/记分牌共用同一条规则）；
 *  3. **开发者模式**：一个总闸 —— 关着的时候，页面上只留"跟玩有关"的东西，
 *     信令 / peer / 诊断 / AI 参数全部收起；打开后它们才出现，
 *     并且单人局内可以直接调 AI 参数（局内那个入口见 `GameScreen`）。
 */

import { useEffect, useState } from 'react'
import { isSoundOn, setSoundOn } from './sound'
import { SELF_COLOR_CHOICES, setSettings, useAppSettings } from '../app/settings'
import { AiTuningPanel } from './AiTuningPanel'

export function SettingsDialog() {
  const settings = useAppSettings()
  const [open, setOpen] = useState(false)
  /** 音效开关有自己的存储（局内 HUD 也能切），这里跟着同步一次 */
  const [soundOn, setSoundOnState] = useState(() => isSoundOn())

  useEffect(() => {
    if (!open) return
    setSoundOnState(isSoundOn())
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <button type="button" className="entry-card" data-testid="settings-open" onClick={() => setOpen(true)}>
        <span className="entry-icon">⚙️</span>
        <span className="entry-title">设置</span>
        <span className="entry-desc">音量、我的颜色、开发者模式</span>
      </button>

      {open ? (
        <div className="overlay" data-testid="settings-dialog" onClick={() => setOpen(false)}>
          <div className="overlay-card devtools-card" onClick={(event) => event.stopPropagation()}>
            <h2>设置</h2>

            <div className="devtools-body">
            <section className="settings-section" data-testid="settings-sound">
              <h3>声音</h3>
              <label className="devtools-row">
                <span className="devtools-label">
                  音量
                  <em className="muted small">合成音效的总音量；拉到 0 等于静音</em>
                </span>
                <span className="devtools-control">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={Math.round(settings.volume * 100)}
                    data-testid="settings-volume"
                    onChange={(event) => setSettings({ volume: Number(event.target.value) / 100 })}
                  />
                  <span className="devtools-number settings-volume-value" data-testid="settings-volume-value">
                    {Math.round(settings.volume * 100)}%
                  </span>
                </span>
              </label>
              <label className="devtools-toggle">
                <input
                  type="checkbox"
                  checked={soundOn}
                  data-testid="settings-sound-enabled"
                  onChange={(event) => {
                    setSoundOn(event.target.checked)
                    setSoundOnState(event.target.checked)
                  }}
                />
                <span>
                  音效
                  <em className="muted small"> 关闭后完全不响（与局内 HUD 的喇叭按钮同步）</em>
                </span>
              </label>
            </section>

            <section className="settings-section" data-testid="settings-color">
              <h3>我的颜色</h3>
              <p className="muted small">只改变你自己看到的配色（棋盘与记分牌一致）。2v2 按队伍配色，此设置不生效。</p>
              <div className="color-picker">
                <button
                  type="button"
                  className={'color-chip' + (settings.selfColor === null ? ' is-active' : '')}
                  data-testid="settings-color-default"
                  onClick={() => setSettings({ selfColor: null })}
                >
                  默认
                </button>
                {SELF_COLOR_CHOICES.map((choice) => (
                  <button
                    key={choice.hex}
                    type="button"
                    className={'color-chip' + (settings.selfColor === choice.hex ? ' is-active' : '')}
                    data-testid={'settings-color-' + choice.name}
                    onClick={() => setSettings({ selfColor: choice.hex })}
                  >
                    <span className="color-dot" style={{ background: choice.hex }} aria-hidden="true" />
                    {choice.name}
                  </button>
                ))}
              </div>
            </section>

            <section className="settings-section" data-testid="settings-dev">
              <h3>开发者</h3>
              <label className="devtools-toggle">
                <input
                  type="checkbox"
                  checked={settings.devMode}
                  data-testid="settings-devmode"
                  onChange={(event) => setSettings({ devMode: event.target.checked })}
                />
                <span>
                  开发者模式
                  <em className="muted small">
                    {' '}
                    打开后显示信令 / peer / 诊断信息，并允许在单人局内直接调 AI 参数；关闭时页面上只留与游玩有关的内容
                  </em>
                </span>
              </label>
            </section>

            {settings.devMode ? (
              <section className="settings-section" data-testid="settings-ai-tuning">
                <h3>AI 参数</h3>
                <p className="muted small">只影响单人练习。保存后下一手生效，不用重开对局。</p>
                <AiTuningPanel plainActions />
              </section>
            ) : null}
            </div>

            <div className="row devtools-actions">
              <button type="button" data-testid="settings-close" onClick={() => setOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
