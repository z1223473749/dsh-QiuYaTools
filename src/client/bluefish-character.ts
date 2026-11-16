import { createBluefishArt, origin, pins, STAGE, type Artwork, type Point } from './bluefish-art.ts'

export const BLUEFISH_MEALS = ['rice', 'pork', 'eggs', 'cookies'] as const
export type Meal = (typeof BLUEFISH_MEALS)[number]
export type Face = 'idle' | 'look' | 'lift' | 'bite' | 'chew' | 'swallow'
export type Affect = 'happy' | 'grumpy' | 'worried'
export type Motion = {
  from: Artwork
  to: Artwork
  progress: number
  gaze?: Point
  tool?: 'gun' | 'wand'
  support?: 11 | 12
}
type Pose = {
  now: number
  elapsed: number
  face: Face
  gazeX: number
  gazeY: number
  reaction: number
  affect?: Affect
  food: Meal
  chew: number
  motion?: Motion
}

const clamp = (value: number) => Math.max(0, Math.min(1, value))
export const blend = (value: number) => {
  const t = clamp(value)
  return t * t * (3 - 2 * t)
}
export const mix = (a: number, b: number, t: number) => a + (b - a) * t
export const tween = (a: Point, b: Point, t: number): Point => [mix(a[0], b[0], t), mix(a[1], b[1], t)]
const bedArt = (name: Artwork) => ['bedside', 'knee', 'climb', 'lie', 'pull', 'sleep'].includes(name)
const stationary = (name: Artwork): Motion => ({ from: name, to: name, progress: 0 })

function eating({ food, face, elapsed }: Pose): Motion {
  if (face === 'idle' || face === 'look') return stationary('idle')
  if (food !== 'rice') {
    const a = `${food}0` as const, b = `${food}1` as const, c = `${food}2` as const
    if (face === 'lift') return { from: 'swallow', to: a, progress: blend(elapsed / 170) }
    if (face === 'bite') return { from: a, to: b, progress: blend(elapsed / 130) }
    if (face === 'chew') return { from: b, to: c, progress: blend(elapsed / 120) }
    return { from: c, to: 'swallow', progress: blend(elapsed / 175) }
  }
  if (face === 'lift') return { from: 'idle', to: 'pinch', progress: blend(elapsed / 180) }
  if (face === 'bite') {
    if (elapsed < 122) return { from: 'pinch', to: 'offer', progress: blend(elapsed / 122) }
    return { from: 'offer', to: 'bite', progress: blend((elapsed - 122) / 78) }
  }
  if (face === 'chew') return { from: 'bite', to: 'chew', progress: blend(elapsed / 160) }
  return { from: 'chew', to: 'swallow', progress: blend(elapsed / 180) }
}

export function createBluefishCharacter(doc: Document) {
  const art = createBluefishArt(doc)
  function draw(pose: Pose) {
    const motion = pose.motion ?? eating(pose)
    const { from, to, progress, support } = motion
    const [lookX, lookY] = motion.gaze ?? [pose.gazeX, pose.gazeY]
    const gaze: Point = [lookX * .007, lookY * .006]
    const breath = Math.sin(pose.now / 470) * .0024 + pose.chew * .003
    const expression = pose.chew * .012 + (pose.affect === 'happy' ? -.011 : pose.affect ? .015 : 0)
    const turn = lookX * .009 + pose.reaction * .009
    art.draw({ from, to, progress, gaze, breath, turn, expression })
    const { dataset } = art.element
    dataset.artFrom = from
    dataset.artTo = to
    dataset.artProgress = progress.toFixed(3)
    dataset.gaze = gaze.map(value => value.toFixed(4)).join(',')
    const wrist = tween(pins(from)[9], pins(to)[9], progress)
    // Reach landmarks follow the fingertips in the chase rather than the
    // center of the sleeve used by the other actions.
    dataset.hand = wrist.map(value => (value / STAGE).toFixed(4)).join(',')
    const nearSole = tween(pins(from)[11], pins(to)[11], progress)
    const farSole = tween(pins(from)[12], pins(to)[12], progress)
    art.ground((nearSole[0] + farSole[0]) / (STAGE * 2), (463 - Math.max(nearSole[1], farSole[1])) / STAGE,
      !bedArt(progress < .5 ? from : to))
    if (support) {
      const foot = tween(pins(from)[support], pins(to)[support], progress)
      dataset.support = foot.map(value => (value / STAGE).toFixed(4)).join(',')
    } else delete dataset.support
    const a = origin(from), b = origin(to)
    const nozzle = a && b ? tween(a, b, progress) : a ?? b
    if (!motion.tool || !nozzle) {
      delete dataset.nozzle
      return undefined
    }
    const [x, y] = nozzle
    const bubble = { x: x / STAGE, y: y / STAGE - breath * .83, direction: -1 }
    dataset.nozzle = `${bubble.x},${bubble.y}`
    return bubble
  }
  return { ...art, draw }
}
