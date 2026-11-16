import { origin, pins, STAGE, type Artwork, type Point } from './bluefish-art.ts'
import { blend, mix, tween, type Motion } from './bluefish-character.ts'

export type IdleAction = 'play' | 'fish' | 'desk' | 'nap' | 'bubbles'
type Tool = NonNullable<Motion['tool']>
type Playback = {
  action: IdleAction
  distance: number
  started?: number
  tool?: Tool
  running: boolean
  pulse: number
}
type Frame = { motion: Motion; x: number; phase?: string; stage?: string; butterfly?: readonly [number, number, number, number]; emit?: Tool }
type Key = readonly [at: number, art: Artwork, stage: string]
const clamp = (value: number) => Math.max(0, Math.min(1, value))
const ramp = (now: number, from: number, to: number) => blend((now - from) / (to - from))
const still = (art: Artwork): Motion => ({ from: art, to: art, progress: 0 })
const morph = (from: Artwork, to: Artwork, progress: number): Motion => ({ from, to, progress })

function sequence(t: number, keys: readonly Key[]): Frame {
  const i = keys.findIndex(([at]) => at > t)
  if (i <= 0) {
    const [, art, stage] = keys[i === 0 ? 0 : keys.length - 1]!
    return { x: 0, stage, motion: still(art) }
  }
  const [start, from] = keys[i - 1]!
  const [end, to, stage] = keys[i]!
  return { x: 0, stage, motion: morph(from, to, ramp(t, start, end)) }
}

function lockFoot(from: Artwork, to: Artwork, progress: number, x: number, width: number, support: 11 | 12): Frame {
  const offset = (pins(to)[support][0] - pins(from)[support][0]) * width / STAGE
  return { phase: 'walk', x: x - offset * progress, motion: { ...morph(from, to, progress), support } }
}

const WALK_CYCLE: readonly (readonly [Artwork, Artwork, 11 | 12])[] = [
  ['walkA', 'walkB', 11], ['walkB', 'walkC', 12], ['walkC', 'walkD', 11], ['walkD', 'walkA', 12],
]

function walk(start: number, end: number, t: number, width: number): Frame {
  const progress = clamp(t)
  const direction = Math.sign(end - start)
  const travel = Math.abs(end - start)
  const segments = direction > 0 ? WALK_CYCLE.map(([a, b, foot]) => [b, a, foot] as const).reverse() : WALK_CYCLE
  let x = start
  let remaining = travel * progress
  for (let step = 0; step < 24; step++) {
    const [from, to, support] = segments[step % segments.length]!
    const length = Math.abs(pins(to)[support][0] - pins(from)[support][0]) * width / STAGE
    if (remaining <= length || step === 23) {
      return lockFoot(from, to, clamp(remaining / length), x, width, support)
    }
    x += direction * length
    remaining -= length
  }
  return { x: end, phase: 'walk', motion: still('stand') }
}

function chase(distance: number, t: number, width: number): Frame | undefined {
  if (t >= 7100) return undefined
  const strideWidth = Math.min(width, distance * 4.65)
  const stepped = lockFoot('plant', 'step', 1, 0, strideWidth, 12).x
  const jumped = Math.max(-distance, stepped - width * .125)
  const reached = Math.max(-distance, jumped - width * .096)
  const landed = Math.max(-distance, reached - width * .025)
  let frame: Frame
  if (t < 1320) {
    frame = { ...sequence(t, [
      [0, 'idle', 'discover'], [210, 'clear', 'discover'], [510, 'discover', 'discover'],
      [730, 'discover', 'discover'], [1320, 'plant', 'plant'],
    ]), phase: 'rise' }
  } else if (t < 2300) {
    frame = lockFoot('plant', 'step', ramp(t, 1320, 2300), 0, strideWidth, 12)
    frame.stage = 'step'
  } else if (t < 2750) {
    const p = ramp(t, 2300, 2750)
    frame = { x: mix(stepped, jumped, p), phase: 'jump', stage: 'jump', motion: morph('step', 'jump', p) }
  } else if (t < 3240) {
    const p = ramp(t, 2750, 3150)
    frame = { x: mix(jumped, reached, p), phase: 'reach', stage: 'reach', motion: morph('jump', 'reach', p) }
  } else if (t < 4100) {
    const p = ramp(t, 3240, 3680)
    frame = { x: mix(reached, landed, p), phase: 'land', stage: 'land', motion: morph('reach', 'land', p) }
  } else if (t < 6350) {
    const p = ramp(t, 4100, 6350)
    // She backs towards her seat while still watching where it flew.
    const gait = sequence(t, [
      [4100, 'land', 'return'], [4470, 'plant', 'return'], [4880, 'step', 'return'],
      [5270, 'plant', 'return'], [5660, 'step', 'return'], [6350, 'plant', 'return'],
    ])
    frame = { ...gait, x: mix(landed, 0, p), phase: 'return', stage: undefined }
  } else {
    frame = { ...sequence(t, [[6350, 'plant', 'sit'], [6770, 'discover', 'sit'], [7100, 'idle', 'sit']]), phase: 'sit' }
  }
  if (t < 4310) {
    // Authored independently in scene space. The closest pass is timed
    // to panel five's outstretched hand, then the butterfly climbs away.
    const hand = pins('reach')[9]
    const flutter = Math.sin(t / 121) * width * .022
    const pass: Point = [reached + width * (hand[0] / STAGE - .051), width * (hand[1] / STAGE - .026)]
    const hover: Point = [width * .14, width * .67]
    const near = tween([width * .55, width * .51], hover, ramp(t, 0, 680))
    const pursue = tween(near, pass, ramp(t, 890, 3030))
    const escape = ramp(t, 3025, 4130)
    const x = pursue[0] - escape * width * .22
    const y = pursue[1] - escape * width * .38 + flutter
    frame.butterfly = [x, y, ramp(t, 35, 260) * (1 - ramp(t, 3830, 4310)), -8 + flutter * 2 - escape * 27]
    const eyes = tween(pins(frame.motion.from)[0], pins(frame.motion.to)[0], frame.motion.progress)
    frame.motion.gaze = [
      Math.max(-1, Math.min(1, (x - frame.x - eyes[0] * width / STAGE) / (width * .25))),
      Math.max(-1, Math.min(1, (y - eyes[1] * width / STAGE) / (width * .25))),
    ]
  }
  return frame
}

function fishing(distance: number, t: number, width: number): Frame | undefined {
  if (t < 650) return { ...sequence(t, [[0, 'idle', 'plant'], [310, 'crouch', 'plant'], [650, 'stand', 'plant']]), phase: 'rise' }
  if (t < 2260) return walk(0, -distance, (t - 650) / 1610, width)
  if (t < 2690) return { ...sequence(t, [[2260, 'walkB', 'reach'], [2510, 'step', 'reach'], [2690, 'walkD', 'reach']]), x: -distance }
  if (t < 4210) return walk(-distance, 0, (t - 2690) / 1520, width)
  if (t < 4980) return { ...sequence(t, [[4210, 'stand', 'sit'], [4600, 'crouch', 'sit'], [4980, 'idle', 'sit']]), phase: 'sit' }
}

function desk(t: number): Frame | undefined {
  if (t >= 6640) return undefined
  if (t >= 1740 && t < 5560) {
    const pen = (.5 - .5 * Math.cos((t - 1740) / 108)) * (1 - ramp(t, 5290, 5560))
    return { x: 0, stage: 'write', motion: morph('openBook', 'write', pen) }
  }
  return sequence(t, [
    [0, 'idle', 'clear'], [640, 'clear', 'clear'], [965, 'fetch', 'fetch'], [1180, 'closedBook', 'fetch'],
    [1630, 'openBook', 'open'], [1740, 'openBook', 'write'], [5660, 'openBook', 'write'],
    [6010, 'closedBook', 'close'], [6310, 'fetch', 'close'], [6640, 'idle', 'close'],
  ])
}

const BED: readonly Key[] = [
  [0, 'idle', 'clear'], [630, 'clear', 'clear'], [1330, 'doze', 'doze'], [3250, 'doze', 'doze'],
  [3980, 'bedside', 'bed'], [4590, 'knee', 'knee'], [5100, 'climb', 'climb'],
  [5700, 'lie', 'lie'], [6240, 'pull', 'cover'], [6810, 'sleep', 'sleep'],
]
function nap(t: number): Frame | undefined {
  if (t >= 14200) return undefined
  const waking = t >= 12100
  const frame = sequence(waking ? 6810 * (1 - clamp((t - 12100) / 2100)) : t, BED)
  if (waking) frame.stage = 'wake'
  return frame
}

function bubbles(playback: Playback, t: number): Frame | undefined {
  const { tool, running, distance } = playback
  if (!tool) return undefined
  const end = running ? 6010 : 4570
  if (t >= end) return undefined
  const lap = `${tool}Lap` as const
  const aim = `${tool}Aim` as const
  const fire = tool === 'gun' ? 'gunFire' : 'wandBlow'
  const ready = `${tool}Run0` as const
  const stride = `${tool}Run1` as const
  const passing = `${tool}Run2` as const
  const start = 1190
  const stop = running ? 5130 : 3750
  const period = tool === 'gun' ? 370 : 760
  const pulse = Math.floor((t - start) / period)
  const firing = t >= start && t < stop
  let frame: Frame
  if (running && firing) {
    const p = clamp((t - start) / (stop - start))
    const beat = ((t - start) / 500) % 1
    const wave = beat < .5 ? ramp(beat, 0, .5) : 1 - ramp(beat, .5, 1)
    const entry = ramp(t, start, start + 170)
    const motion = entry < 1 ? morph(ready, stride, entry) : morph(stride, passing, wave)
    const retreat = p <= .56 ? ramp(p, 0, .56) : 1 - ramp(p, .56, 1)
    frame = { x: -distance * retreat, phase: 'run', stage: 'blow', motion }
  } else if (firing) {
    const beat = ((t - start) % period) / period
    const p = beat < .34 ? ramp(beat, 0, .34) : 1 - ramp(beat, .34, .9)
    frame = { x: 0, stage: 'blow', motion: morph(aim, fire, p) }
  } else {
    frame = sequence(t, [
      [0, 'idle', 'clear'], [420, 'clear', 'clear'], [760, lap, 'fetch'], [start, running ? ready : aim, 'aim'],
      [stop, running ? stride : aim, 'lower'], [stop + 420, lap, 'lower'], [end, 'idle', 'clear'],
    ])
  }
  if (origin(frame.motion.from) || origin(frame.motion.to)) frame.motion.tool = tool
  if (firing && pulse > playback.pulse) {
    frame.emit = tool
  }
  return frame
}

export function createBluefishActions(mascot: HTMLElement, flutter: (x: number, y: number, opacity: number, angle?: number, time?: number) => void) {
  let playback: Playback | undefined
  let exit: { at: number; elapsed: number } | undefined
  let elapsed = 0
  let bubbleTurn = 0

  function reset() {
    playback = undefined
    exit = undefined
    elapsed = 0
    mascot.style.translate = ''
    delete mascot.dataset.choreography
    delete mascot.dataset.travelPhase
    delete mascot.dataset.actionStage
    flutter(0, 0, 0)
  }

  return {
    start(action: IdleAction, distance: number) {
      reset()
      const variety = action === 'bubbles' ? bubbleTurn++ % 4 : -1
      playback = { action, distance: variety >= 0 ? distance * .56 : distance, running: variety >= 2,
        tool: variety < 0 ? undefined : variety % 2 ? 'wand' : 'gun', pulse: -1 }
      mascot.dataset.choreography = playback.running ? 'bubbleRun' : action
    },
    finish(now: number) {
      if (!playback) return false
      const age = playback.action === 'nap' && elapsed >= 12100
        ? 6810 * (1 - clamp((elapsed - 12100) / 2100)) : elapsed
      exit ??= { at: now, elapsed: Math.min(playback.action === 'nap' ? 6810 : Infinity, age) }
      return true
    },
    reset,
    draw(now: number): { ended?: boolean; motion?: Motion; emit?: Tool } {
      if (!playback) return {}
      playback.started ??= now
      elapsed = now - playback.started
      const t = exit ? exit.elapsed * (1 - clamp((now - exit.at) / Math.min(1750, 200 + exit.elapsed * .23))) : elapsed
      const width = Math.max(1, mascot.offsetWidth)
      const distance = Math.min(playback.distance, Math.max(0, (mascot.parentElement?.clientWidth ?? width) - width - 20))
      const frame = exit && t <= 0 ? undefined
        : playback.action === 'bubbles' ? bubbles({ ...playback, distance }, t)
        : playback.action === 'desk' ? desk(t)
        : playback.action === 'nap' ? nap(t)
        : playback.action === 'fish' ? fishing(distance, t, width)
        : chase(distance, t, width)
      if (!frame) { reset(); return { ended: true } }
      if (frame.emit && playback.tool) {
        playback.pulse = Math.floor((t - 1190) / (playback.tool === 'gun' ? 370 : 760))
      }
      mascot.style.translate = frame.x ? `${frame.x.toFixed(2)}px` : ''
      if (frame.phase) mascot.dataset.travelPhase = frame.phase
      else delete mascot.dataset.travelPhase
      if (frame.stage) mascot.dataset.actionStage = frame.stage
      else delete mascot.dataset.actionStage
      if (!exit && frame.butterfly) {
        const [x, y, opacity, angle] = frame.butterfly
        flutter(mascot.offsetLeft + x, mascot.offsetTop + y, opacity, angle, now)
      } else flutter(0, 0, 0)
      return { motion: frame.motion, emit: exit ? undefined : frame.emit }
    },
  }
}
