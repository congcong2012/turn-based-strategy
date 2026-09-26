import { useState } from 'react'
import type { RoomView } from '../net/roomSession'

export interface ManualSdpPanelProps {
  view: RoomView
  onSubmitCode: (code: string) => void
  onCancel: () => void
}

/**
 * 手动直连向导（公共信令失败时的备用方案）：
 * 通过微信/QQ 等带外渠道交换连接码，建立一条裸 WebRTC 直连，之后与正常房间完全一致。
 * 注意：仅支持 2 人。
 */
export function ManualSdpPanel({ view, onSubmitCode, onCancel }: ManualSdpPanelProps) {
  const manual = view.manual
  const [pasted, setPasted] = useState('')
  const [copied, setCopied] = useState(false)
  if (!manual) return null

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => setCopied(false),
    )
  }

  const isHost = manual.role === 'host'

  return (
    <section className="panel" data-testid="manual-panel">
      <h2>手动直连（公共信令连不上时用）</h2>
      <p className="muted small">
        双方保持同一个房间码；把连接码通过微信/QQ 等发给对方即可。仅支持 2 人。
      </p>

      {manual.phase === 'creating' ? <p data-testid="manual-status">正在生成邀请码…</p> : null}

      {manual.phase === 'need-offer' ? (
        <>
          <p data-testid="manual-status">把房主发来的**邀请码**粘贴到下面，然后点「生成应答码」。</p>
          <textarea
            rows={4}
            data-testid="manual-input"
            value={pasted}
            placeholder="粘贴以 AT1: 开头的邀请码"
            onChange={(event) => setPasted(event.target.value)}
          />
          <div className="row">
            <button type="button" className="primary" data-testid="manual-submit" disabled={pasted.trim().length < 16} onClick={() => onSubmitCode(pasted)}>
              生成应答码
            </button>
            <button type="button" onClick={onCancel}>
              取消
            </button>
          </div>
        </>
      ) : null}

      {manual.phase === 'need-answer' && manual.code ? (
        <>
          <p data-testid="manual-status">
            {isHost ? '把这段邀请码发给好友，等他回传应答码后粘贴到下面。' : '把这段应答码发回给房主，然后等他在他那边粘贴。'}
          </p>
          <label className="field">
            <span>{isHost ? '邀请码' : '应答码'}</span>
            <textarea readOnly rows={4} data-testid="manual-code" value={manual.code} />
          </label>
          <div className="row">
            <button type="button" onClick={() => copy(manual.code ?? '')}>
              {copied ? '已复制' : '复制'}
            </button>
          </div>
          {isHost ? (
            <>
              <label className="field">
                <span>好友回传的应答码</span>
                <textarea
                  rows={4}
                  data-testid="manual-input"
                  value={pasted}
                  placeholder="粘贴以 AT1: 开头的应答码"
                  onChange={(event) => setPasted(event.target.value)}
                />
              </label>
              <div className="row">
                <button type="button" className="primary" data-testid="manual-submit" disabled={pasted.trim().length < 16} onClick={() => onSubmitCode(pasted)}>
                  完成连接
                </button>
                <button type="button" onClick={onCancel}>
                  取消
                </button>
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {manual.phase === 'connecting' ? <p data-testid="manual-status">正在建立直连…（几秒内完成）</p> : null}

      {manual.phase === 'failed' ? (
        <>
          <p className="alert error" data-testid="manual-status">
            直连失败：{manual.error ?? '未知原因'}
          </p>
          <div className="row">
            <button type="button" onClick={onCancel}>
              重新开始
            </button>
          </div>
        </>
      ) : null}

      {manual.phase === 'connected' ? <p data-testid="manual-status">直连已建立 ✅</p> : null}
    </section>
  )
}
