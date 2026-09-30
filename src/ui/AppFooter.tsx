import { versionLine } from '../version'
import { DonateDialog } from './DonateDialog'
import type { Page } from '../app/route'

export interface AppFooterProps {
  onNavigate?: (page: Page) => void
}

/** 页脚：版本号 + 规则入口 + 捐赠入口（版本号是排查问题时最关键的信息） */
export function AppFooter({ onNavigate }: AppFooterProps) {
  return (
    <footer className="app-footer">
      <div className="row footer-row">
        {onNavigate ? (
          <button type="button" className="link-button" data-testid="footer-rules" onClick={() => onNavigate('rules')}>
            规则速查
          </button>
        ) : null}
        <DonateDialog />
      </div>
      <p className="muted small" data-testid="version-line">
        {versionLine()} · 纯静态托管 · 无后端 / 无数据库 · 数据只在玩家设备之间直连
      </p>
    </footer>
  )
}
