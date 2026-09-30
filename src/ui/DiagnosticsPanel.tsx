import { useState } from 'react'
import type { RoomView } from '../net/roomSession'
import { connectionLabel } from '../net/connectionState'
import { versionLine } from '../version'

export interface DiagnosticsPanelProps {
  view: RoomView
}

/** 诊断面板：连不上时把这段信息复制给房主，能直接定位是信令、直连还是规则问题 */
export function DiagnosticsPanel({ view }: DiagnosticsPanelProps) {
  const [copied, setCopied] = useState(false)

  const text = [
    '古代战棋诊断信息',
    '版本: ' + versionLine(),
    '页面: ' + (typeof window === 'undefined' ? '-' : window.location.href),
    '时间: ' + new Date().toISOString(),
    '房间码: ' + (view.roomCode ?? '-') + (view.passwordEnabled ? '（已设房间密码）' : ''),
    '角色: ' + view.role + (view.isHost ? '（房主）' : ''),
    '连接状态: ' + connectionLabel(view.connection) + '（' + view.connection + '）',
    // manual 传输不经过任何公共信令，写清楚以免排查时误判
    view.kind === 'manual' ? '传输: 手动直连（未使用公共信令）' : '传输: ' + view.kind + ' / 信令: ' + view.strategy,
    '传输状态: ' + view.transportStatus + (view.transportDetail ? '（' + view.transportDetail + '）' : ''),
    '连接数: ' + view.peerCount,
    '玩家: ' + view.players.map((p) => p.nickname + (p.connected ? '' : '(离线)')).join('、'),
    '对局: ' + (view.game ? view.game.phase + ' 第' + view.game.round + '回合' : '未开始'),
    '最近错误:',
    ...(view.errors.length > 0 ? view.errors.slice(-6).map((e) => '  - ' + new Date(e.at).toLocaleTimeString() + ' ' + e.text) : ['  （无）']),
  ].join('\n')

  return (
    <details className="panel diag-panel" data-testid="diagnostics">
      <summary>诊断信息{view.errors.length > 0 ? '（有 ' + view.errors.length + ' 条错误）' : ''}</summary>
      <pre className="diag-body" data-testid="diagnostics-body">{text}</pre>
      <button
        type="button"
        data-testid="copy-diagnostics"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(
            () => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            },
            () => setCopied(false),
          )
        }}
      >
        {copied ? '已复制' : '复制诊断信息'}
      </button>
    </details>
  )
}
