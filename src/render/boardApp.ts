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
  /** M7：选中单位的攻击范围格（"x,y"），用红色边框标出 */
  attackRange?: string[]
  /** M7：射程"太近"打不到的格（仅间接单位，灰色边框） */
  attackTooClose?: string[]
}

const OWNER_COLORS = [0xc8503c, 0x3fa7a0, 0xd9a441, 0x8a6fd0]
const NEUTRAL = 0x6b6255
// 小屏（手机 393px 宽）要能一次看全 24×24 棋盘：1152px 宽 → 需要 ~0.34 倍，因此下限放到 0.2
const MIN_SCALE = 0.2

/**
 * 触摸长按多久算"我要看这个单位"。
 *
 * 450ms 是经验值：短于 300ms 容易在拖拽起手时误触，长于 600ms 玩家会以为没反应。
 * 手指一旦移动超过 8px 就取消（那是想平移地图，见 `pointermove`）。
 */
const LONG_PRESS_MS = 450
/** 桌面最多放大 2 倍；触屏设备放到 3.5 倍（M7：手机上看得更清楚） */
const MAX_SCALE_DESKTOP = 2
const MAX_SCALE_TOUCH = 3.5

function maxScaleForDevice(): number {
  try {
    return globalThis.matchMedia?.('(pointer: coarse)').matches ? MAX_SCALE_TOUCH : MAX_SCALE_DESKTOP
  } catch {
    return MAX_SCALE_DESKTOP
  }
}
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
  private maxScale = maxScaleForDevice()
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
  private rafId: number | null = null
  /** 多指触摸（双指缩放） */
  private pointers = new Map<number, { x: number; y: number }>()
  private pinchDistance = 0

  // —— 「查看单位详情」的指针上报（悬停 / 长按）——
  //
  // 桌面用 hover、触摸屏用长按 —— 后者必须走定时器，因为触摸没有 hover。
  // 上报的是**格子坐标**而不是单位：有没有东西、要不要显示卡片由上层决定
  // （棋盘层不该知道 `GameState` 里哪个 id 是谁的部队）。
  private inspectHandler: ((tile: { x: number; y: number } | null) => void) | null = null
  /** 上一次上报的格子，用来吞掉同格重复上报（pointermove 每秒几十次） */
  private lastInspectKey = ''
  private longPressTimer: ReturnType<typeof setTimeout> | null = null
  private longPressFrom: { x: number; y: number } | null = null
  /** 长按已经触发过：要吃掉紧跟着的那次 pointerup，否则会顺手把单位"点选/移动"掉 */
  private longPressFired = false

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
      // 关键：不要让 Pixi 常驻 60fps 渲染。棋盘是静态的，只在"状态变化/动画播放中"才画，
      // 否则主线程一直被占用（移动端发热、自动化测试里元素"永不稳定"）。
      autoStart: false,
    })
    // React StrictMode 会"挂载→卸载→再挂载"：初始化期间已被 destroy 就直接收尾，
    // 否则 Pixi 会在未初始化的 Application 上调私有方法抛错，把整棵 React 树带崩。
    // ★ 这里**绝不能写 `app.destroy(true)`** —— 原因见 `destroy()` 上方那段注释。
    if (this.destroyed) {
      app.destroy({ removeView: true })
      return
    }
    this.app = app
    this.canvas = app.canvas

    this.world = new PIXI.Container()
    this.terrainLayer = new PIXI.Container()
    this.overlayLayer = new PIXI.Container()
    this.buildingLayer = new PIXI.Container()
    this.unitLayer = new PIXI.Container()
    this.world.addChild(this.terrainLayer, this.overlayLayer, this.buildingLayer, this.unitLayer)
    app.stage.addChild(this.world)

    // 常驻渲染对象（只在 mount 时创建一次，之后复用）
    this.terrainG = new PIXI.Graphics()
    this.overlayG = new PIXI.Graphics()
    this.zoneLabel = new PIXI.Text({
      text: '',
      style: { fontSize: 20, fill: 0x9ff0e8, fontWeight: '700', stroke: { color: 0x0f2a28, width: 4 } },
    })
    this.zoneLabel.anchor.set(0.5)
    this.zoneLabel.visible = false
    this.terrainLayer.addChild(this.terrainG)
    this.overlayLayer.addChild(this.overlayG, this.zoneLabel)

    // 注意：必须等所有常驻对象都建好之后再置 initialized ——
    // 否则 setView 会在窗口期调用到 undefined，抛错会让 React 卸载整棵树（表现为玩家掉线）
    this.initialized = true

    container.appendChild(this.canvas)
    this.attachPointerHandlers()
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize(container))
      this.resizeObserver.observe(container)
    }
    this.fit(container)
  }

  setTileHandler(handler: ((x: number, y: number) => void) | null): void {
    this.tileHandler = handler
  }

  /**
   * 上报"指针正在看哪个格子"（悬停或长按）。传 `null` 表示离开了棋盘 / 收起详情。
   * 上层据此决定要不要弹单位详情卡。
   */
  setInspectHandler(handler: ((tile: { x: number; y: number } | null) => void) | null): void {
    this.inspectHandler = handler
  }

  private lastViewKey = ''

  setView(view: BoardView): void {
    this.view = view
    if (!this.initialized || this.destroyed) return
    const key =
      view.state.rev +
      '|' +
      view.state.phase +
      '|' +
      view.state.turnIndex +
      '|' +
      view.state.units.length +
      '|' +
      (view.selectedUnitId ?? '') +
      '|' +
      (view.selectedBuildingId ?? '') +
      '|' +
      view.reachable.length +
      '|' +
      view.targets.length +
      '|' +
      (view.deployZoneIndex ?? '')
    if (key === this.lastViewKey) return
    this.lastViewKey = key
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

  /** 相机状态（DEV/?debug=1：便于排查"点不中格子"这类问题） */
  getCamera(): { scale: number; offsetX: number; offsetY: number; viewW: number; viewH: number; tileAtOrigin: { x: number; y: number } } {
    const viewW = this.canvas?.getBoundingClientRect().width ?? 0
    const viewH = this.canvas?.getBoundingClientRect().height ?? 0
    return {
      scale: this.scale,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
      viewW,
      viewH,
      // 画布左上角对应的格子坐标（负数表示棋盘左上方在画布之外）
      tileAtOrigin: { x: -this.offsetX / this.scale / TILE, y: -this.offsetY / this.scale / TILE },
    }
  }

  /**
   * 销毁 Pixi Application。
   *
   * ★★ **第一个参数必须传 `{ removeView: true }`，绝不能图省事传 `true`** ★★
   *
   * 这是 2026-10-07 排查 `[board] 渲染这一帧失败 … Cannot read properties of null
   * (reading 'clear')` 得出的结论（该报错此前一直出现在**活跃对局**里，不只是页面卸载）：
   *
   *  1. Pixi v8 的 batch 池是**模块级全局**的（`Batcher.mjs` 的 `batchPool`），跨所有 renderer 共享；
   *  2. `app.destroy(true)` 的第一个参数会一路传到 `AbstractRenderer.destroy(options)`，
   *     而那里的判断是 `options === true → GlobalResourceRegistry.release()`
   *     —— **无条件**把池里每个 Batch 都 `destroy()`（`batch.textures = null`）并把池清空；
   *  3. 本组件是**异步挂载**的（先 `await import('pixi.js')` 再 `app.init()`），
   *     所以 React StrictMode 的"挂载→卸载→再挂载"会让**两个 Application 同时存在**：
   *     先被销毁的那个把全局池清空，另一个仍在正常使用它；
   *  4. 之后任何一次 `getBatchFromPool()` 都可能拿到 `textures === null` 的 batch，
   *     崩在 `Batcher.break()` 的 `batch.textures.clear()` —— 报错文本完全吻合。
   *
   * `{ removeView: true }` 只做我们真正需要的那件事（把 canvas 从 DOM 摘掉），**不碰全局池**。
   * 跨 renderer 复用池中的 batch 是安全的：WebGL 路径每次绘制都会重新绑定
   * shader / geometry / textures（`GlBatchAdaptor.execute`），Batch 上不留陈旧 GPU 状态。
   */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.clearLongPress()
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.rafId = null
    if (this.initialized) this.app.destroy({ removeView: true })
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
    if (startedAnimation || this.flashes.size > 0 || this.floaters.length > 0) this.ensureAnimationLoop()
    this.floaters = this.floaters.filter((f) => now - f.startAt < FLOATER_MS)
    for (const [id, expiry] of [...this.flashes]) {
      if (expiry <= now) this.flashes.delete(id)
    }
  }

  /** 只有存在进行中的动画/闪光/浮动数字时才持续重绘，其余时间完全静止 */
  private ensureAnimationLoop(): void {
    if (this.rafId !== null || this.destroyed) return
    const step = () => {
      this.rafId = null
      if (this.destroyed) return
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
      this.render()
      this.rafId = requestAnimationFrame(step)
    }
    this.rafId = requestAnimationFrame(step)
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
    // 销毁后 ResizeObserver 的回调仍可能排到队（disconnect 不能撤回已入队的通知），
    // 而 Application.destroy 会把 renderer 置 null ⇒ 必须在这里拦掉，否则报 `reading 'resize'`
    if (this.destroyed) return
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
    this.scale = Math.max(MIN_SCALE, Math.min(this.maxScale, raw))
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

  /** 把镜头对准棋盘上的一个矩形区域（用于「定位我的部署区 / 我的部队」） */
  focusTiles(x0: number, y0: number, x1: number, y1: number, padding = 1.5): void {
    if (this.destroyed || !this.initialized) return
    const cw = this.canvas?.getBoundingClientRect().width ?? this.app.renderer.width
    const ch = this.canvas?.getBoundingClientRect().height ?? this.app.renderer.height
    if (cw <= 0 || ch <= 0) return
    const w = Math.max(1, x1 - x0 + 1 + padding * 2) * TILE
    const h = Math.max(1, y1 - y0 + 1 + padding * 2) * TILE
    const raw = Math.min(cw / w, ch / h)
    this.scale = Math.max(MIN_SCALE, Math.min(this.maxScale, raw))
    this.userInteracted = true
    this.offsetX = cw / 2 - ((x0 + x1 + 1) / 2) * TILE * this.scale
    this.offsetY = ch / 2 - ((y0 + y1 + 1) / 2) * TILE * this.scale
    this.applyCamera()
    this.render()
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
    // 关键：autoStart:false 之后没有常驻 ticker，相机变化必须主动重绘，
    // 否则拖动/滚轮/双指缩放只是改了矩阵，画面永远不刷新（表现为"地图拖不动、缩放没反应"）
    this.scheduleRender()
  }

  /** 用 rAF 合并同一帧内的多次重绘请求（拖动时每次 pointermove 都会调） */
  private scheduleRender(): void {
    if (this.destroyed || !this.initialized) return
    if (this.renderScheduled) return
    this.renderScheduled = true
    requestAnimationFrame(() => {
      this.renderScheduled = false
      this.render()
    })
  }

  /** 画布坐标 → 格子坐标（越界不裁剪：上层用 `unitAt` 查不到东西自然就不显示） */
  private tileAt(clientX: number, clientY: number): { x: number; y: number } | null {
    const canvas = this.canvas
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return {
      x: Math.floor((clientX - rect.left - this.offsetX) / this.scale / TILE),
      y: Math.floor((clientY - rect.top - this.offsetY) / this.scale / TILE),
    }
  }

  /** 上报"在看哪个格子"；同格重复上报直接吞掉（pointermove 每秒几十次，别每次都惊动 React） */
  private reportInspect(tile: { x: number; y: number } | null): void {
    const key = tile ? tile.x + ',' + tile.y : ''
    if (key === this.lastInspectKey) return
    this.lastInspectKey = key
    this.inspectHandler?.(tile)
  }

  private clearLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer)
      this.longPressTimer = null
    }
    this.longPressFrom = null
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
      // 触摸屏没有 hover：按住不动一会儿 = "看这个格子上的单位"。
      // 先收起上一次的详情，长按到点（450ms）后再弹出来。
      if (event.pointerType !== 'mouse') {
        this.longPressFired = false
        this.clearLongPress()
        this.reportInspect(null)
        this.longPressFrom = { x: event.clientX, y: event.clientY }
        const tile = this.tileAt(event.clientX, event.clientY)
        this.longPressTimer = setTimeout(() => {
          this.longPressTimer = null
          this.longPressFired = true
          this.reportInspect(tile)
        }, LONG_PRESS_MS)
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
      // 长按期间手一动就当"拖拽平移"，不再弹详情
      if (this.longPressFrom && !this.moved) {
        const d = Math.abs(event.clientX - this.longPressFrom.x) + Math.abs(event.clientY - this.longPressFrom.y)
        if (d > 8) this.clearLongPress()
      }
      // 桌面：指针停在哪个格子上就看哪个格子（没按着键才叫 hover）
      if (event.pointerType === 'mouse' && this.pointers.size === 0) {
        this.reportInspect(this.tileAt(event.clientX, event.clientY))
      }
      // 双指缩放：按两指距离变化缩放，并以两指中点为锚
      if (this.pointers.size >= 2) {
        const info = pinchInfo()
        if (this.pinchDistance > 0 && info.distance > 0) {
          const rect = canvas.getBoundingClientRect()
          const px = info.midX - rect.left
          const py = info.midY - rect.top
          const before = this.scale
          const next = Math.max(MIN_SCALE, Math.min(this.maxScale, this.scale * (info.distance / this.pinchDistance)))
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
      this.clearLongPress()
      // 长按已经弹过详情了：这一次抬手不该再被当成"点选/移动该格"
      if (this.longPressFired) {
        this.longPressFired = false
        return
      }
      if (this.moved) return
      const tile = this.tileAt(event.clientX, event.clientY)
      if (tile) this.tileHandler?.(tile.x, tile.y)
    })
    // 鼠标移出棋盘就把详情收起来；触摸没有 hover，靠下一次按下收起
    canvas.addEventListener('pointerleave', (event) => {
      if (event.pointerType === 'mouse') this.reportInspect(null)
    })
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault()
      this.userInteracted = true
      const rect = canvas.getBoundingClientRect()
      const px = event.clientX - rect.left
      const py = event.clientY - rect.top
      const before = this.scale
      const next = Math.max(MIN_SCALE, Math.min(this.maxScale, this.scale * (event.deltaY < 0 ? 1.1 : 0.9)))
      this.scale = next
      this.offsetX = px - ((px - this.offsetX) / before) * next
      this.offsetY = py - ((py - this.offsetY) / before) * next
      this.applyCamera()
    }, { passive: false })

    canvas.style.touchAction = 'none'
    canvas.style.cursor = 'grab'
  }

  /** 渲染对象池：Pixi 的 Text/Graphics 必须复用，否则每次重绘都会泄漏纹理，最终把渲染器搞崩 */
  private terrainG = null as unknown as import('pixi.js').Graphics
  private overlayG = null as unknown as import('pixi.js').Graphics
  private zoneLabel = null as unknown as import('pixi.js').Text
  private captureTexts: import('pixi.js').Text[] = []
  private floaterTexts: import('pixi.js').Text[] = []
  private buildingViews = new Map<string, { box: import('pixi.js').Graphics; glyph: import('pixi.js').Text }>()
  private unitViews = new Map<
    string,
    { body: import('pixi.js').Graphics; halo: import('pixi.js').Graphics; glyph: import('pixi.js').Text; bar: import('pixi.js').Graphics }
  >()
  private terrainKey = ''
  /** 渲染失败累计次数（见 render() 的 catch）。以前是个"只报一次"的布尔量，改计数以便断言 */
  private renderErrors = 0
  private renderScheduled = false

  /** 文本对象池：复用 Text，避免每次重绘都新建（Pixi 的 Text 会各自持有纹理） */
  private textAt(pool: 'capture' | 'floater', index: number, style: Record<string, unknown>): import('pixi.js').Text {
    const PIXI = this.pixi as typeof import('pixi.js')
    const list = pool === 'capture' ? this.captureTexts : this.floaterTexts
    let text = list[index]
    if (!text) {
      text = new PIXI.Text({ text: '', style: style as never })
      text.anchor.set(0.5)
      this.overlayLayer.addChild(text)
      list[index] = text
    }
    text.visible = true
    return text
  }

  private render(): void {
    const view = this.view
    const PIXI = this.pixi
    if (!view || !PIXI) return
    // 已销毁就不要再画：页面关闭/刷新时"销毁 Pixi"与"rAF 里在途的那一帧"会撞车，
    // 表现为 `[board] 渲染这一帧失败：Cannot read properties of null (reading 'clear')`。
    // 有 catch 兜底不至于崩，但每次 E2E 都会刷一屏日志、掩盖真正的问题。
    if (this.destroyed) return
    if (!this.terrainG || !this.overlayG || !this.zoneLabel) return // 初始化未完成时的防御
    const { state } = view
    const map = getMap(state.mapId, this.data)
    const now = Date.now()

    // ---------- 地形：静态，每张地图只画一次 ----------
    if (this.terrainKey !== state.mapId) {
      this.terrainKey = state.mapId
      this.terrainG.clear()
      for (let y = 0; y < map.height; y += 1) {
        for (let x = 0; x < map.width; x += 1) {
          const t = this.data.terrain[map.terrain[y * map.width + x]]
          this.terrainG.rect(x * TILE, y * TILE, TILE, TILE).fill(colorOf(t.color))
        }
      }
      this.terrainG.rect(0, 0, map.width * TILE, map.height * TILE).stroke({ width: 2, color: 0x000000, alpha: 0.35 })
    }

    // ---------- 据点：集合是静态的，按 id 复用 ----------
    for (const b of state.buildings) {
      let v = this.buildingViews.get(b.id)
      if (!v) {
        const box = new PIXI.Graphics()
        const glyph = new PIXI.Text({ text: '', style: { fontSize: 20, fill: 0xf5efe2, fontWeight: '700' } })
        glyph.anchor.set(0.5)
        this.buildingLayer.addChild(box, glyph)
        v = { box, glyph }
        this.buildingViews.set(b.id, v)
      }
      const type = this.data.buildings[b.type]
      const index = b.owner === null ? -1 : state.players.indexOf(b.owner)
      const fill = index < 0 ? NEUTRAL : OWNER_COLORS[index % OWNER_COLORS.length]
      v.box.clear()
      v.box.roundRect(b.x * TILE + 6, b.y * TILE + 6, TILE - 12, TILE - 12, 6).fill(fill).stroke({ width: 2, color: 0x14110f })
      v.glyph.text = type.glyph
      v.glyph.position.set(b.x * TILE + TILE / 2, b.y * TILE + TILE / 2 - 2)
    }

    // ---------- 覆盖层：一个常驻 Graphics，清空后重画 ----------
    const overlay = this.overlayG
    overlay.clear()
    const zone = view.deployZoneIndex === null ? null : map.deployZones[view.deployZoneIndex]
    if (zone) {
      overlay
        .rect(zone.x0 * TILE, zone.y0 * TILE, (zone.x1 - zone.x0 + 1) * TILE, (zone.y1 - zone.y0 + 1) * TILE)
        .fill({ color: 0x3fa7a0, alpha: 0.22 })
        .stroke({ width: 4, color: 0x5fd8cf, alpha: 0.9 })
    }
    for (const key of view.reachable) {
      const [x, y] = key.split(',').map(Number)
      overlay.rect(x * TILE + 3, y * TILE + 3, TILE - 6, TILE - 6).fill({ color: 0x4f9fd4, alpha: 0.3 })
    }
    for (const key of view.attackRange ?? []) {
      const [x, y] = key.split(',').map(Number)
      overlay.rect(x * TILE + 3, y * TILE + 3, TILE - 6, TILE - 6).stroke({ width: 2, color: 0xd94f3d, alpha: 0.55 })
    }
    for (const key of view.attackTooClose ?? []) {
      const [x, y] = key.split(',').map(Number)
      overlay.rect(x * TILE + 3, y * TILE + 3, TILE - 6, TILE - 6).stroke({ width: 1, color: 0x8a8175, alpha: 0.5 })
    }
    for (const key of view.targets) {
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
      overlay.rect(b.x * TILE + 4, b.y * TILE + TILE - 10, TILE - 8, 6).fill(0x14110f)
      overlay
        .rect(b.x * TILE + 4, b.y * TILE + TILE - 10, (TILE - 8) * ratio, 6)
        .fill({ color: OWNER_COLORS[ownerIndex % OWNER_COLORS.length], alpha: 0.95 })
    }

    // ---------- 部署区标签（常驻，按需显示）----------
    if (zone) {
      this.zoneLabel.visible = true
      this.zoneLabel.text = '你的部署区（点这里放置）'
      this.zoneLabel.position.set(((zone.x0 + zone.x1 + 1) / 2) * TILE, (zone.y0 + 0.7) * TILE)
    } else {
      this.zoneLabel.visible = false
    }

    // ---------- 占领进度文字（复用池）----------
    let captureIndex = 0
    for (const b of state.buildings) {
      if (!b.capture) continue
      const ownerIndex = Math.max(0, state.players.indexOf(b.capture.playerId))
      const label = this.textAt('capture', captureIndex, {
        fontSize: 11,
        fill: OWNER_COLORS[ownerIndex % OWNER_COLORS.length],
        fontWeight: '700',
        stroke: { color: 0x14110f, width: 3 },
      })
      label.text = b.capture.points + '/' + this.data.capturePoints
      label.position.set(b.x * TILE + TILE / 2, b.y * TILE + TILE - 16)
      captureIndex += 1
    }
    for (let i = captureIndex; i < this.captureTexts.length; i += 1) this.captureTexts[i].visible = false

    // ---------- 单位：按 id 复用 ----------
    const alive = new Set<string>()
    for (const unit of state.units) {
      alive.add(unit.id)
      let v = this.unitViews.get(unit.id)
      if (!v) {
        const halo = new PIXI.Graphics()
        const body = new PIXI.Graphics()
        const glyph = new PIXI.Text({ text: '', style: { fontSize: 17, fill: 0xffffff, fontWeight: '700' } })
        glyph.anchor.set(0.5)
        const bar = new PIXI.Graphics()
        this.unitLayer.addChild(halo, body, glyph, bar)
        v = { halo, body, glyph, bar }
        this.unitViews.set(unit.id, v)
      }
      const type = this.data.units[unit.type]
      const index = Math.max(0, state.players.indexOf(unit.owner))
      const color = OWNER_COLORS[index % OWNER_COLORS.length]
      const { x: cx, y: cy } = this.unitPixel(unit.id, unit.x, unit.y)

      v.halo.clear()
      const flashExpiry = this.flashes.get(unit.id)
      const flashing = !!flashExpiry && flashExpiry > now
      if (flashing) v.halo.circle(cx, cy - 2, TILE * 0.44).fill({ color: 0xff5a3c, alpha: 0.5 })
      v.halo.visible = flashing

      v.body.clear()
      v.body.circle(cx, cy - 2, TILE * 0.34).fill(color).stroke({ width: 2, color: 0x14110f })
      if (unit.acted) v.body.circle(cx, cy - 2, TILE * 0.34).fill({ color: 0x000000, alpha: 0.35 })

      v.glyph.text = type.glyph
      v.glyph.position.set(cx, cy - 3)

      const ratio = Math.max(0, unit.hp) / type.hp
      v.bar.clear()
      v.bar.rect(cx - 16, cy + 12, 32, 4).fill(0x14110f)
      v.bar.rect(cx - 16, cy + 12, 32 * ratio, 4).fill(ratio > 0.5 ? 0x6fcf6a : ratio > 0.25 ? 0xd9a441 : 0xd94f3d)
    }
    for (const [id, v] of [...this.unitViews]) {
      if (alive.has(id)) continue
      // 必须先摘除再销毁：destroy() 不会自动从父容器移除，
      // 留在显示列表里的"已销毁对象"会让 Pixi 的批处理器读到 null 而崩（_DefaultBatcher.break）
      this.unitLayer.removeChild(v.halo, v.body, v.glyph, v.bar)
      v.body.destroy()
      v.halo.destroy()
      v.glyph.destroy()
      v.bar.destroy()
      this.unitViews.delete(id)
    }

    // ---------- 浮动数字（复用池）----------
    let floaterIndex = 0
    for (const floater of this.floaters) {
      const age = (now - floater.startAt) / FLOATER_MS
      if (age >= 1) continue
      const label = this.textAt('floater', floaterIndex, {
        fontSize: 18,
        fill: floater.color,
        fontWeight: '700',
        stroke: { color: 0x14110f, width: 3 },
      })
      label.text = floater.text
      label.position.set(floater.x * TILE + TILE / 2, floater.y * TILE + TILE / 2 - 14 - age * 26)
      label.alpha = 1 - age * age
      floaterIndex += 1
    }
    for (let i = floaterIndex; i < this.floaterTexts.length; i += 1) this.floaterTexts[i].visible = false

    try {
      this.app.render()
    } catch (err) {
      // 渲染出错不能让整棵 React 树挂掉（否则玩家直接掉线）：跳过这一帧，等下一次状态变化再重画。
      // ★ 计数保留、日志只打第一条：以前只有个布尔量，**没人知道它到底多频繁**
      //   （2026-10-07 排查时就是被这一点耽误了）。计数通过 `__atBoard.renderErrors()` 暴露，
      //   让 E2E 能直接断言为 0 —— 从"被掩盖的噪音"变成"红灯"。
      this.renderErrors += 1
      if (this.renderErrors === 1) console.error('[board] 渲染这一帧失败，已跳过：', err)
    }
  }

  /** 累计渲染失败次数；DEV/E2E 诊断用（不为 0 就是真 bug） */
  getRenderErrorCount(): number {
    return this.renderErrors
  }
}
