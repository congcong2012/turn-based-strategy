/**
 * 单人局内的「调参」入口（只在开发者模式下出现）。
 *
 * 为什么放在对局里：调参最有意思的部分是"改一个数、看它下一步怎么走"。
 * 参数每个决策现读一次（见 `usePveGame`），所以这里保存后**下一手立即生效**。
 */

import { useEffect, useState } from 'react'
import { AiTuningPanel } from './AiTuningPanel'

export function AiTuningDialog() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <button
        type="button"
        data-testid="ai-tuning-open"
        onClick={() => setOpen(true)}
        title="开发者模式：调 AI 参数（下一手生效）"
      >
        🧪 调参
      </button>

      {open ? (
        <div className="overlay" data-testid="ai-tuning-dialog" onClick={() => setOpen(false)}>
          <div className="overlay-card devtools-card" onClick={(event) => event.stopPropagation()}>
            <h2>AI 参数</h2>
            <p className="muted small">
              只影响本局（单人练习）。保存后<b>下一手立即生效</b>，不用重开；「恢复默认」随时还原。
            </p>
            <div className="devtools-body">
              <AiTuningPanel />
            </div>
            <div className="row devtools-actions">
              <button type="button" data-testid="ai-tuning-close" onClick={() => setOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
