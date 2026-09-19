/**
 * 生成地图 JSON：
 *   node scripts/gen-map.mjs            # 两张都生成
 *   node scripts/gen-map.mjs ancient_01 # 只生成 2 人图
 *
 * ancient_01（2 人，24×24 古道渡口）：南北对称，中部 2 格宽河流 + 3 座桥
 * ancient_04（4 人，24×24 四战之地）：四角对称，十字水系 + 8 座桥 + 中央广场
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const W = 24
const H = 24
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'maps')

function blank() {
  return Array.from({ length: H }, () => Array.from({ length: W }, () => 'plain'))
}
const put = (grid, x, y, t) => {
  if (x >= 0 && x < W && y >= 0 && y < H) grid[y][x] = t
}

// ---------------------------------------------------------------- 2 人图
function mapAncient01() {
  const grid = blank()
  const RIVER_Y = [11, 12]
  const BRIDGE_X = [4, 11, 19]

  const forests = [
    [2, 5], [3, 6], [2, 7], [20, 5], [21, 6], [20, 7],
    [8, 8], [9, 9], [15, 8], [16, 9], [7, 5], [16, 5],
    [2, 18], [3, 17], [2, 16], [20, 18], [21, 17], [20, 16],
    [8, 15], [9, 14], [15, 15], [16, 14], [7, 18], [16, 18],
    [4, 7], [19, 7], [4, 16], [19, 16],
  ]
  for (const [x, y] of forests) put(grid, x, y, 'forest')

  const mountains = [
    [3, 10], [5, 10], [10, 10], [13, 10], [18, 10], [20, 10],
    [3, 13], [5, 13], [10, 13], [13, 13], [18, 13], [20, 13],
    [9, 6], [14, 6], [9, 17], [14, 17],
  ]
  for (const [x, y] of mountains) put(grid, x, y, 'mountain')

  for (const y of RIVER_Y) for (let x = 0; x < W; x += 1) put(grid, x, y, 'river')
  for (const y of RIVER_Y) for (const x of BRIDGE_X) put(grid, x, y, 'road')

  for (const y of [10, 13]) for (let x = 4; x <= 19; x += 1) {
    if (grid[y][x] !== 'river') put(grid, x, y, 'road')
  }
  for (let y = 2; y <= 21; y += 1) {
    if (RIVER_Y.includes(y)) continue
    put(grid, 11, y, 'road')
  }

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
  for (const b of buildings) put(grid, b.x, b.y, 'building')

  return {
    id: 'ancient_01',
    name: '古道渡口',
    width: W,
    height: H,
    terrain: grid.flat(),
    buildings: buildings.map((b, i) => ({ id: 'b' + (i + 1), ...b })),
    deployZones: [
      { x0: 0, y0: 0, x1: W - 1, y1: 4 },
      { x0: 0, y0: H - 5, x1: W - 1, y1: H - 1 },
    ],
  }
}

// ---------------------------------------------------------------- 4 人图
function mapAncient04() {
  const grid = blank()
  const RIVER_LINES = [11, 12]
  const BRIDGE_AT = [3, 20]

  // 十字水系：第 11/12 行与第 11/12 列都是河
  for (const line of RIVER_LINES) {
    for (let i = 0; i < W; i += 1) {
      put(grid, i, line, 'river')
      put(grid, line, i, 'river')
    }
  }
  // 中央广场（十字交叉处打通）
  for (const y of RIVER_LINES) for (const x of RIVER_LINES) put(grid, x, y, 'road')
  // 8 座桥：四条臂各两座（靠近角落 + 靠近中心）
  for (const line of RIVER_LINES) {
    for (const b of BRIDGE_AT) {
      put(grid, b, line, 'road')
      put(grid, line, b, 'road')
    }
  }

  // 桥头山隘：每条桥的两侧各一座山
  const mountains = [
    [2, 10], [4, 10], [2, 13], [4, 13],
    [19, 10], [21, 10], [19, 13], [21, 13],
    [10, 2], [10, 4], [13, 2], [13, 4],
    [10, 19], [10, 21], [13, 19], [13, 21],
  ]
  for (const [x, y] of mountains) put(grid, x, y, 'mountain')

  // 林地
  const forests = [
    [6, 6], [7, 7], [6, 8], [8, 6],
    [17, 6], [16, 7], [17, 8], [15, 6],
    [6, 17], [7, 16], [6, 15], [8, 17],
    [17, 17], [16, 16], [17, 15], [15, 17],
    [9, 9], [14, 9], [9, 14], [14, 14],
  ]
  for (const [x, y] of forests) put(grid, x, y, 'forest')

  // 主干道：四条边线（x=3/x=20/y=3/y=20）贯穿，连接角落与桥
  for (let i = 2; i <= 21; i += 1) {
    if (grid[3][i] !== 'river') put(grid, 3, i, 'road')
    if (grid[20][i] !== 'river') put(grid, 20, i, 'road')
    if (grid[i][3] !== 'river') put(grid, i, 3, 'road')
    if (grid[i][20] !== 'river') put(grid, i, 20, 'road')
  }

  const buildings = [
    // 西北（玩家 0）
    { type: 'hq', x: 3, y: 3, owner: 0 },
    { type: 'barracks', x: 6, y: 3, owner: 0 },
    { type: 'barracks', x: 3, y: 6, owner: 0 },
    { type: 'village', x: 8, y: 3, owner: null },
    { type: 'village', x: 3, y: 8, owner: null },
    // 东北（玩家 1）
    { type: 'hq', x: 20, y: 3, owner: 1 },
    { type: 'barracks', x: 17, y: 3, owner: 1 },
    { type: 'barracks', x: 20, y: 6, owner: 1 },
    { type: 'village', x: 15, y: 3, owner: null },
    { type: 'village', x: 20, y: 8, owner: null },
    // 西南（玩家 2）
    { type: 'hq', x: 3, y: 20, owner: 2 },
    { type: 'barracks', x: 6, y: 20, owner: 2 },
    { type: 'barracks', x: 3, y: 17, owner: 2 },
    { type: 'village', x: 8, y: 20, owner: null },
    { type: 'village', x: 3, y: 15, owner: null },
    // 东南（玩家 3）
    { type: 'hq', x: 20, y: 20, owner: 3 },
    { type: 'barracks', x: 17, y: 20, owner: 3 },
    { type: 'barracks', x: 20, y: 17, owner: 3 },
    { type: 'village', x: 15, y: 20, owner: null },
    { type: 'village', x: 20, y: 15, owner: null },
    // 中央四村（争夺焦点，放在河道两侧的陆地上）
    { type: 'village', x: 9, y: 10, owner: null },
    { type: 'village', x: 14, y: 10, owner: null },
    { type: 'village', x: 9, y: 13, owner: null },
    { type: 'village', x: 14, y: 13, owner: null },
  ]
  for (const b of buildings) put(grid, b.x, b.y, 'building')

  return {
    id: 'ancient_04',
    name: '四战之地',
    width: W,
    height: H,
    terrain: grid.flat(),
    buildings: buildings.map((b, i) => ({ id: 'c' + (i + 1), ...b })),
    deployZones: [
      { x0: 0, y0: 0, x1: 7, y1: 7 },
      { x0: 16, y0: 0, x1: 23, y1: 7 },
      { x0: 0, y0: 16, x1: 7, y1: 23 },
      { x0: 16, y0: 16, x1: 23, y1: 23 },
    ],
  }
}

const want = process.argv[2]
mkdirSync(outDir, { recursive: true })
const maps = [
  { id: 'ancient_01', make: mapAncient01 },
  { id: 'ancient_04', make: mapAncient04 },
]
for (const { id, make } of maps) {
  if (want && want !== id) continue
  const map = make()
  const file = join(outDir, id + '.json')
  writeFileSync(file, JSON.stringify(map, null, 2) + '\n')
  const glyph = { plain: '.', road: '=', forest: '^', mountain: 'A', river: '~', building: 'B' }
  console.log('=== ' + map.name + '（' + id + '，' + map.width + '×' + map.height + '）===')
  for (let y = 0; y < map.height; y += 1) {
    console.log(String(y).padStart(2, '0') + ' ' + map.terrain.slice(y * map.width, (y + 1) * map.width).map((t) => glyph[t]).join(''))
  }
  console.log('据点 ' + map.buildings.length + '（王城 ' + map.buildings.filter((b) => b.type === 'hq').length + ' / 兵营 ' + map.buildings.filter((b) => b.type === 'barracks').length + ' / 村落 ' + map.buildings.filter((b) => b.type === 'village').length + '） 部署区 ' + map.deployZones.length)
  console.log('')
}
