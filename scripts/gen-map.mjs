/**
 * 生成 src/data/maps/ancient_01.json（24×24 古道渡口）
 * 用法：node scripts/gen-map.mjs
 *
 * 布局要点（对应 GDD 4.3）：
 *  - 南北双方各 1 王城 + 2 兵营，部署区各 5 行
 *  - 中部 2 格宽河流横贯，仅 3 座桥（x=4 / x=11 / x=19）
 *  - 桥头山地形成关隘；12 座中立村落（每半场 4 + 桥头 4）
 *  - 道路网：x=11 纵贯 + y=10/y=13 横向连接三座桥
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const W = 24
const H = 24
const RIVER_Y = [11, 12]
const BRIDGE_X = [4, 11, 19]
const ROAD_X = 11
const ROAD_Y = [10, 13]
const ROAD_SPAN = [4, 19]

const grid = Array.from({ length: H }, () => Array.from({ length: W }, () => 'plain'))
const set = (x, y, t) => {
  if (x >= 0 && x < W && y >= 0 && y < H) grid[y][x] = t
}

// 森林
const forests = [
  [2, 5], [3, 6], [2, 7], [20, 5], [21, 6], [20, 7],
  [8, 8], [9, 9], [15, 8], [16, 9], [7, 5], [16, 5],
  [2, 18], [3, 17], [2, 16], [20, 18], [21, 17], [20, 16],
  [8, 15], [9, 14], [15, 15], [16, 14], [7, 18], [16, 18],
  [4, 7], [19, 7], [4, 16], [19, 16],
]
for (const [x, y] of forests) set(x, y, 'forest')

// 桥头山隘
const mountains = [
  [3, 10], [5, 10], [10, 10], [13, 10], [18, 10], [20, 10],
  [3, 13], [5, 13], [10, 13], [13, 13], [18, 13], [20, 13],
  [9, 6], [14, 6], [9, 17], [14, 17],
]
for (const [x, y] of mountains) set(x, y, 'mountain')

// 河流
for (const y of RIVER_Y) for (let x = 0; x < W; x += 1) set(x, y, 'river')
// 桥（道路）
for (const y of RIVER_Y) for (const x of BRIDGE_X) set(x, y, 'road')

// 道路网
for (const y of ROAD_Y) for (let x = ROAD_SPAN[0]; x <= ROAD_SPAN[1]; x += 1) {
  if (grid[y][x] !== 'river') set(x, y, 'road')
}
for (let y = 2; y <= 21; y += 1) {
  if (RIVER_Y.includes(y)) continue
  set(ROAD_X, y, 'road')
}

// 据点（最后覆盖，保证地形是 building）
const buildings = [
  { type: 'hq', x: 11, y: 1, owner: 0 },
  { type: 'barracks', x: 6, y: 2, owner: 0 },
  { type: 'barracks', x: 17, y: 2, owner: 0 },
  { type: 'village', x: 4, y: 3, owner: null },
  { type: 'village', x: 19, y: 3, owner: null },
  { type: 'village', x: 9, y: 6, owner: null },
  { type: 'village', x: 14, y: 6, owner: null },
  { type: 'village', x: 4, y: 10, owner: null },
  { type: 'village', x: 19, y: 10, owner: null },
  { type: 'village', x: 4, y: 13, owner: null },
  { type: 'village', x: 19, y: 13, owner: null },
  { type: 'village', x: 9, y: 17, owner: null },
  { type: 'village', x: 14, y: 17, owner: null },
  { type: 'village', x: 4, y: 20, owner: null },
  { type: 'village', x: 19, y: 20, owner: null },
  { type: 'hq', x: 11, y: 22, owner: 1 },
  { type: 'barracks', x: 6, y: 21, owner: 1 },
  { type: 'barracks', x: 17, y: 21, owner: 1 },
]
for (const b of buildings) set(b.x, b.y, 'building')

const map = {
  id: 'ancient_01',
  name: '古道渡口',
  width: W,
  height: H,
  terrain: grid.flat(),
  buildings: buildings.map((b, i) => ({ id: 'b' + (i + 1), type: b.type, x: b.x, y: b.y, owner: b.owner })),
  deployZones: [
    { x0: 0, y0: 0, x1: W - 1, y1: 4 },
    { x0: 0, y0: H - 5, x1: W - 1, y1: H - 1 },
  ],
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'maps', 'ancient_01.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(map, null, 2) + '\n')
console.log('已生成', out)
console.log('村落数量 =', buildings.filter((b) => b.type === 'village').length)
console.log('桥 =', BRIDGE_X.join(', '), '| 河流行 =', RIVER_Y.join(', '))
