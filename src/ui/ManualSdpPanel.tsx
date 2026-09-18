/**
 * 手动交换 SDP 的降级入口（M1 只做 UI 占位）。
 *
 * 技术说明：Trystero 内部封装了 RTCPeerConnection，不暴露 SDP 注入点，
 * 因此"手动交换 SDP"无法建立在 Trystero 之上，需要另起一条裸 WebRTC 通道。
 * M1 的真实降级能力是「信令策略切换」：MQTT ↔ Torrent。
 */
export function ManualSdpPanel() {
  return (
    <details className="panel sdp-panel" data-testid="manual-sdp-panel">
      <summary>手动交换 SDP（降级入口 · 占位）</summary>
      <p className="muted">
        公共信令不可用时，可先尝试切换到 Torrent 信令。完全手动的 SDP 交换需要绕过 Trystero
        自建裸 WebRTC 通道，属于后续里程碑的独立任务，这里先保留入口。
      </p>
      <label className="field">
        <span>本地 offer / answer</span>
        <textarea readOnly rows={3} placeholder="（M2 起可用）" data-testid="local-sdp" />
      </label>
      <label className="field">
        <span>对方 SDP</span>
        <textarea rows={3} placeholder="粘贴对方的 SDP 后点击应用" data-testid="remote-sdp" />
      </label>
      <button type="button" disabled data-testid="apply-sdp-button">
        应用对方 SDP（未实现）
      </button>
    </details>
  )
}
