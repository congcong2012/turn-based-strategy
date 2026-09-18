/**
 * 棋盘渲染（PixiJS 8）：只负责"把权威状态画出来 + 把点击换算成格子坐标"。
 * 不持有任何游戏规则，所有合法性判断都在 src/game/**。
 */

import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js'
import { DATA } from '../game/data'
import type { GameData } from '../game/data'
import { getMap } from '../game/data'
import type { GameState } from '../game/types'

export const TILE = 48

export interface BoardView {
  state: GameState
  /** 可移动到的格子 "x,y" */
  reachable: string[]
  /** 可攻击目标所在格 "x,y" */
  targets: string[]
  selectedUnitId: string | null
  selectedBuildingId: string | null
  /** 需要高亮部署区的玩家序号 */
  deployZoneIndex: number | null
}

const OWNER_COLORS = [0xc8503c, 0x3fa7a0, 0xd9a441, 0x8a6fd0]
const NEUTRAL = 0x6b6255
const MIN_SCALE = 0.5
const MAX_SCALE = 2

function colorOf(hex: string): number {
  return Number.parseInt(hex.replace('#', ''), 16)
}

export class BoardApp {
  private app = new Application()
  private world = new Container()
  private terrainLayer = new Container()
  private overlayLayer = new Container()
  private buildingLayer = new Container()
  private unitLayer = new Container()
  private view: BoardView | null = null
  private data: GameData = DATA
  private scale = 1
  private offsetX = 0
  private offsetY = 0
  private dragging = false
  private moved = false
  private lastPointer = { x: 0, y: 0 }
  private tileHandler: ((x: number, y: number) => void) | null = null
  private canvas: HTMLCanvasElement | null = null
  private resizeObserver: ResizeObserver | null = null
  private userInteracted = false
  private initialized = false
  private destroyed = false

  async mount(container: HTMLElement): Promise<void> {
    await this.app.init({
      width: container.clientWidth || 800,
      height: container.clientHeight || 600,
      background: 0x14110f,
      antialias: true,
      resolution: Math.min(2, globalThis.devicePixelRatio || 1),
      autoDensity: true,
    })
    // React StrictMode 会"挂载→卸载→再挂载"：若初始化完成前已被 destroy，则直接收尾。
    // 否则 Pixi 内部会在未初始化的 Application 上调 _cancelResize 抛错，把整棵 React 树带崩。
    if (this.destroyed) {
      this.app.destroy(true)
      return
    }
    this.initialized = true
    this.canvas = this.app.canvas
    container.appendChild(this.canvas)
    this.world.addChild(this.terrainLayer, this.overlayLayer, this.buildingLayer, this.unitLayer)
    this.app.stage.addChild(this.world)
    this.attachPointerHandlers()
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize(container))
      this.resizeObserver.observe(container)
    }
    this.fit(container)
  }

  setTileHandler(handler: (x: number, y: number) => void): void {
    this.tileHandler = handler
  }

  setView(view: BoardView): void {
    this.view = view
    if (this.initialized && !this.destroyed) this.render()
  }

  /** 格子中心 → 画布内坐标（DEV/E2E 用：让测试能点中具体格子） */
  project(x: number, y: number): { x: number; y: number } {
    return {
      x: this.offsetX + (x + 0.5) * TILE * this.scale,
      y: this.offsetY + (y + 0.5) * TILE * this.scale,
    }
  }

  getScale(): number {
    return this.scale
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    // 还没 init 完成时不能调用 Application.destroy（会抛 _cancelResize）
    if (this.initialized) this.app.destroy(true)
  }

  private resize(container: HTMLElement): void {
    const w = container.clientWidth
    const h = container.clientHeight
    if (w <= 0 || h <= 0) return
    this.app.renderer.resize(w, h)
    // 用户还没手动拖拽/缩放时，跟随容器尺寸自动适配棋盘
    if (!this.userInteracted) this.fit(container)
  }

  private boardSize() {
    const map = this.view ? getMap(this.view.state.mapId, this.data) : null
    return { width: (map?.width ?? 24) * TILE, height: (map?.height ?? 24) * TILE }
  }

  private fit(container: HTMLElement): void {
    const { width, height } = this.boardSize()
    const cw = container.clientWidth || this.app.renderer.width
    const ch = container.clientHeight || this.app.renderer.height
    const raw = Math.min(cw / width, ch / height)
    this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, raw))
    this.offsetX = (cw - width * this.scale) / 2
    this.offsetY = (ch - height * this.scale) / 2
    this.applyCamera()
  }

  private applyCamera(): void {
    this.world.scale.set(this.scale)
    this.world.position.set(this.offsetX, this.offsetY)
  }

  private attachPointerHandlers(): void {
    const canvas = this.canvas
    if (!canvas) return

    canvas.addEventListener('pointerdown', (event) => {
      this.userInteracted = true
      this.dragging = true
      this.moved = false
      this.lastPointer = { x: event.clientX, y: event.clientY }
      canvas.setPointerCapture(event.pointerId)
    })
    canvas.addEventListener('pointermove', (event) => {
      if (!this.dragging) return
      const dx = event.clientX - this.lastPointer.x
      const dy = event.clientY - this.lastPointer.y
      if (Math.abs(dx) + Math.abs(dy) > 3) this.moved = true
      this.offsetX += dx
      this.offsetY += dy
      this.lastPointer = { x: event.clientX, y: event.clientY }
      this.applyCamera()
    })
    canvas.addEventListener('pointerup', (event) => {
      this.dragging = false
      if (this.moved) return
      const rect = canvas.getBoundingClientRect()
      const x = Math.floor((event.clientX - rect.left - this.offsetX) / this.scale / TILE)
      const y = Math.floor((event.clientY - rect.top - this.offsetY) / this.scale / TILE)
      this.tileHandler?.(x, y)
    })
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault()
      this.userInteracted = true
      const rect = canvas.getBoundingClientRect()
      const px = event.clientX - rect.left
      const py = event.clientY - rect.top
      const before = this.scale
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * (event.deltaY < 0 ? 1.1 : 0.9)))
      this.scale = next
      this.offsetX = px - ((px - this.offsetX) / before) * next
      this.offsetY = py - ((py - this.offsetY) / before) * next
      this.applyCamera()
    }, { passive: false })

    canvas.style.touchAction = 'none'
    canvas.style.cursor = 'grab'
  }

  private render(): void {
    const view = this.view
    this.terrainLayer.removeChildren()
    this.overlayLayer.removeChildren()
    this.buildingLayer.removeChildren()
    this.unitLayer.removeChildren()
    if (!view) return

    const { state } = view
    const map = getMap(state.mapId, this.data)
    const reachable = new Set(view.reachable)
    const targets = new Set(view.targets)
    const zone = view.deployZoneIndex === null ? null : map.deployZones[view.deployZoneIndex]

    // 地形
    const terrain = new Graphics()
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const t = this.data.terrain[map.terrain[y * map.width + x]]
        terrain.rect(x * TILE, y * TILE, TILE, TILE).fill(colorOf(t.color))
      }
    }
    terrain.rect(0, 0, map.width * TILE, map.height * TILE).stroke({ width: 2, color: 0x000000, alpha: 0.35 })
    this.terrainLayer.addChild(terrain)

    // 叠加层：部署区 / 可达 / 可攻击 / 选中
    const overlay = new Graphics()
    if (zone) {
      overlay
        .rect(zone.x0 * TILE, zone.y0 * TILE, (zone.x1 - zone.x0 + 1) * TILE, (zone.y1 - zone.y0 + 1) * TILE)
        .fill({ color: 0x3fa7a0, alpha: 0.16 })
        .stroke({ width: 2, color: 0x3fa7a0, alpha: 0.6 })
    }
    for (const key of reachable) {
      const [x, y] = key.split(',').map(Number)
      overlay.rect(x * TILE + 3, y * TILE + 3, TILE - 6, TILE - 6).fill({ color: 0x4f9fd4, alpha: 0.3 })
    }
    for (const key of targets) {
      const [x, y] = key.split(',').map(Number)
      overlay.rect(x * TILE + 2, y * TILE + 2, TILE - 4, TILE - 4).fill({ color: 0xd94f3d, alpha: 0.35 })
    }
    const selected = state.units.find((u) => u.id === view.selectedUnitId)
    if (selected) {
      overlay.rect(selected.x * TILE + 1, selected.y * TILE + 1, TILE - 2, TILE - 2).stroke({ width: 3, color: 0xf0d27a })
    }
    const selectedBuilding = state.buildings.find((b) => b.id === view.selectedBuildingId)
    if (selectedBuilding) {
      overlay.rect(selectedBuilding.x * TILE + 1, selectedBuilding.y * TILE + 1, TILE - 2, TILE - 2).stroke({ width: 3, color: 0xf0d27a })
    }
    // 占领进度
    for (const b of state.buildings) {
      if (!b.capture) continue
      const ratio = Math.min(1, b.capture.points / this.data.capturePoints)
      const ownerIndex = Math.max(0, state.players.indexOf(b.capture.playerId))
      overlay
        .rect(b.x * TILE + 4, b.y * TILE + TILE - 10, (TILE - 8) * ratio, 6)
        .fill({ color: OWNER_COLORS[ownerIndex % OWNER_COLORS.length], alpha: 0.95 })
    }
    this.overlayLayer.addChild(overlay)

    // 据点
    for (const b of state.buildings) {
      const type = this.data.buildings[b.type]
      const index = b.owner === null ? -1 : state.players.indexOf(b.owner)
      const fill = index < 0 ? NEUTRAL : OWNER_COLORS[index % OWNER_COLORS.length]
      const g = new Graphics()
      g.roundRect(b.x * TILE + 6, b.y * TILE + 6, TILE - 12, TILE - 12, 6).fill(fill).stroke({ width: 2, color: 0x1a1512 })
      this.buildingLayer.addChild(g)
      const label = new Text({
        text: type.glyph,
        style: new TextStyle({ fontSize: 20, fill: 0xf5efe2, fontWeight: '700' }),
      })
      label.anchor.set(0.5)
      label.position.set(b.x * TILE + TILE / 2, b.y * TILE + TILE / 2 - 2)
      this.buildingLayer.addChild(label)
    }

    // 单位
    for (const unit of state.units) {
      const type = this.data.units[unit.type]
      const index = Math.max(0, state.players.indexOf(unit.owner))
      const color = OWNER_COLORS[index % OWNER_COLORS.length]
      const cx = unit.x * TILE + TILE / 2
      const cy = unit.y * TILE + TILE / 2

      const circle = new Graphics()
      circle.circle(cx, cy - 2, TILE * 0.34).fill(color).stroke({ width: 2, color: 0x14110f })
      if (unit.acted) circle.circle(cx, cy - 2, TILE * 0.34).fill({ color: 0x000000, alpha: 0.35 })
      this.unitLayer.addChild(circle)

      const glyph = new Text({
        text: type.glyph,
        style: new TextStyle({ fontSize: 17, fill: 0xffffff, fontWeight: '700' }),
      })
      glyph.anchor.set(0.5)
      glyph.position.set(cx, cy - 3)
      this.unitLayer.addChild(glyph)

      const bar = new Graphics()
      const ratio = Math.max(0, unit.hp) / type.hp
      bar.rect(cx - 16, cy + 12, 32, 4).fill(0x14110f)
      bar.rect(cx - 16, cy + 12, 32 * ratio, 4).fill(ratio > 0.5 ? 0x6fcf6a : ratio > 0.25 ? 0xd9a441 : 0xd94f3d)
      this.unitLayer.addChild(bar)
    }
  }
}
