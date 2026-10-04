import { versionLine } from '../version'
import type { Page } from '../app/route'
import { AppFooter } from './AppFooter'

export interface HomePageProps {
  onNavigate: (page: Page) => void
  /** 来自邀请链接的房间码（有的话直接给一个"进入房间"的入口） */
  roomCode: string | null
}

/** 主页：三个入口（联机对战 / 单人练习 / 规则速查），底部是版本与捐赠 */
export function HomePage({ onNavigate, roomCode }: HomePageProps) {
  return (
    <div className="app home-page">
      <header className="app-header home-header">
        <h1>古代战棋</h1>
        <p className="muted">
          纯静态、零服务器的回合制战棋：好友打开网址、输入同一个房间码即可开局，<b>2–4 人</b>混战。
        </p>
        <p className="muted small">不需要注册、不需要下载、不收集任何数据；所有对局数据只在你们几台设备之间直连。</p>
      </header>

      <section className="panel home-entries">
        <button type="button" className="entry-card primary" data-testid="entry-online" onClick={() => onNavigate('lobby')}>
          <span className="entry-icon">⚔️</span>
          <span className="entry-title">联机对战</span>
          <span className="entry-desc">
            {roomCode ? '检测到邀请链接：' + roomCode + '，点击进入房间' : '输入房间码或创建房间，2–4 人开一局'}
          </span>
        </button>

        <button type="button" className="entry-card" data-testid="entry-pve" onClick={() => onNavigate('pve')}>
          <span className="entry-icon">🏯</span>
          <span className="entry-title">单人练习</span>
          <span className="entry-desc">和本地 AI 打一局，1–3 个对手，不需要联网</span>
        </button>

        <button type="button" className="entry-card" data-testid="entry-rules" onClick={() => onNavigate('rules')}>
          <span className="entry-icon">📜</span>
          <span className="entry-title">规则速查</span>
          <span className="entry-desc">兵种、克制、地形、占领与胜负，一页看完</span>
        </button>

        <button type="button" className="entry-card" data-testid="entry-editor" onClick={() => onNavigate('editor')}>
          <span className="entry-icon">🗺️</span>
          <span className="entry-title">地图编辑器</span>
          <span className="entry-desc">画一张自己的地图，做好就能在单人练习里开一局</span>
        </button>
      </section>

      <section className="panel">
        <h2>三步开局</h2>
        <ol className="rules-list">
          <li><b>进房间</b>：房主输入 6 位房间码（或点「随机生成」），把「复制邀请链接」发给好友</li>
          <li><b>部署</b>：预算 4000、最多 4 个单位，放在高亮的己方部署区</li>
          <li><b>开打</b>：抢中立村落攒军费、在兵营造兵，攻陷对方王城或全歼对手即获胜</li>
        </ol>
        <p className="muted small">手机浏览器同样可玩：双指缩放，移动/攻击需再点一次确认。</p>
      </section>

      <AppFooter onNavigate={onNavigate} />
      <p className="muted small" style={{ textAlign: 'center' }}>{versionLine()}</p>
    </div>
  )
}
