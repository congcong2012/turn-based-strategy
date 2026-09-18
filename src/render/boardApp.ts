/**
 * 棋盘渲染（PixiJS 8，动态加载以分包）：
 * 只负责"把权威状态画出来 + 把点击换算成格子坐标 + 播放状态变化动画"。
 * 不持有任何游戏规则，所有合法性判断都在 src/game/**。
 */

import type { Application, Container } from 'pixi.js'
import { DATA, getMap } from '../game/data'
import type { GameData } from '../game/data'
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
  /** M5：单位 → 本次移动的逐格路径（含终点），用于播放移动动画 */
  movePaths?: Record<string, Array<{ x: number; y: number }>>
}

const OWNER_COLORS = [0xc8503c, 0x3fa7a0, 0xd9a441, 0x8a6fd0]
const NEUTRAL = 0x6b6255
// 小屏（手机 393px 宽）要能一次看全 24×24 棋盘：1152px 宽 → 需要 ~0.34 倍，因此下限放到 0.2
const MIN_SCALE = 0.2
const MAX_SCALE = 2
const MOVE_ANIM_MS = 220
const FLASH_MS = 380
const FLOATER_MS = 700

function colorOf(hex: string): number {
  return Number.parseInt(hex.replace('#', ''), 16)
}

interface UnitSnapshot {
  x: number
  y: number
  hp: number
}

export class BoardApp {
  private app!: Application
  private world!: Container
  private terrainLayer!: Container
  private overlayLayer!: Container
  private buildingLayer!: Container
  private unitLayer!: Container
  private pixi: typeof import('pixi.js') | null = null

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

  /** 动画状态：上一帧各单位的格子位置与血量 */
  private snapshots = new Map<string, UnitSnapshot>()
  private animPath = new Map<string, Array<{ x: number; y: number }>>()
  private animStartedAt = 0
  private animDuration = MOVE_ANIM_MS
  private animating = false
  private flashes = new Map<string, number>()
  private floaters: Array<{ text: string; x: number; y: number; color: number; startAt: number }> = []
  private tickHandler: (() => void) | null = null
  /** 多指触摸（双指缩放） */
  private pointers = new Map<number, { x: number; y: number }>()
  private pinchDistance = 0

  async mount(container: HTMLElement): Promise<void> {
    // 动态 import：PixiJS 单独分包，只有真正进入对局时才下载
    const PIXI = await import('pixi.js')
    this.pixi = PIXI

    const app = new PIXI.Application()
    await app.init({
      width: container.clientWidth || 800,
      height: container.clientHeight || 600,
      background: 0x14110f,
      antialias: true,
      resolution: Math.min(2, globalThis.devicePixelRatio || 1),
      autoDensity: true,
      // 显式走 WebGL：Pixi v8 默认会先尝试 WebGPU，在没有 GPU / 移动端模拟等环境下
      // init() 可能既不报错也不 resolve（表现为棋盘空白），棋盘 2D 渲染用 WebGL 足够。
      preference: 'webgl',
    })
    // React StrictMode 会"挂载→卸载→再挂载"：初始化期间已被 destroy 就直接收尾，
    // 否则 Pixi 会在未初始化的 Application 上调私有方法抛错，把整棵 React 树带崩。
    if (this.destroyed) {
      app.destroy(true)
      return
    }
    this.app = app
    this.initialized = true
    this.canvas = app.canvas

    this.world = new PIXI.Container()
    this.terrainLayer = new PIXI.Container()
    this.overlayLayer = new PIXI.Container()
    this.buildingLayer = new PIXI.Container()
    this.unitLayer = new PIXI.Container()
    this.world.addChild(this.terrainLayer, this.overlayLayer, this.buildingLayer, this.unitLayer)
    app.stage.addChild(this.world)

    container.appendChild(this.canvas)
    this.attachPointerHandlers()
    this.tickHandler = () => this.onTick()
    app.ticker.add(this.tickHandler)
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
    if (!this.initialized || this.destroyed) return
    this.detectChanges(view.state)
    this.render()
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
    if (this.initialized) {
      if (this.tickHandler) this.app.ticker.remove(this.tickHandler)
      this.app.destroy(true)
    }
  }

  /** 对比新旧状态，决定要播放的动画（移动补间 / 受击闪红） */
  private detectChanges(state: GameState): void {
    const now = Date.now()
    const next = new Map<string, UnitSnapshot>()
    let startedAnimation = false
    let longestPath = 1

    for (const unit of state.units) {
      const prev = this.snapshots.get(unit.id)
      next.set(unit.id, { x: unit.x, y: unit.y, hp: unit.hp })
      if (!prev) continue

      if (prev.x !== unit.x || prev.y !== unit.y) {
        // 优先用引擎给的逐格路径；拿不到就退化成直线
        const given = this.view?.movePaths?.[unit.id]
        const path = given && given.length > 0 ? given : [{ x: unit.x, y: unit.y }]
        this.animPath.set(unit.id, path)
        startedAnimation = true
        longestPath = Math.max(longestPath, path.length)
      }
      if (unit.hp < prev.hp) {
        this.flashes.set(unit.id, now + FLASH_MS)
        this.floaters.push({
          text: '-' + (prev.hp - unit.hp),
          x: prev.x,
          y: prev.y,
          color: 0xff8a6a,
          startAt: now,
        })
      }
    }

    // 阵亡单位：在它最后的位置弹一个歼灭提示
    for (const [id, prev] of this.snapshots) {
      if (next.has(id)) continue
      this.floaters.push({ text: '歼灭', x: prev.x, y: prev.y, color: 0xf0d27a, startAt: now })
    }

    this.snapshots = next
    if (startedAnimation) {
      this.animStartedAt = now
      // 每格约 110ms，整体限制在 180–700ms
      this.animDuration = Math.max(180, Math.min(700, longestPath * 110))
      this.animating = true
    }
    this.floaters = this.floaters.filter((f) => now - f.startAt < FLOATER_MS)
    for (const [id, expiry] of [...this.flashes]) {
      if (expiry <= now) this.flashes.delete(id)
    }
  }

  private onTick(): void {
    const now = Date.now()
    const animating = this.animating && now - this.animStartedAt < this.animDuration
    const flashing = [...this.flashes.values()].some((expiry) => expiry > now)
    const floating = this.floaters.some((f) => now - f.startAt < FLOATER_MS)
    if (!animating && !flashing && !floating) {
      if (this.animating) {
        this.animating = false
        this.animPath.clear()
        this.render()
      }
      return
    }
    if (this.view) this.render()
  }

  /** 单位当前应画在哪：沿逐格路径做分段插值 */
  private unitPixel(unitId: string, x: number, y: number): { x: number; y: number } {
    const path = this.animPath.get(unitId)
    if (!path || !this.animating) {
      return { x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 }
    }
    const t = Math.min(1, (Date.now() - this.animStartedAt) / this.animDuration)
    const eased = t
    const legs = path.length
    const pos = eased * legs
    const index = Math.min(legs - 1, Math.floor(pos))
    const local = pos - index
    const from = index === 0 ? null : path[index - 1]
    const prev = this.snapshots.get(unitId)
    const startX = from ? from.x : (prev?.x ?? x)
    const startY = from ? from.y : (prev?.y ?? y)
    // 起点：路径第一段从"移动前的位置"出发
    const originX = index === 0 ? startX : path[index - 1].x
    const originY = index === 0 ? startY : path[index - 1].y
    const target = path[index]
    const px = (originX + (target.x - originX) * local) * TILE + TILE / 2
    const py = (originY + (target.y - originY) * local) * TILE + TILE / 2
    return { x: px, y: py }
  }

  private resize(container: HTMLElement): void {
    const w = container.clientWidth
    const h = container.clientHeight
    if (w <= 0 || h <= 0) return
    this.app.renderer.resize(w, h)
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

  /** 手动把棋盘重新适配到可视区（供 UI 按钮调用） */
  refit(): void {
    if (this.destroyed || !this.initialized) return
    this.userInteracted = false
    const host = this.canvas?.parentElement
    if (host) this.fit(host)
  }

  /** 相机边界：棋盘始终至少有一部分留在视野内（避免手机上把棋盘拖丢） */
  private clampOffsets(): void {
    const { width, height } = this.boardSize()
    const viewW = this.app?.renderer?.width ? this.app.renderer.width / (this.app.renderer.resolution || 1) : 0
    const viewH = this.app?.renderer?.height ? this.app.renderer.height / (this.app.renderer.resolution || 1) : 0
    if (viewW <= 0 || viewH <= 0) return
    const scaledW = width * this.scale
    const scaledH = height * this.scale
    const marginX = Math.min(80, scaledW * 0.5)
    const marginY = Math.min(80, scaledH * 0.5)
    this.offsetX = Math.max(marginX - scaledW, Math.min(viewW - marginX, this.offsetX))
    this.offsetY = Math.max(marginY - scaledH, Math.min(viewH - marginY, this.offsetY))
  }

  private applyCamera(): void {
    this.clampOffsets()
    this.world.scale.set(this.scale)
    this.world.position.set(this.offsetX, this.offsetY)
  }

  private attachPointerHandlers(): void {
    const canvas = this.canvas
    if (!canvas) return

    const pinchInfo = () => {
      const [a, b] = [...this.pointers.values()]
      return { distance: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 }
    }

    canvas.addEventListener('pointerdown', (event) => {
      this.userInteracted = true
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      this.dragging = true
      this.moved = false
      this.lastPointer = { x: event.clientX, y: event.clientY }
      if (this.pointers.size === 2) {
        this.pinchDistance = pinchInfo().distance
        this.moved = true // 双指期间不触发点击
      }
      try {
        canvas.setPointerCapture(event.pointerId)
      } catch {
        /* 合成事件或指针已释放时忽略 */
      }
    })
    canvas.addEventListener('pointermove', (event) => {
      if (this.pointers.has(event.pointerId)) {
        this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      }
      // 双指缩放：按两指距离变化缩放，并以两指中点为锚
      if (this.pointers.size >= 2) {
        const info = pinchInfo()
        if (this.pinchDistance > 0 && info.distance > 0) {
          const rect = canvas.getBoundingClientRect()
          const px = info.midX - rect.left
          const py = info.midY - rect.top
          const before = this.scale
          const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * (info.distance / this.pinchDistance)))
          this.scale = next
          this.offsetX = px - ((px - this.offsetX) / before) * next
          this.offsetY = py - ((py - this.offsetY) / before) * next
          this.applyCamera()
        }
        this.pinchDistance = info.distance
        return
      }
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
      this.pointers.delete(event.pointerId)
      if (this.pointers.size < 2) this.pinchDistance = 0
      this.dragging = this.pointers.size > 0
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
    const PIXI = this.pixi
    if (!view || !PIXI) return

    this.terrainLayer.removeChildren()
    this.overlayLayer.removeChildren()
    this.buildingLayer.removeChildren()
    this.unitLayer.removeChildren()

    const { state } = view
    const map = getMap(state.mapId, this.data)
    const reachable = new Set(view.reachable)
    const targets = new Set(view.targets)
    const zone = view.deployZoneIndex === null ? null : map.deployZones[view.deployZoneIndex]
    const now = Date.now()

    // 地形
    const terrain = new PIXI.Graphics()
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const t = this.data.terrain[map.terrain[y * map.width + x]]
        terrain.rect(x * TILE, y * TILE, TILE, TILE).fill(colorOf(t.color))
      }
    }
    terrain.rect(0, 0, map.width * TILE, map.height * TILE).stroke({ width: 2, color: 0x000000, alpha: 0.35 })
    this.terrainLayer.addChild(terrain)

    // 叠加层
    const overlay = new PIXI.Graphics()
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
      const g = new PIXI.Graphics()
      g.roundRect(b.x * TILE + 6, b.y * TILE + 6, TILE - 12, TILE - 12, 6).fill(fill).stroke({ width: 2, color: 0x1a1512 })
      this.buildingLayer.addChild(g)
      const label = new PIXI.Text({
        text: type.glyph,
        style: { fontSize: 20, fill: 0xf5efe2, fontWeight: '700' },
      })
      label.anchor.set(0.5)
      label.position.set(b.x * TILE + TILE / 2, b.y * TILE + TILE / 2 - 2)
      this.buildingLayer.addChild(label)
    }

    // 单位（动画期间使用插值坐标）
    for (const unit of state.units) {
      const type = this.data.units[unit.type]
      const index = Math.max(0, state.players.indexOf(unit.owner))
      const color = OWNER_COLORS[index % OWNER_COLORS.length]
      const { x: cx, y: cy } = this.unitPixel(unit.id, unit.x, unit.y)

      // 受击闪光
      const flashExpiry = this.flashes.get(unit.id)
      if (flashExpiry && flashExpiry > now) {
        const halo = new PIXI.Graphics()
        halo.circle(cx, cy - 2, TILE * 0.44).fill({ color: 0xff5a3c, alpha: 0.5 })
        this.unitLayer.addChild(halo)
      }

      const circle = new PIXI.Graphics()
      circle.circle(cx, cy - 2, TILE * 0.34).fill(color).stroke({ width: 2, color: 0x14110f })
      if (unit.acted) circle.circle(cx, cy - 2, TILE * 0.34).fill({ color: 0x000000, alpha: 0.35 })
      this.unitLayer.addChild(circle)

      const glyph = new PIXI.Text({
        text: type.glyph,
        style: { fontSize: 17, fill: 0xffffff, fontWeight: '700' },
      })
      glyph.anchor.set(0.5)
      glyph.position.set(cx, cy - 3)
      this.unitLayer.addChild(glyph)

      const bar = new PIXI.Graphics()
      const ratio = Math.max(0, unit.hp) / type.hp
      bar.rect(cx - 16, cy + 12, 32, 4).fill(0x14110f)
      bar.rect(cx - 16, cy + 12, 32 * ratio, 4).fill(ratio > 0.5 ? 0x6fcf6a : ratio > 0.25 ? 0xd9a441 : 0xd94f3d)
      this.unitLayer.addChild(bar)
    }

    // 浮动数字（伤害 / 歼灭）：上升并淡出
    for (const floater of this.floaters) {
      const age = (Date.now() - floater.startAt) / FLOATER_MS
      if (age >= 1) continue
      const text = new PIXI.Text({
        text: floater.text,
        style: { fontSize: 18, fill: floater.color, fontWeight: '700', stroke: { color: 0x14110f, width: 3 } },
      })
      text.anchor.set(0.5)
      text.position.set(floater.x * TILE + TILE / 2, floater.y * TILE + TILE / 2 - 14 - age * 26)
      text.alpha = 1 - age * age
      this.unitLayer.addChild(text)
    }
  }
}
