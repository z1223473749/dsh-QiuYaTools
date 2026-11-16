import {
  AmbientLight, BufferGeometry, CircleGeometry, Color, DirectionalLight, DoubleSide, Float32BufferAttribute, FogExp2, Group,
  Mesh, MeshBasicMaterial, MeshLambertMaterial, OrthographicCamera, PlaneGeometry, Scene,
  ShaderMaterial, SphereGeometry, Vector3, WebGLRenderer,
} from 'three'
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js'
import { createBluefishModel } from './model.ts'
import { ease, GROUND, HOME, poseBluefish, shapeBluefishTailView, type BluefishAction } from './motion.ts'

const SURFACE_VERTEX = `
  uniform float time;
  varying vec2 plane;
  void main() {
    vec3 p = position;
    plane = (modelMatrix * vec4(p, 1.)).xz;
    p.y += .020 * sin(p.x * 3.5 + p.z * 3.0 + time * 1.4)
      + .014 * cos(p.x * 8.4 - p.z * 4.2 - time * 2.7);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
  }
`

const SURFACE_FRAGMENT = `
  uniform float time;
  varying vec2 plane;
  void main() {
    vec2 p = plane;
    float wave = sin(p.x * 5.3 + p.y * 11.2 + time * 2.1 + .85 * sin(p.x * 3.));
    float interference = sin(p.x * 11. + p.y * 5.1 - time * 1.4);
    float bands = pow(max(0., wave * .65 + interference * .35), 6.);
    float shore = -.04 + .18 * sin(p.y * .67) + .074 * cos(p.y * 1.63);
    float shoreDist = p.x - shore;
    float foam = 1. - smoothstep(.014, .112, abs(shoreDist + .08 + .035 * sin(p.y * 8. - time * 3.4)));
    float shallows = smoothstep(-4.5, .0, shoreDist);
    vec3 color = mix(vec3(.14,.49,.76),vec3(.37,.79,.84),shallows);
    color = mix(color, vec3(.88,.97,1.), .42 * bands + foam * .64);
    gl_FragColor = vec4(color, .47 + .14 * bands + foam * .26);
  }
`

const FISH_TARGET = new Vector3()
const WRIST = new Vector3()
const contactRadius = .32
const CAMERA_TARGET = new Vector3(-.15, .64, 0)
const REVIEW_TARGET = new Vector3(HOME + .13, 1.385, -.31)
const START_YAW = -.085
const START_PITCH = .159
const ACTION_SECONDS: Record<BluefishAction, number> = { review: Infinity, idle: Infinity, chase: 7.10, swim: 11.10, fish: 11.10 }

function shoreGeometry() {
  const positions: number[] = [], colors: number[] = [], indices: number[] = []
  const rows = 120
  const crossSection = [
    { x: -.36, y: -.24, color: 0xb9a290 }, { x: 0, y: -.019, color: 0xd0ac87 },
    { x: .17, y: .064, color: 0xe6c797 }, { x: .29, y: GROUND, color: 0xf3d7a8 },
    { x: 1.9, y: GROUND, color: 0xf4dcb3 }, { x: 16, y: GROUND, color: 0xf4dfb8 },
  ]
  for (let i = 0; i <= rows; i++) {
    const z = 15 - i * .43
    const shore = -.04 + .18 * Math.sin(z * .67) + .074 * Math.cos(z * 1.63)
    for (const [j, { x, y, color }] of crossSection.entries()) {
      const p = new Color(color).multiplyScalar(.98 + .029 * Math.sin(z * 2.4 + j * 3.1))
      positions.push(shore + x, y, z)
      colors.push(p.r, p.g, p.b)
      if (i < rows && j < crossSection.length - 1) {
        const a = i * crossSection.length + j, c = a + crossSection.length
        indices.push(a, a + 1, c, a + 1, c + 1, c)
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

export function createBluefishWorld(canvas: HTMLCanvasElement) {
  const scene = new Scene()
  const seaFog = new FogExp2(0xbcdff0, .038)
  scene.fog = seaFog
  const camera = new OrthographicCamera(-4, 4, 2.6, -2.6, .1, 60)
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, stencil: true })
  renderer.setClearColor(0x000000, 0)
  const ink = new OutlineEffect(renderer, { defaultThickness: .0026 })
  const ambient = new AmbientLight(0xfff1ec, 1.50)
  const key = new DirectionalLight(0xfff4ee, 2.0)
  const fill = new DirectionalLight(0xb4ceff, 1.05)
  key.position.set(-3.2, 5, 8)
  fill.position.set(4.5, 2.0, -4)
  scene.add(ambient, key, fill)
  const model = createBluefishModel()
  scene.add(model.root)
  const coast = new Group()
  scene.add(coast)

  const surfaceMaterial = new ShaderMaterial({
    transparent: true, depthWrite: false, side: DoubleSide,
    uniforms: { time: { value: 0 } }, vertexShader: SURFACE_VERTEX, fragmentShader: SURFACE_FRAGMENT,
  })
  const waterMesh = new Mesh(new PlaneGeometry(16.25, 48, 132, 140).rotateX(-Math.PI / 2), surfaceMaterial)
  waterMesh.position.set(-7.875, 0, -9.4)
  waterMesh.renderOrder = 2
  coast.add(waterMesh)
  coast.add(new Mesh(shoreGeometry(), new MeshLambertMaterial({ vertexColors: true })))
  const seabed = new Mesh(new PlaneGeometry(40, 35).rotateX(-Math.PI / 2),
    new MeshLambertMaterial({ color: 0x58a9b5 }))
  seabed.position.set(-4, -1.83, -8)
  coast.add(seabed)
  const rockPaint = new MeshLambertMaterial({ color: 0xb7afa4 })
  const rockForm = new SphereGeometry(1, 10, 7)
  for (const [x, y, z, s] of [[3.9, .21, -1.6, .34], [3.55, .16, -1.75, .18],
    [2.7, .15, -2.3, .19], [-3.0, -1.67, .25, .24], [-3.45, -1.64, .08, .34]]) {
    const rock = new Mesh(rockForm, rockPaint)
    rock.position.set(x, y, z)
    rock.scale.set(s * 1.45, s * .65, s)
    rock.rotation.y = x * .83
    coast.add(rock)
  }
  const shadow = new Mesh(new CircleGeometry(1, 48).rotateX(-Math.PI / 2), new MeshBasicMaterial({
    color: 0x725c57, transparent: true, opacity: .19, depthWrite: false,
  }))
  shadow.renderOrder = 1
  shadow.scale.set(.59, 1, .35)
  scene.add(shadow)

  const fish = new Group()
  const fishFin = new Group()
  const fishBodyPaint = new MeshLambertMaterial({ color: 0xffc85f })
  const fishFinPaint = new MeshLambertMaterial({ color: 0xff986a })
  const fishEyePaint = new MeshBasicMaterial({ color: 0x253251 })
  const fishShape = new SphereGeometry(1, 20, 12)
  function fishPart(parent: Group, material: MeshLambertMaterial | MeshBasicMaterial, x: number, y: number, z: number, rx: number, ry: number, rz: number) {
    const mesh = new Mesh(fishShape, material)
    mesh.position.set(x, y, z)
    mesh.scale.set(rx, ry, rz)
    parent.add(mesh)
    return mesh
  }
  fishPart(fish, fishBodyPaint, 0, 0, 0, .231, .117, .077)
  fishPart(fish, fishEyePaint, .131, .030, .066, .020, .022, .013)
  fishPart(fish, fishEyePaint, .131, .030, -.066, .020, .022, .013)
  fishPart(fish, fishFinPaint, -.027, .078, 0, .093, .075, .017).rotation.z = .28
  fishPart(fishFin, fishFinPaint, -.062, .043, 0, .109, .049, .023).rotation.z = -.47
  fishPart(fishFin, fishFinPaint, -.062, -.043, 0, .109, .049, .023).rotation.z = .47
  fishFin.position.set(-.211, 0, 0)
  fish.add(fishFin)
  scene.add(fish)

  const butterfly = new Group()
  const wings = [-1, 1].map(side => {
    const wing = new Group()
    const pink = new MeshLambertMaterial({ color: 0xf097bc })
    const cream = new MeshLambertMaterial({ color: 0xffdbec })
    fishPart(wing, pink, side * .066, .035, 0, .070, .090, .020).rotation.z = side * -.36
    fishPart(wing, cream, side * .044, -.040, 0, .048, .054, .016).rotation.z = side * .37
    butterfly.add(wing)
    return wing
  })
  fishPart(butterfly, fishEyePaint, 0, 0, .013, .013, .066, .013)
  scene.add(butterfly)

  const droplets = new Group()
  const dropletPaint = new MeshBasicMaterial({ color: 0xc5efff, transparent: true, opacity: .72 })
  for (let i = 0; i < 10; i++) {
    const drop = new Mesh(fishShape, dropletPaint)
    drop.scale.setScalar(.033 + i % 3 * .011)
    droplets.add(drop)
  }
  scene.add(droplets)
  scene.traverse(node => {
    if (node instanceof Mesh && !Array.isArray(node.material) && !node.material.userData.outlineParameters) {
      node.material.userData.outlineParameters = { visible: false }
    }
  })

  let action: BluefishAction = 'review'
  let start: number | undefined
  let caught = false, closest = Infinity
  let cameraYaw = 0, requestedYaw = 0
  let cameraPitch = 0, requestedPitch = 0
  const reviewPitchLimit=Math.PI/2-.025
  let viewWidth = 0, viewHeight = 0, viewDpr = 0, reviewView = false
  let gaze: [number, number, number] = [0, 0, 0]

  function resize(review: boolean) {
    const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight)
    const dpr = Math.min(canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1, 1.75)
    if (w === viewWidth && h === viewHeight && dpr === viewDpr && review === reviewView) return
    viewWidth = w; viewHeight = h; viewDpr = dpr; reviewView = review
    renderer.setPixelRatio(dpr)
    renderer.setSize(w, h, false)
    const half = review ? Math.max(1.57, 1.70 * h / w) : Math.max(1.98, 4.65 * h / w)
    camera.left = -half * w / h; camera.right = half * w / h
    camera.bottom = -half; camera.top = half
    camera.updateProjectionMatrix()
  }

  const headViewDirection = new Vector3()
  function draw(now: number) {
    start ??= now
    const t = (now - start) / 1000
    const active = t < ACTION_SECONDS[action] ? action : 'idle'
    const reviewing = active === 'review'
    scene.fog = reviewing ? null : seaFog
    resize(reviewing)
    coast.visible = !reviewing
    const clock = now / 1000
    cameraYaw += (requestedYaw - cameraYaw) * .16
    cameraPitch += (requestedPitch - cameraPitch) * .16
    const radius = 9.10, level = Math.cos(cameraPitch) * radius
    const target = reviewing ? REVIEW_TARGET : CAMERA_TARGET
    camera.position.set(Math.sin(cameraYaw) * level, Math.sin(cameraPitch) * radius, Math.cos(cameraYaw) * level)
      .add(target)
    camera.lookAt(target)
    camera.getWorldDirection(headViewDirection).negate()
    const pose = poseBluefish(model, active, t, reviewing ? 0 : clock, gaze, headViewDirection)
    model.headShapes.draw(headViewDirection)
    shapeBluefishTailView(model, headViewDirection)
    shadow.visible = !reviewing && model.root.position.x > .43
    shadow.position.set(model.root.position.x, GROUND + .007, model.root.position.z)
    shadow.material.opacity = Math.max(.07, .16 - (model.hips.position.y - .78) * .24)
    surfaceMaterial.uniforms.time.value = clock
    butterfly.visible = active === 'chase' && t < 4.12
    if (butterfly.visible) {
      const travel = ease(t, .65, 2.91), escape = ease(t, 3.02, 4.12)
      butterfly.position.set(HOME - .66 - travel * 1.05 - escape * .76,
        1.04 + travel * .70 + escape * 1.08 + .07 * Math.sin(t * 9), .42 + .1 * Math.cos(t * 7.2))
      for (const [i, wing] of wings.entries()) wing.rotation.y = (i ? 1 : -1) * Math.sin(clock * 35) * .85
      butterfly.rotation.z = -.20 + .17 * Math.sin(t * 7.6)
    }

    fish.visible = !reviewing && (!caught || active === 'fish')
    fishFin.rotation.y = Math.sin(clock * 15.5) * (caught ? .30 : .67)
    if (!caught) {
      const pass = ease(t, 3.72, 5.45)
      fish.position.set(active === 'fish' ? -3.34 + pass * .78 : -2.28 + .78 * Math.sin(clock * 1.13),
        active === 'fish' ? -.59 + pass * .34 : -.79 + .13 * Math.cos(clock * 2.3),
        active === 'fish' ? -.45 + pass * .19 : -.32 + .27 * Math.sin(clock * 1.22))
      fish.rotation.y = active === 'fish' || Math.cos(clock * 1.13) > 0 ? .1 : Math.PI
      if (active === 'fish' && pose.reach > .25) {
        model.arms[0].end.getWorldPosition(WRIST)
        closest = Math.min(closest, WRIST.distanceTo(fish.position))
        if (WRIST.distanceTo(fish.position) < contactRadius) {
          model.arms[0].end.attach(fish)
          caught = true
        }
      }
    } else {
      FISH_TARGET.set(-.01, -.098, .092)
      fish.position.lerp(FISH_TARGET, .18)
      fish.rotation.z += (.18 - fish.rotation.z) * .13
    }

    const splash = active === 'fish' || active === 'swim' ? t - (t < 6 ? 3.08 : 7.72) : -1
    droplets.visible = splash >= 0 && splash < .55
    if (droplets.visible) {
      droplets.position.set(model.root.position.x, 0, model.root.position.z)
      for (const [i, drop] of droplets.children.entries()) {
        const theta = i * 2.39996
        const rise = splash * (.82 + i % 3 * .20) - splash ** 2 * 1.7
        drop.position.set(Math.cos(theta) * splash * (.95 + i % 3 * .23), Math.max(.012, rise), Math.sin(theta) * splash)
      }
      dropletPaint.opacity = .8 - splash * 1.32
    }

    if (reviewing) {
      // OutlineEffect does not initialize autoClear in this runtime.
      // Reset color, depth and stencil for every inspection draw, even
      // when several views are rendered before the browser composites.
      renderer.clear(true,true,true)
      ink.render(scene, camera)
    } else renderer.render(scene, camera)
    return { ...pose, active, time: t, caught, closest, x: model.root.position.x, cameraYaw, cameraPitch }
  }

  return {
    draw,
    reviewProjection() {
      const floor = new Vector3(HOME, GROUND, 0).project(camera)
      return { x: (1 + floor.x) / 2, y: (1 - floor.y) / 2, worldHeight: camera.top - camera.bottom }
    },
    play(next: BluefishAction) {
      if (caught) scene.attach(fish)
      fish.rotation.set(0, 0, 0)
      if (action === 'review' || next === 'review') {
        requestedYaw = next === 'review' ? 0 : START_YAW
        requestedPitch = next === 'review' ? 0 : START_PITCH
      }
      action = next
      start = undefined
      caught = false
      closest = Infinity
    },
    aim(x: number, y: number) { gaze = [x, y, 0] },
    orbit(dx: number, dy: number) {
      requestedYaw -= dx * .009
      requestedPitch = Math.min(action === 'review' ? reviewPitchLimit : .98, Math.max(action === 'review' ? -reviewPitchLimit : .065, requestedPitch + dy * .007))
    },
    resetCamera() {
      requestedYaw = action === 'review' ? 0 : START_YAW
      requestedPitch = action === 'review' ? 0 : START_PITCH
    },
    restoreCamera(yaw: number, pitch: number) {
      if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return
      cameraYaw = requestedYaw = yaw
      cameraPitch = requestedPitch = Math.min(action === 'review' ? reviewPitchLimit : .98, Math.max(action === 'review' ? -reviewPitchLimit : -.16, pitch))
    },
    dispose() {
      const geometries = new Set<BufferGeometry>()
      const materials = new Set<Mesh['material']>()
      scene.traverse(node => {
        if (node instanceof Mesh) { geometries.add(node.geometry); materials.add(node.material) }
      })
      for (const geometry of geometries) geometry.dispose()
      for (const material of materials) {
        if (Array.isArray(material)) material.forEach(entry => entry.dispose())
        else material.dispose()
      }
      renderer.dispose()
    },
  }
}
