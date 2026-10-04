import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installUserMaps } from './app/mapStore'
import './styles.css'

// 启动时先把本机的自制地图注册进运行时地图表。
// 必须早于任何对局恢复 —— 否则"以前用自制地图开的单人局"会因为查不到地图被判非法存档而清掉。
installUserMaps()

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
