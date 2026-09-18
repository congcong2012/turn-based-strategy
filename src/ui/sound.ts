/**
 * 音效：用 WebAudio 现场合成，不需要任何音频素材（纯静态、零体积、零版权）。
 * 首次用户交互后才创建 AudioContext（浏览器自动播放策略）。
 */

export type SoundName = 'click' | 'deploy' | 'move' | 'attack' | 'capture' | 'spawn' | 'turn' | 'over'

const STORAGE_KEY = 'ancient-tactics.sound'
let audioCtx: AudioContext | null = null
let enabled = true

try {
  enabled = globalThis.localStorage?.getItem(STORAGE_KEY) !== 'off'
} catch {
  enabled = true
}

export function isSoundOn(): boolean {
  return enabled
}

export function setSoundOn(value: boolean): void {
  enabled = value
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, value ? 'on' : 'off')
  } catch {
    /* ignore */
  }
}

function context(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (!audioCtx) audioCtx = new Ctor()
  if (audioCtx.state === 'suspended') void audioCtx.resume()
  return audioCtx
}

function tone(
  ctx: AudioContext,
  freq: number,
  duration: number,
  options: { type?: OscillatorType; gain?: number; delay?: number; slideTo?: number } = {},
): void {
  const start = ctx.currentTime + (options.delay ?? 0)
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = options.type ?? 'triangle'
  osc.frequency.setValueAtTime(freq, start)
  if (options.slideTo) osc.frequency.linearRampToValueAtTime(options.slideTo, start + duration)
  const peak = options.gain ?? 0.08
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  osc.connect(gain).connect(ctx.destination)
  osc.start(start)
  osc.stop(start + duration + 0.02)
}

function noise(ctx: AudioContext, duration: number, gainValue = 0.06): void {
  const frames = Math.floor(ctx.sampleRate * duration)
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < frames; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / frames)
  const source = ctx.createBufferSource()
  const gain = ctx.createGain()
  gain.gain.value = gainValue
  source.buffer = buffer
  source.connect(gain).connect(ctx.destination)
  source.start()
}

export function playSound(name: SoundName): void {
  if (!enabled) return
  const ctx = context()
  if (!ctx) return
  switch (name) {
    case 'click':
      tone(ctx, 640, 0.05, { type: 'square', gain: 0.04 })
      break
    case 'deploy':
      tone(ctx, 330, 0.12, { type: 'triangle', gain: 0.06, slideTo: 440 })
      break
    case 'move':
      tone(ctx, 300, 0.1, { type: 'triangle', gain: 0.05, slideTo: 220 })
      break
    case 'attack':
      noise(ctx, 0.16, 0.09)
      tone(ctx, 150, 0.18, { type: 'sawtooth', gain: 0.07, slideTo: 70 })
      break
    case 'capture':
      tone(ctx, 523, 0.12, { gain: 0.06 })
      tone(ctx, 784, 0.16, { gain: 0.06, delay: 0.1 })
      break
    case 'spawn':
      tone(ctx, 440, 0.1, { gain: 0.05 })
      tone(ctx, 660, 0.12, { gain: 0.05, delay: 0.08 })
      break
    case 'turn':
      tone(ctx, 880, 0.2, { type: 'sine', gain: 0.05 })
      break
    case 'over':
      tone(ctx, 523, 0.18, { gain: 0.07 })
      tone(ctx, 659, 0.18, { gain: 0.07, delay: 0.16 })
      tone(ctx, 784, 0.32, { gain: 0.07, delay: 0.32 })
      break
  }
}

/** 事件 → 音效 */
export function soundForEvent(type: string): SoundName | null {
  switch (type) {
    case 'deploy':
      return 'deploy'
    case 'move':
      return 'move'
    case 'attack':
      return 'attack'
    case 'capture':
      return 'capture'
    case 'spawn':
      return 'spawn'
    case 'turnStart':
      return 'turn'
    case 'gameOver':
      return 'over'
    default:
      return null
  }
}
