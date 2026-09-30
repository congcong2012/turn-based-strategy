import { DATA, getMap } from '../game/data'
import { versionLine } from '../version'
import type { Page } from '../app/route'

export interface RulesPanelProps {
  onNavigate: (page: Page) => void
}

/** 规则速查：全部从 src/data/*.json 渲染，永远和实际数值一致 */
export function RulesPanel({ onNavigate }: RulesPanelProps) {
  const map = getMap('ancient_01')
  const moveTypes = ['foot', 'horse', 'siege'] as const
  const moveLabel: Record<string, string> = { foot: '步行', horse: '骑乘', siege: '器械' }

  return (
    <div className="app rules-page">
      <header className="app-header">
        <h1>规则速查</h1>
        <p className="muted small">所有数值都来自游戏数据文件，与实际对局一致。</p>
      </header>

      <section className="panel">
        <h2>一局的流程</h2>
        <ol className="rules-list">
          <li>所有人点「准备」，房主点「开始游戏」</li>
          <li>
            <b>部署阶段</b>：预算 {DATA.rules.deployBudget}、最多 {DATA.rules.deployMaxUnits} 个单位，放在高亮的己方部署区
          </li>
          <li>
            <b>行动阶段</b>：点自己的单位 → 蓝格移动 / 红格（或红框）攻击；站在据点上可「占领」，己方兵营可「生产」
          </li>
          <li>
            每方回合结束自动结算：收入、生产出场、维修、占领易主
          </li>
          <li>
            打满 {DATA.rules.roundLimit} 大回合或分出胜负（攻陷王城 / 全歼 / 对手认输）
          </li>
        </ol>
      </section>

      <section className="panel">
        <h2>兵种</h2>
        <div className="table-scroll">
        <table className="rules-table" data-testid="rules-units">
          <thead>
            <tr>
              <th>兵种</th><th>HP</th><th>移动</th><th>射程</th><th>攻击</th><th>反击</th><th>可占领</th><th>造价</th>
            </tr>
          </thead>
          <tbody>
            {DATA.unitList.map((unit) => (
              <tr key={unit.id}>
                <td>{unit.glyph} {unit.name}</td>
                <td>{unit.hp}</td>
                <td>{unit.move}（{moveLabel[unit.moveType]}）</td>
                <td>{unit.rangeMin === unit.rangeMax ? unit.rangeMin : unit.rangeMin + '–' + unit.rangeMax}</td>
                <td>{unit.attack === 'direct' ? '直射' : '间接'}</td>
                <td>{unit.counter ? '是' : '否'}</td>
                <td>{unit.capture ? '是' : '否'}</td>
                <td>{unit.cost}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <p className="muted small">间接单位（投石车）移动后不能攻击，被贴身时也无法反击。</p>
      </section>

      <section className="panel">
        <h2>克制关系（对满血目标的基础伤害）</h2>
        <div className="table-scroll">
        <table className="rules-table" data-testid="rules-matchup">
          <thead>
            <tr>
              <th>攻 ↓ / 守 →</th>
              {DATA.unitList.map((unit) => (
                <th key={unit.id}>{unit.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DATA.unitList.map((attacker) => (
              <tr key={attacker.id}>
                <th>{attacker.name}</th>
                {DATA.unitList.map((defender) => (
                  <td key={defender.id} className={DATA.matchup[attacker.id][defender.id] >= 70 ? 'cell-strong' : undefined}>
                    {DATA.matchup[attacker.id][defender.id]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <p className="muted small">
          伤害 = 基础伤害 × 攻方剩余HP% ×（1 − 守方地形减伤），完全确定性、没有随机数。
        </p>
      </section>

      <section className="panel">
        <h2>地形</h2>
        <div className="table-scroll">
        <table className="rules-table" data-testid="rules-terrain">
          <thead>
            <tr>
              <th>地形</th>
              {moveTypes.map((type) => (
                <th key={type}>{moveLabel[type]}消耗</th>
              ))}
              <th>减伤</th>
            </tr>
          </thead>
          <tbody>
            {Object.values(DATA.terrain).map((terrain) => (
              <tr key={terrain.id}>
                <td>{terrain.name}</td>
                {moveTypes.map((type) => (
                  <td key={type}>{terrain.moveCost[type] === null ? '不可通行' : terrain.moveCost[type]}</td>
                ))}
                <td>{Math.round(terrain.defense * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </section>

      <section className="panel">
        <h2>据点与经济</h2>
        <div className="table-scroll">
        <table className="rules-table">
          <thead>
            <tr><th>据点</th><th>收入/回合</th><th>可生产</th><th>说明</th></tr>
          </thead>
          <tbody>
            {Object.values(DATA.buildings).map((building) => (
              <tr key={building.id}>
                <td>{building.glyph} {building.name}</td>
                <td>{building.income}</td>
                <td>{building.produce ? '是' : '否'}</td>
                <td>
                  {building.id === 'hq' ? '被敌方占领即被淘汰' : building.id === 'barracks' ? '每回合最多 2 个单位' : '中立，需步兵占领'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <ul className="rules-list">
          <li>开局资金 {DATA.rules.startFunds}，每方场上单位上限 {DATA.rules.unitCap}</li>
          <li>占领值 {DATA.rules.capturePoints}：满血步兵每次 +10，两次占领完成</li>
          <li>站在己方据点上的单位每回合回复 {DATA.rules.repairPerTurn} HP</li>
          <li>生产单位在下一个回合开始出场（兵营格 → 相邻空格 → 顺延）</li>
        </ul>
      </section>

      <section className="panel">
        <h2>胜负</h2>
        <ul className="rules-list">
          <li>占领对方王城 → 该玩家被淘汰（部队撤离、其余据点归中立）</li>
          <li>对方场上单位归零 → 同样淘汰</li>
          <li>最后存活者获胜；打满 {DATA.rules.roundLimit} 大回合则按据点 + 兵力 + 资金计分</li>
          <li>任何时候可以「认输」</li>
        </ul>
      </section>

      <section className="panel">
        <h2>操作</h2>
        <ul className="rules-list">
          <li>拖动平移；滚轮（或手机双指）缩放；🎯 定位回自己的部署区 / 部队</li>
          <li>手机上移动与攻击需要「再点一次确认」，避免误触</li>
          <li>断线不影响：刷新页面会自动回到对局；房主刷新可从本地存档恢复整局</li>
          <li>公共信令连不上时，可用「手动直连」通过微信互发连接码开局</li>
          <li>地图：{Object.values(DATA.maps).map((m) => m.name + '（' + m.width + '×' + m.height + '，' + m.deployZones.length + ' 人）').join('、')}</li>
        </ul>
        <p className="muted small">{versionLine()} · 地图示例：{map.name}</p>
      </section>

      <div className="row" style={{ justifyContent: 'center' }}>
        <button type="button" className="primary" onClick={() => onNavigate('lobby')}>
          去开一局
        </button>
        <button type="button" onClick={() => onNavigate('home')}>
          返回主页
        </button>
      </div>
    </div>
  )
}
