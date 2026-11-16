import { Matrix4, Quaternion, Vector3 } from 'three'
import type { BluefishModel, Vec } from './model.ts'

export type BluefishAction = 'review' | 'idle' | 'chase' | 'swim' | 'fish'
type Limb = BluefishModel['arms'][number]
export const HOME = 2.14
export const GROUND = .10
const DOWN = new Vector3(0, -1, 0)
const TWO_PI = Math.PI * 2
const TAIL_FLEX = [.25, .60, .96, 1.20]
const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n))
const mix = (a: number, b: number, p: number) => a + (b - a) * p
export function ease(t: number, from: number, to: number) {
  const p = clamp((t - from) / (to - from))
  return p * p * (3 - 2 * p)
}
function wave(t: number, from: number, to: number) {
  return Math.sin(Math.PI * clamp((t - from) / (to - from)))
}

type Pose = {
  stage: string
  at: Vec
  yaw: number
  lean: number
  seated: number
  gait: number
  travel: number
  direction: number
  jump: number
  stroke: number
  kick: number
  reach: number
  look: number
}

function poseAt(action: BluefishAction, t: number): Pose {
  const rest: Pose = {
    stage: 'sit', at: [HOME, GROUND, 0], yaw: -.32, lean: 0, seated: 1, gait: 0,
    travel: 0, direction: -1, jump: 0, stroke: 0, kick: 0, reach: 0, look: 0,
  }
  if (action === 'review') return { ...rest, stage: 'review', yaw: 0, seated: 0, lean: 0 }
  if (action === 'idle') return rest
  if (action === 'chase') {
    const left = 1.05 * ease(t, 1.18, 2.56)
    const right = 1.05 * ease(t, 4.55, 6.47)
    return {
      ...rest,
      stage: t < .5 ? 'discover' : t < 1.18 ? 'plant' : t < 2.56 ? 'step' : t < 3.38 ? 'jump' : t < 4.55 ? 'land' : t < 6.47 ? 'return' : 'sit',
      at: [HOME - left + right, GROUND, 0],
      yaw: -.32 - .55 * ease(t, .30, 1.46) + 1.62 * ease(t, 3.90, 4.55) - 1.07 * ease(t, 6.25, 6.90),
      seated: 1 - ease(t, .46, 1.16) + ease(t, 6.42, 7.06),
      lean: -.10 * wave(t, .46, 1.16) + .12 * wave(t, 1.18, 2.56),
      travel: t < 4.55 ? left : right,
      direction: t < 4.55 ? -1 : 1,
      gait: ease(t, 1.18, 1.45) * (1 - ease(t, 2.41, 2.56)) + ease(t, 4.55, 4.82) * (1 - ease(t, 6.27, 6.47)),
      jump: .39 * wave(t, 2.56, 3.38) - .10 * wave(t, 3.38, 3.78),
      reach: ease(t, 2.28, 2.98) * (1 - ease(t, 3.20, 3.80)),
      look: -.37 * ease(t, .0, .47) + .72 * ease(t, 3.08, 3.72),
    }
  }

  const toShore = ease(t, .90, 2.72)
  const enter = ease(t, 2.68, 3.62)
  const turn = ease(t, 6.10, 6.78)
  const recover = ease(t, 7.75, 8.67)
  const toHome = ease(t, 8.50, 10.35)
  const x = HOME - 1.76 * toShore - 1.21 * enter - 1.20 * ease(t, 3.58, 5.42)
    + 2.41 * ease(t, 6.47, 8.67) + 1.76 * toHome
  const stroke = enter * (1 - recover)
  const submerged = ease(t, 3.46, 4.49) * (1 - ease(t, 6.35, 7.15))
  const reach = action === 'fish' ? ease(t, 4.76, 5.40) * (1 - ease(t, 5.62, 6.14)) : 0
  return {
    ...rest,
    stage: t < .90 ? 'plant' : t < 2.68 ? 'walk-to-water' : t < 3.62 ? 'enter-water'
      : t < 4.49 ? 'dive' : t < 6.35 ? (reach > .30 ? 'reach-for-fish' : 'swim-underwater')
        : t < 7.75 ? 'surface' : t < 8.67 ? 'leave-water' : t < 10.35 ? 'return' : 'sit',
    at: [x, mix(GROUND, -.39, stroke) - .68 * submerged, -.43 * stroke],
    yaw: -.32 - 1.00 * ease(t, .23, 1.50) + 2.64 * turn - 1.64 * ease(t, 10.15, 10.74),
    lean: .15 * wave(t, 2.20, 2.90) + 1.26 * stroke,
    seated: 1 - ease(t, .22, .90) + ease(t, 10.30, 11.05),
    travel: t < 8.50 ? 1.76 * toShore : 1.76 * toHome,
    direction: t < 6.47 ? -1 : 1,
    gait: ease(t, .90, 1.15) * (1 - ease(t, 2.55, 2.73)) + ease(t, 8.50, 8.74) * (1 - ease(t, 10.19, 10.35)),
    jump: .12 * wave(t, 2.58, 3.31),
    stroke,
    kick: stroke * Math.sin(t * 9.2),
    reach,
    look: -.19 * stroke,
  }
}

const direction = new Vector3()
const bend = new Vector3()
const first = new Vector3()
const second = new Vector3()
const aim = new Vector3()
const segment = new Vector3()
const inverse = new Quaternion()

/** Solve the joint triangle in the limb's parent coordinates. Both bone
 * lengths stay constant, including when an input target is beyond reach. */
function solve(limb: Limb, target: Vector3, pole: Vec) {
  const [a, b] = limb.lengths
  direction.subVectors(target, limb.upper.position)
  const length = clamp(direction.length(), Math.abs(a - b) + .001, a + b - .001)
  if (direction.lengthSq() < .00001) direction.copy(DOWN)
  direction.normalize()
  bend.set(...pole)
  bend.addScaledVector(direction, -bend.dot(direction))
  if (bend.lengthSq() < .00001) bend.set(0, 0, 1).addScaledVector(direction, -direction.z)
  bend.normalize()
  const along = (a * a + length * length - b * b) / (2 * length)
  first.copy(direction).multiplyScalar(along).addScaledVector(bend, Math.sqrt(Math.max(0, a * a - along * along)))
  second.copy(direction).multiplyScalar(length).sub(first)
  limb.upper.quaternion.setFromUnitVectors(DOWN, first.normalize())
  inverse.copy(limb.upper.quaternion).invert()
  limb.lower.quaternion.setFromUnitVectors(DOWN, second.normalize().applyQuaternion(inverse))
}

const foot = new Vector3()
const shoeYaw = new Quaternion()
const shoeAxis = new Vector3(0, 1, 0)
const modelAngle = new Quaternion()
const swimShoe = new Quaternion()
const palmRoll = new Quaternion()
const palmYaw = new Quaternion()
const palmPitch = new Quaternion()
const pitchAxis = new Vector3(1, 0, 0)
const cuffTurn=new Quaternion().setFromAxisAngle(pitchAxis,Math.PI)
const rollAxis = new Vector3(0, 0, 1)
const viewInHips = new Vector3()
const hipsInverse = new Matrix4()
const frontalView = new Vector3(0, 0, 1)

/** Keep the tail on its pelvic chain as the camera orbits. Swimming and
 * idle flexion are supplied by poseBluefish, independently of the view. */
export function shapeBluefishTailView(model: BluefishModel, viewDirection: Vector3) {
  hipsInverse.copy(model.hips.matrixWorld).invert()
  viewInHips.copy(viewDirection).transformDirection(hipsInverse)
  const angle = Math.atan2(viewInHips.x, viewInHips.z)
  const pitch = Math.atan2(viewInHips.y, Math.hypot(viewInHips.x, viewInHips.z))
  model.tailFlukes.rotation.y = 0
  model.root.updateMatrixWorld(true)
  return { angle, pitch, weight: 0, turn: 0 }
}

export function poseBluefish(model: BluefishModel, action: BluefishAction, time: number, now: number, gaze: Vec,
  viewDirection = frontalView) {
  const p = poseAt(action, time)
  const { at, seated, gait, travel, direction: facing, stroke, kick, jump } = p
  const reviewing = action === 'review'
  const swimPhase = time * 8
  const bob = reviewing ? 0 : Math.sin(now * 2.7) * .009
  const height = mix(.785, .38, seated) + jump
  model.root.position.set(...at)
  model.root.rotation.y = p.yaw
  model.hips.position.y = mix(height, .62, stroke) + bob
  model.hips.rotation.set(p.lean, .014 * Math.sin(swimPhase) * stroke, gait * Math.sin(travel * 9) * .025)
  const leftSkirtFold = ease(seated, .60, .93)
  const kneeDrape = ease(seated, 0, .30)
  for (const cloth of model.skirtCloth) {
    cloth.morphTargetInfluences![0] = seated
    cloth.morphTargetInfluences![1] = leftSkirtFold
    cloth.morphTargetInfluences![2] = kneeDrape
  }
  for (const cloth of model.groundedSkirtCloth) cloth.morphTargetInfluences![3] = -bob/.009*seated
  for (const loop of model.apronLoops) loop.morphTargetInfluences![0] = stroke
  model.spine.rotation.set(.07 * seated - stroke * .13, -.08 * p.reach, -.04 * p.reach)
  const gazeX = reviewing ? 0 : gaze[0], gazeY = reviewing ? 0 : gaze[1]
  model.headPivot.rotation.set(-p.look * .22 - gazeY * .11 - .51 * stroke, gazeX * .19 - p.reach * .17, -.045 * seated)
  model.backHair.rotation.set(reviewing ? 0 : .036 * Math.sin(now * 2.9) + stroke * .28 - .14 * seated, 0, reviewing ? 0 : .041 * Math.sin(now * 3.1 - .8))
  const lift = Math.max(0, model.backHair.rotation.x) + .34 * Math.abs(model.backHair.rotation.z)
  const finClearance = Math.max(ease(stroke, 0, .68), ease(lift, .002, .035))
  for (const lock of model.shoulderLocks) lock.morphTargetInfluences![0] = finClearance
  model.fringe.rotation.z = reviewing ? 0 : .019 * Math.sin(now * 3.8 + .7)
  model.tailMesh.morphTargetInfluences![0] = stroke
  for (const [i, tail] of model.tailBones.entries()) {
    if (reviewing) { tail.rotation.set(0, 0, 0); continue }
    // Start the stroke at the waist with a small movement and give the
    // trailing fin the widest sweep. Lower the root as the body leans in.
    const flex = TAIL_FLEX[i]
    const dive = .09 * stroke * Math.max(0, 1 - i / 2)
    tail.rotation.y = Math.sin(now * (2.25 + stroke * 2.2) - i * .56) * (.065 + stroke * .20) * flex
    tail.rotation.x = Math.sin(now * 2.72 - i * .44) * (.034 + stroke * .11) * flex - dive
    tail.rotation.z = Math.sin(now * 2.31 - i * .44) * (.042 + stroke * .12) * flex
  }

  const blinkTime = (now + 2.32) % 5.4
  const blink = reviewing ? 0 : wave(blinkTime, 5.06, 5.29)
  const smile = reviewing ? .05 : .24 + p.reach * .70 + .18 * Math.max(0, jump)
  model.face.draw(clamp(gazeX - p.reach * .37, -1, 1), clamp(gazeY + p.look, -1, 1), blink, smile)
  model.root.updateMatrixWorld(true)
  const torsoView = model.torsoShapes.draw(viewDirection)

  const contacts: { leg: number; step: number; x: number; y: number }[] = []
  const stride = .73, contactPortion = .58
  for (const [i, leg] of model.legs.entries()) {
    const side = i ? 1 : -1
    const cycle = travel / stride + i * .5
    const phase = cycle % 1
    const swing = ease(phase, contactPortion, 1)
    const strideX = phase < contactPortion ? (contactPortion / 2 - phase) * stride
      : (-contactPortion / 2 + contactPortion * swing) * stride
    const lift = .17 * wave(phase, contactPortion, 1) * gait
    foot.set(at[0] + facing * strideX * gait + side * mix(.106, .18, seated), GROUND + .118 + lift + Math.max(0, jump) * .72,
      at[2] + (1 - gait) * .33 * seated - side * .115 * gait)
    // The turnaround uses a straight standing stance. Keep the original
    // moving hip anchor and its reachable ground contacts for the walk rig.
    leg.upper.position.y = reviewing ? .013 : -.046
    if (reviewing) foot.set(at[0] + .013 + side * .160, GROUND + .118, at[2] - .064)
    model.hips.worldToLocal(foot)
    foot.lerp(aim.set(side * .19, -.666 + kick * side * .075, .06 + kick * side * .20), stroke)
    solve(leg, foot, [0, .04, 1])
    leg.lower.updateWorldMatrix(true, false)
    leg.lower.getWorldQuaternion(modelAngle).invert()
    shoeYaw.setFromAxisAngle(shoeAxis, p.yaw + (reviewing ? side * .24 : 0))
    leg.end.quaternion.copy(modelAngle.multiply(shoeYaw))
    leg.end.quaternion.slerp(swimShoe.setFromAxisAngle(shoeAxis, side * .16), stroke)
    if (phase < contactPortion && gait > .995 && stroke < .05) {
      leg.end.getWorldPosition(aim)
      contacts.push({ leg: i, step: Math.floor(cycle), x: aim.x, y: aim.y - .118 })
    }
  }

  for (const [i, arm] of model.arms.entries()) {
    const side = i ? 1 : -1
    const walking = Math.sin(travel / stride * TWO_PI + i * Math.PI) * gait
    const strokeAngle = swimPhase + i * Math.PI
    // Carry the hands around the outside of the changing skirt volume.
    // Interpolating straight from the lap to the hip cuts through the hem.
    const rising = Math.sin(Math.PI * seated)
    segment.set(side * (mix(.46, .21, seated) + .09 * rising + .045 * gait),
      mix(-.01, .04, seated) + .045 * rising + .04 * gait + walking * .035,
      mix(.23, .35, seated) + .025 * rising + walking * .10)
    if (reviewing) segment.set(side * (.493 + .077 * torsoView.weight), 0.0324091618,
      (side < 0 ? -.014 : -.008) - side * .080 * torsoView.weight)
    aim.set(side * (.29 + .10 * Math.cos(strokeAngle)), -.01 + .57 * Math.sin(strokeAngle), .23 + .18 * Math.cos(strokeAngle))
    segment.lerp(aim, stroke)
    if (i === 0) segment.lerp(aim.set(-.28, .52, .45), p.reach)
    else segment.z += p.reach * .11
    // Carry the recovery hand around the head while its target passes close
    // to the cheek. This is a physical stroke envelope in spine coordinates.
    const headPass=ease(segment.y,.20,.35)*(1-ease(segment.z,.20,.40))*stroke
    segment.x+=side*.20*headPass
    solve(arm, segment, reviewing ? [side * .30, -.58, .90] : [side, -.55, .31])
    if (reviewing) {
      arm.lower.updateWorldMatrix(true, false)
      arm.lower.getWorldQuaternion(modelAngle).invert()
      // Turn the palm around the fingers first. The outward wrist roll
      // then stays in the frontal plane and the fingers hang in profile.
      palmRoll.setFromAxisAngle(rollAxis, side < 0 ? -0.8557277986 : 0.7720762287)
      const farHand = side * torsoView.angle < 0 ? Math.sign(torsoView.angle) * Math.PI / 4 * torsoView.weight : 0
      palmYaw.setFromAxisAngle(shoeAxis, (side < 0 ? -0.4484907379 : 0.5) + farHand)
      palmRoll.multiply(palmYaw)
      palmPitch.setFromAxisAngle(pitchAxis, -0.1090635194)
      palmRoll.premultiply(palmPitch)
      arm.end.quaternion.copy(modelAngle.multiply(palmRoll))
    } else {
      arm.end.rotation.set(.035 * seated, 0, 0)
      arm.lower.updateWorldMatrix(true, false)
      arm.lower.getWorldQuaternion(modelAngle).invert()
      model.spine.getWorldQuaternion(palmYaw)
      // Let the relaxed fingers hang beside the skirt instead of aiming
      // inward with the forearm. The wrist turns continuously for a reach.
      palmRoll.setFromAxisAngle(rollAxis, side * .48)
      palmPitch.setFromAxisAngle(shoeAxis, -side * .90)
      palmYaw.multiply(palmRoll).multiply(palmPitch)
      arm.end.quaternion.slerp(modelAngle.multiply(palmYaw), (1-seated)*(1-stroke))
      if (i === 0 && p.reach > 0) {
        palmPitch.setFromAxisAngle(pitchAxis, -p.reach * .23)
        palmRoll.setFromAxisAngle(rollAxis, -.12 * p.reach)
        arm.end.quaternion.slerp(palmPitch.multiply(palmRoll), ease(p.reach,0,.65))
      }
    }
    const cuff=arm.lower.getObjectByName('wrist-cuff')
    cuff?.quaternion.identity().slerp(arm.end.quaternion,.30).multiply(cuffTurn)
  }
  model.root.updateMatrixWorld(true)
  // Sweep procedural hair from the posed bone cage before either rendering
  // or geometry queries; no view fields or previous-frame state enter it.
  model.backHair.traverse(object => {
    const update = object.userData.updateBluefishHairGeometry
    if (typeof update === 'function') update()
  })
  return { stage: p.stage, contacts, submerged: model.head.getWorldPosition(aim).y < -.05, reach: p.reach }
}
