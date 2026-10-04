/**
 * 地图编辑器（`#/editor`）。
 *
 * 定位：**给自己做地图**的图形化工具，做完直接在单人练习里玩。
 *
 * 三条设计取舍：
 *  1. 自制地图只用于**单人练习** —— 联机时其他玩家手里没有这张图，渲染不出来。
 *     想让它人人可玩：导出 JSON → 放进 `src/data/maps/` 并登记，就成了内置图。
 *  2. 数据格式与内置地图**完全一致**（`MapDef`），不引入第二套格式 ——
 *     编辑器产出的地图可以直接替换官方图，反之亦然。
 *  3. 部署区按**矩形拖拽**编辑（不是"漆格子"），因为地图格式本身只支持矩形，
 *     漆格子再取包围盒会把用户没画的地方也圈进去。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DATA } from '../game/data'
import type { MapDef } from '../game/data'
import {
  MAX_MAP_PLAYERS,
  MAX_MAP_SIZE,
  MIN_MAP_PLAYERS,
  MIN_MAP_SIZE,
  validateMap,
} from '../game/mapValidation'
import { createBlankMap, resizeMap } from '../game/mapTemplates'
import {
  deleteUserMap,
  exportMapJson,
  isUserMapId,
  loadUserMaps,
  newUserMapId,
  parseMapJson,
  upsertUserMap,
} from '../app/mapStore'
import type { UserMap } from '../app/mapStore'
import {
  OWNER_COLORS,
  canvasHeight,
  canvasWidth,
  cellFromPoint,
  drawMap,
  rectFromCells,
} from './mapEditorCanvas'
import type { ZonePreview } from './mapEditorCanvas'
import type { Page } from '../app/route'
import { AppFooter } from './AppFooter'

export interface MapEditorProps {
  onNavigate: (page: Page) => void
  /** 用这张地图**立刻开一局单人练习**（App 负责接线到 pveSession） */
  onPlaytest: (mapId: string) => void
}

type Brush =
  | { kind: 'terrain'; id: string }
  | { kind: 'building'; type: string; owner: number | null }
  | { kind: 'erase' }
  | { kind: 'zone'; player: number }

const CELL_SIZES = [14, 18, 22, 28]

/** 可画的地形（`building` 由据点自动决定，不作为笔刷） */
const PAINTABLE_TERRAINS = ['plain', 'road', 'forest', 'mountain', 'river']

/** 下一个据点 id：取现有数字后缀最大值 + 1，保证不重复 */
function nextBuildingId(map: MapDef): string {
  let max = 0
  for (const b of map.buildings) {
    const n = Number(/^b(\d+)$/.exec(b.id)?.[1] ?? 0)
    if (Number.isFinite(n) && n > max) max = n
  }
  return 'b' + (max + 1)
}

function cloneMap(map: MapDef): MapDef {
  return {
    ...map,
    terrain: map.terrain.slice(),
    buildings: map.buildings.map((b) => ({ ...b })),
    deployZones: map.deployZones.map((z) => ({ ...z })),
  }
}

/** 据点所在格的地形固定为「据点」（与内置地图一致，否则数值与看起来的不符） */
function syncBuildingTerrain(map: MapDef): void {
  for (const b of map.buildings) {
    const idx = b.y * map.width + b.x
    if (idx >= 0 && idx < map.terrain.length) map.terrain[idx] = 'building'
  }
}

/**
 * 把一次笔刷操作作用到地图上（**纯函数**：不改入参、不读外部可变状态）。
 *
 * 抽成模块级函数还有一个好处：`setMap` 的 updater 在严格模式下会被调用两次，
 * 纯函数两次结果一致，不会出现"状态被吃掉"的问题。
 * 没有任何变化时返回原对象，React 会因此跳过重渲染。
 */
function paintCell(map: MapDef, cell: { x: number; y: number }, brush: Brush): MapDef {
  const next = cloneMap(map)
  const index = cell.y * next.width + cell.x

  if (brush.kind === 'terrain') {
    // 据点格的地形是「据点」，不允许被地形笔刷覆盖（否则据点会被算成平原/森林的消耗与防御）
    if (next.buildings.some((b) => b.x === cell.x && b.y === cell.y)) return map
    if (next.terrain[index] === brush.id) return map
    next.terrain[index] = brush.id
    return next
  }

  if (brush.kind === 'erase') {
    const at = next.buildings.findIndex((b) => b.x === cell.x && b.y === cell.y)
    if (at === -1) return map
    next.buildings.splice(at, 1)
    next.terrain[index] = 'plain'
    return next
  }

  if (brush.kind === 'building') {
    // 同一格只能有一个据点：先移走原来的，再放新的
    const at = next.buildings.findIndex((b) => b.x === cell.x && b.y === cell.y)
    if (at !== -1) next.buildings.splice(at, 1)
    next.buildings.push({
      id: nextBuildingId(next),
      type: brush.type,
      x: cell.x,
      y: cell.y,
      owner: brush.owner,
    })
    syncBuildingTerrain(next)
    return next
  }

  return map
}

/** 改玩家数（纯函数）：增加时补默认部署区，减少时截断并清掉已不存在的玩家的据点 */
function withPlayerCount(map: MapDef, players: number): { map: MapDef; removedBuildings: number } {
  const next = cloneMap(map)
  if (players > next.deployZones.length) {
    const template = createBlankMap({
      id: map.id,
      name: map.name,
      width: map.width,
      height: map.height,
      players,
    })
    for (let i = next.deployZones.length; i < players; i += 1) {
      next.deployZones.push(template.deployZones[i] ?? { x0: 0, y0: 0, x1: 1, y1: 1 })
    }
    return { map: next, removedBuildings: 0 }
  }
  next.deployZones = next.deployZones.slice(0, players)
  const before = next.buildings.length
  next.buildings = next.buildings.filter((b) => b.owner === null || b.owner < players)
  return { map: next, removedBuildings: before - next.buildings.length }
}

export function MapEditor({ onNavigate, onPlaytest }: MapEditorProps) {
  const [map, setMap] = useState<MapDef>(() =>
    createBlankMap({ id: newUserMapId(), name: '我的地图 1', width: 24, height: 24, players: 2 }),
  )
  /** 已保存到本地时对应的 id；与 map.id 不同 = 有未保存改动 */
  const [savedId, setSavedId] = useState<string | null>(null)
  const [savedMaps, setSavedMaps] = useState<UserMap[]>(() => loadUserMaps())
  const [brush, setBrush] = useState<Brush>({ kind: 'terrain', id: 'plain' })
  const [cellSize, setCellSize] = useState(22)
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)
  const [zonePreview, setZonePreview] = useState<ZonePreview | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [importText, setImportText] = useState('')
  const [showImport, setShowImport] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const draggingRef = useRef(false)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const lastCellRef = useRef<string | null>(null)

  const validation = useMemo(() => validateMap(map), [map])
  const dirty = savedId !== map.id

  const reload = useCallback(() => setSavedMaps(loadUserMaps()), [])

  // ---------------------------------------------------------------- 绘制

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    drawMap(ctx, map, DATA, {
      cellSize,
      zonePreview,
      hover,
      activePlayer: brush.kind === 'zone' ? brush.player : null,
    })
  }, [map, cellSize, zonePreview, hover, brush])

  // ---------------------------------------------------------------- 编辑

  const applyBrush = useCallback(
    (cell: { x: number; y: number }) => {
      // 去重放在**事件层**：连续 pointermove 会反复命中同一格，没必要重复克隆地图。
      //
      // ⚠️ 千万别把这个判断挪进 `setMap` 的 updater 里 —— React 严格模式会**双调用** updater，
      // 第二次读到已被改过的 ref 就会直接返回旧状态，于是"画了但没变"。
      // updater 必须是纯函数：只依赖入参，不读写外部可变状态。
      const key = cell.x + ',' + cell.y
      if (lastCellRef.current === key) return
      lastCellRef.current = key
      setMap((prev) => paintCell(prev, cell, brush))
    },
    [brush],
  )

  const pointerCell = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return null
      return cellFromPoint(map, cellSize, canvas.getBoundingClientRect(), event.clientX, event.clientY)
    },
    [map, cellSize],
  )

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const cell = pointerCell(event)
    if (!cell) return
    // 指针捕获只是"拖出画布也继续画"的优化。它在部分环境（合成事件、非活动指针）下会抛
    // NotFoundError，若让它冒泡就会**中断整个处理函数**、连笔刷都不生效 —— 所以必须兜住。
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* 捕获失败不影响绘制 */
    }
    draggingRef.current = true
    lastCellRef.current = null
    if (brush.kind === 'zone') {
      dragStartRef.current = cell
      setZonePreview({ player: brush.player, ...rectFromCells(cell, cell) })
      return
    }
    applyBrush(cell)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const cell = pointerCell(event)
    setHover(cell)
    if (!cell || !draggingRef.current) return
    if (brush.kind === 'zone') {
      const start = dragStartRef.current ?? cell
      setZonePreview({ player: brush.player, ...rectFromCells(start, cell) })
      return
    }
    if (brush.kind === 'building') return // 据点不跟随拖动铺，避免手滑铺一排
    applyBrush(cell)
  }

  const endDrag = (): void => {
    if (brush.kind === 'zone' && zonePreview) {
      setMap((prev) => {
        const next = cloneMap(prev)
        while (next.deployZones.length <= zonePreview.player) {
          next.deployZones.push({ x0: 0, y0: 0, x1: 1, y1: 1 })
        }
        next.deployZones[zonePreview.player] = {
          x0: zonePreview.x0,
          y0: zonePreview.y0,
          x1: zonePreview.x1,
          y1: zonePreview.y1,
        }
        return next
      })
    }
    draggingRef.current = false
    dragStartRef.current = null
    lastCellRef.current = null
    setZonePreview(null)
  }

  // ---------------------------------------------------------------- 地图属性

  const changePlayers = (players: number): void => {
    const { map: next, removedBuildings } = withPlayerCount(map, players)
    setMap(next)
    if (removedBuildings > 0) {
      setMessage(`减少玩家后，${removedBuildings} 个原来属于该玩家的据点被移除`)
    }
  }

  const changeSize = (width: number, height: number): void => {
    const { map: resized, droppedBuildings } = resizeMap(map, width, height)
    setMap(resized)
    if (droppedBuildings > 0) {
      setMessage(`缩小尺寸后，${droppedBuildings} 个超出范围的据点被移除`)
    }
  }

  // ---------------------------------------------------------------- 存档操作

  const doSave = (): void => {
    if (!validation.ok) {
      setMessage('还有未解决的问题，修好后再保存')
      return
    }
    const normalized = cloneMap(map)
    syncBuildingTerrain(normalized)
    upsertUserMap(normalized)
    setMap(normalized)
    setSavedId(normalized.id)
    reload()
    setMessage('已保存到本机（浏览器本地存储）')
  }

  const doSaveAs = (): void => {
    if (!validation.ok) {
      setMessage('还有未解决的问题，修好后再保存')
      return
    }
    const copy = cloneMap(map)
    copy.id = newUserMapId()
    copy.name = map.name + ' 副本'
    syncBuildingTerrain(copy)
    upsertUserMap(copy)
    setMap(copy)
    setSavedId(copy.id)
    reload()
    setMessage('已另存为「' + copy.name + '」')
  }

  const doNew = (): void => {
    const index = savedMaps.length + 1
    setMap(
      createBlankMap({
        id: newUserMapId(),
        name: '我的地图 ' + index,
        width: 24,
        height: 24,
        players: 2,
      }),
    )
    setSavedId(null)
    setMessage('已新建模板：24×24 两人图（上下部署带 + 中间村落）')
  }

  const doOpen = (record: UserMap): void => {
    const copy = cloneMap(record)
    setMap(copy)
    setSavedId(record.id)
    setMessage('已打开「' + record.name + '」')
  }

  const doDelete = (record: UserMap): void => {
    deleteUserMap(record.id)
    reload()
    if (savedId === record.id) {
      setSavedId(null)
      setMessage('已删除「' + record.name + '」，当前编辑内容未保存')
    } else {
      setMessage('已删除「' + record.name + '」')
    }
  }

  const doExport = (): void => {
    const text = exportMapJson(map)
    try {
      const blob = new Blob([text], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = map.id + '.json'
      a.click()
      URL.revokeObjectURL(url)
      setMessage('已导出 ' + map.id + '.json')
    } catch {
      setMessage('导出失败，可改用「复制 JSON」')
    }
  }

  const doCopyJson = (): void => {
    const text = exportMapJson(map)
    void navigator.clipboard?.writeText(text).then(
      () => setMessage('地图 JSON 已复制到剪贴板'),
      () => setMessage('复制失败，请手动从下方文本框复制'),
    )
    setImportText(text)
    setShowImport(true)
  }

  const doImport = (): void => {
    const result = parseMapJson(importText)
    if (!result.ok) {
      setMessage('导入失败：' + result.errors.join('；'))
      return
    }
    const imported = cloneMap(result.map)
    // 导入的地图统一换成自制 id：避免覆盖内置地图，也避免和别人撞 id
    if (!isUserMapId(imported.id)) imported.id = newUserMapId()
    setMap(imported)
    setSavedId(null)
    setMessage('已载入「' + imported.name + '」，确认无误后点「保存到本机」')
  }

  /**
   * 试玩：**先自动保存再跳转**。
   * 因为单人局只认"已注册进运行时地图表"的地图，没保存的地图会静默回退到自动挑的内置图 ——
   * 那是个很难察觉的坑，这里直接替用户保存掉。
   */
  const doPlaytest = (): void => {
    if (!validation.ok) {
      setMessage('还有未解决的问题，修好后再试玩')
      return
    }
    const normalized = cloneMap(map)
    syncBuildingTerrain(normalized)
    upsertUserMap(normalized)
    setMap(normalized)
    setSavedId(normalized.id)
    reload()
    onPlaytest(normalized.id)
  }

  const canvasW = canvasWidth(map, cellSize)
  const canvasH = canvasHeight(map, cellSize)

  return (
    <div className="app map-editor" data-testid="map-editor">
      <header className="app-header">
        <h1>地图编辑器</h1>
        <p className="muted">
          画一张自己的地图，然后直接在<b>单人练习</b>里开一局。地图存在本机浏览器里，不联网、不上传。
        </p>
        <p className="muted small">
          想让好友也能玩到：点「导出 JSON」，把文件放进项目的 <code>src/data/maps/</code> 并登记，它就成了内置地图。
        </p>
      </header>

      <section className="panel">
        <h2>地图属性</h2>
        <div className="editor-row">
          <label>
            名称
            <input
              type="text"
              data-testid="editor-name"
              value={map.name}
              maxLength={24}
              onChange={(e) => setMap((prev) => ({ ...prev, name: e.target.value }))}
            />
          </label>
          <label>
            宽
            <input
              type="number"
              data-testid="editor-width"
              min={MIN_MAP_SIZE}
              max={MAX_MAP_SIZE}
              value={map.width}
              onChange={(e) => changeSize(Number(e.target.value) || map.width, map.height)}
            />
          </label>
          <label>
            高
            <input
              type="number"
              data-testid="editor-height"
              min={MIN_MAP_SIZE}
              max={MAX_MAP_SIZE}
              value={map.height}
              onChange={(e) => changeSize(map.width, Number(e.target.value) || map.height)}
            />
          </label>
          <span className="muted small">
            {MIN_MAP_SIZE}–{MAX_MAP_SIZE} 格
          </span>
        </div>
        <div className="editor-row">
          <span className="muted small">玩家数（= 部署区数量）</span>
          {Array.from({ length: MAX_MAP_PLAYERS - MIN_MAP_PLAYERS + 1 }, (_, i) => MIN_MAP_PLAYERS + i).map((n) => (
            <button
              key={n}
              type="button"
              data-testid={'editor-players-' + n}
              className={map.deployZones.length === n ? 'picked' : ''}
              onClick={() => changePlayers(n)}
            >
              {n} 人
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>笔刷</h2>
        <div className="editor-row">
          <span className="muted small">地形</span>
          {PAINTABLE_TERRAINS.map((id) => {
            const terrain = DATA.terrain[id]
            return (
              <button
                key={id}
                type="button"
                data-testid={'brush-terrain-' + id}
                className={brush.kind === 'terrain' && brush.id === id ? 'picked' : ''}
                onClick={() => setBrush({ kind: 'terrain', id })}
              >
                <span className="swatch" style={{ background: terrain?.color }} /> {terrain?.name ?? id}
              </button>
            )
          })}
        </div>

        <div className="editor-row">
          <span className="muted small">据点（先选归属，再往图上点）</span>
          {(['hq', 'barracks', 'village'] as const).map((type) => (
            <button
              key={type}
              type="button"
              data-testid={'brush-building-' + type}
              className={brush.kind === 'building' && brush.type === type ? 'picked' : ''}
              onClick={() =>
                setBrush({ kind: 'building', type, owner: type === 'village' ? null : 0 })
              }
            >
              {DATA.buildings[type]?.name ?? type}
            </button>
          ))}
          <button
            type="button"
            data-testid="brush-erase"
            className={brush.kind === 'erase' ? 'picked' : ''}
            onClick={() => setBrush({ kind: 'erase' })}
          >
            橡皮（擦据点）
          </button>
        </div>

        {brush.kind === 'building' && brush.type !== 'village' ? (
          <div className="editor-row">
            <span className="muted small">归属</span>
            {Array.from({ length: map.deployZones.length }, (_, i) => i).map((owner) => (
              <button
                key={owner}
                type="button"
                data-testid={'brush-owner-' + owner}
                className={brush.owner === owner ? 'picked' : ''}
                onClick={() => setBrush({ ...brush, owner })}
              >
                <span className="swatch" style={{ background: OWNER_COLORS[owner % OWNER_COLORS.length] }} /> 玩家 {owner + 1}
              </button>
            ))}
          </div>
        ) : null}

        <div className="editor-row">
          <span className="muted small">部署区（拖出一个矩形）</span>
          {map.deployZones.map((_, index) => (
            <button
              key={index}
              type="button"
              data-testid={'brush-zone-' + index}
              className={brush.kind === 'zone' && brush.player === index ? 'picked' : ''}
              onClick={() => setBrush({ kind: 'zone', player: index })}
            >
              <span className="swatch" style={{ background: OWNER_COLORS[index % OWNER_COLORS.length] }} /> 玩家 {index + 1}
            </button>
          ))}
        </div>

        <div className="editor-row">
          <span className="muted small">格子大小</span>
          {CELL_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              data-testid={'editor-cellsize-' + size}
              className={cellSize === size ? 'picked' : ''}
              onClick={() => setCellSize(size)}
            >
              {size}px
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="editor-canvas-wrap">
          <canvas
            ref={canvasRef}
            data-testid="editor-canvas"
            data-cell-size={cellSize}
            width={canvasW}
            height={canvasH}
            style={{ width: canvasW, height: canvasH, touchAction: 'none', cursor: 'crosshair' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerLeave={() => {
              setHover(null)
              endDrag()
            }}
          />
        </div>
        <p className="muted small" data-testid="editor-hover">
          {hover ? `当前格：(${hover.x}, ${hover.y}) · ${DATA.terrain[map.terrain[hover.y * map.width + hover.x]]?.name ?? '?'}` : '把鼠标移到图上可查看格子信息'}
        </p>
      </section>

      <section className="panel">
        <h2>校验</h2>
        <p className={validation.ok ? 'muted small' : 'muted small warn-text'} data-testid="editor-validation">
          {validation.ok
            ? `校验通过${validation.warnings.length > 0 ? `（${validation.warnings.length} 条提示）` : ''}`
            : `发现 ${validation.errors.length} 处问题，修正后才能保存/试玩`}
        </p>
        {validation.errors.length > 0 ? (
          <ul className="editor-issues" data-testid="editor-errors">
            {validation.errors.map((issue, i) => (
              <li key={i}>⛔ {issue.message}</li>
            ))}
          </ul>
        ) : null}
        {validation.warnings.length > 0 ? (
          <ul className="editor-issues" data-testid="editor-warnings">
            {validation.warnings.map((issue, i) => (
              <li key={i}>⚠️ {issue.message}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="panel">
        <h2>保存与试玩</h2>
        <div className="editor-row">
          <button type="button" className="primary" data-testid="editor-save" onClick={doSave} disabled={!validation.ok}>
            保存到本机
          </button>
          <button type="button" data-testid="editor-save-as" onClick={doSaveAs} disabled={!validation.ok}>
            另存为
          </button>
          <button type="button" data-testid="editor-new" onClick={doNew}>
            新建模板
          </button>
          <button
            type="button"
            className="primary"
            data-testid="editor-playtest"
            disabled={!validation.ok}
            onClick={doPlaytest}
          >
            用这张图开始单人练习
          </button>
        </div>
        <p className="muted small" data-testid="editor-dirty">
          {savedId === null ? '尚未保存到本机' : dirty ? '有未保存的改动' : '已保存'}
        </p>
        {message ? (
          <p className="muted small" data-testid="editor-message">
            {message}
          </p>
        ) : null}
      </section>

      <section className="panel">
        <h2>我的地图（{savedMaps.length}）</h2>
        {savedMaps.length === 0 ? (
          <p className="muted small" data-testid="editor-empty">
            还没有保存过地图。改好上面这张后点「保存到本机」。
          </p>
        ) : (
          <ul className="editor-map-list" data-testid="editor-map-list">
            {savedMaps.map((record) => (
              <li key={record.id}>
                <button type="button" data-testid={'editor-map-' + record.id} onClick={() => doOpen(record)}>
                  {record.name}
                  <span className="muted small">
                    {' '}
                    {record.width}×{record.height} · {record.deployZones.length} 人
                    {savedId === record.id ? ' · 正在编辑' : ''}
                  </span>
                </button>
                <button type="button" data-testid={'editor-delete-' + record.id} onClick={() => doDelete(record)}>
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>导入 / 导出</h2>
        <div className="editor-row">
          <button type="button" data-testid="editor-export" onClick={doExport}>
            导出 JSON 文件
          </button>
          <button type="button" data-testid="editor-copy" onClick={doCopyJson}>
            复制 JSON
          </button>
          <button type="button" data-testid="editor-toggle-import" onClick={() => setShowImport((v) => !v)}>
            {showImport ? '收起导入框' : '粘贴 JSON 导入'}
          </button>
        </div>
        {showImport ? (
          <div>
            <textarea
              data-testid="editor-import-text"
              rows={6}
              value={importText}
              placeholder="把地图 JSON 粘到这里，然后点下面的「载入」"
              onChange={(e) => setImportText(e.target.value)}
            />
            <button type="button" data-testid="editor-import" onClick={doImport}>
              载入
            </button>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <button type="button" data-testid="back-home" onClick={() => onNavigate('home')}>
          返回主页
        </button>
      </section>

      <AppFooter onNavigate={onNavigate} />
    </div>
  )
}
