import { Triangle } from 'three'
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js'
import {
  Bone, BufferGeometry, CatmullRomCurve3, Color, Curve as SpatialCurve, ExtrudeGeometry, Float32BufferAttribute, MathUtils, Matrix4, Mesh,
  MeshBasicMaterial, MeshPhongMaterial, Object3D, Quaternion, Shape, Skeleton, SkinnedMesh, TubeGeometry, Uint16BufferAttribute, Vector3,
} from 'three'
import { profileFrontDepth, refineProfile } from './profile-geometry.ts'
import { bluefishFaceClearanceDepth } from './face.ts'

type Curve = readonly [number,number,number,number,number,number]
type Stroke = readonly (readonly [number, number])[]
type CurlGuide = readonly (readonly [number, number, number, number, number])[]
type ProfileLockSections = readonly (readonly [number,number,number,number,number])[]
type View = 'front' | 'back' | 'left' | 'right'
type LockRoot = { inset: number; forward: number; drop?: number; delay?: number }
type LockSurface = {
  depth?: (x: number, y: number) => number
  glint?: Stroke
  shadow?: (x: number, y: number) => number
  underlay?: boolean
  tailPassage?: boolean
  waistFlow?: boolean
  waistTuft?: boolean
  root?: LockRoot & { settled: LockRoot }
}
const UNIT = .0056
// Crown reflection contours in the head's paint coordinates. These small
// vector fields are evaluated on the curved locks without an image texture.
const REAR_REFLECTIONS = [
  [[215,97],[214,97],[213,95],[208,95],[207,97],[206,97],[205,95],[200,95],[200,96],[197,98],[197,100],[194,102],[194,104],[192,105],[190,109],[190,112],[189,114],[187,115],[183,126],[186,119],[189,115],[190,111],[194,107],[197,101],[200,98],[202,99],[202,101],[198,106],[196,113],[200,109],[203,110],[204,107],[211,98],[213,99]],
  [[299,95],[299,97],[301,97],[303,99],[304,102],[303,107],[305,110],[308,108],[310,108],[311,110],[313,111],[313,109],[315,108],[319,114],[315,106],[307,95],[312,102],[311,104],[308,104],[302,97],[302,95]],
  [[295,101],[297,103],[297,106],[295,108],[295,111],[296,112],[295,114],[294,114],[287,106],[285,107],[283,106],[286,113],[287,111],[290,112],[289,115],[287,116],[288,119],[289,116],[292,118],[294,115],[296,115],[298,118],[299,115],[301,115],[302,113],[304,114],[298,104]],
  [[213,103],[210,108],[207,109],[205,113],[207,114],[207,116],[209,114],[211,115],[215,114],[217,116],[217,118],[220,110],[219,108],[215,111],[213,109],[213,104],[214,103]],
  [[233,109],[232,109],[230,113],[228,123],[229,120],[231,118],[236,119],[237,121],[238,121],[239,114],[236,116],[232,114]],
  [[277,110],[277,112],[275,115],[275,119],[275,118],[277,117],[276,117],[275,115],[276,113],[278,112],[281,116],[282,122],[281,115]],
  [[269,115],[270,121],[271,121]],
] as const
const SIDE_SECTIONS = [
  [191,.53,.25], [214,.61,.30], [233,.72,.36], [247,.73,.41],
  [258,.70,.45], [270,.785,.49], [286,.89,.53], [302,.918,.55],
  [319,.88,.52], [332,.81,.48], [345,.90,.49], [360,.84,.51],
  [377,.85,.51], [393,.78,.48], [410,.63,.44], [424,.41,.40],
] as const

// Height, outside/inside bounds in the rear view, then front/back depth.
// The width and depth are authored independently so the lower turn keeps
// its outline in both the rear and profile views.
const MIDDLE_WAVE = [
  [292,185,185,-.53,-.53], [298,177,190,-.53,-.63],
  [310,169,198,-.58,-.71], [318,162,198,-.63,-.817],
  [325,155,197,-.64,-.810],
  [340,146,186,-.61,-.78], [355,146,169,-.57,-.74],
  [367,153,167,-.52,-.70], [377,162,177,-.50,-.65],
  [380,173,173,-.53,-.53],
] as const
const HEM_MAIN = [
  [300,180,180,-.36,-.36], [323,139,172,-.30,-.57],
  [340,126,176,-.33,-.62], [355,121,179,-.37,-.57],
  [370,120,182,-.39,-.58], [382,119,184,-.37,-.57],
  [392,122,182,-.34,-.54], [400,126,176,-.33,-.48],
  [405,130,164,-.35,-.45], [410,140,168,-.37,-.43],
  [417,155,155,-.398,-.402],
] as const
const HEM_OUTER = [
  [329,128,128,-.52,-.55], [340,110,128,-.55,-.69],
  [347,99,127,-.61,-.73], [355,99,128,-.62,-.74],
  [365,98,124,-.63,-.73], [375,98,112,-.637,-.72],
  [383,101,113,-.626,-.699], [390,108,117,-.592,-.643],
  [396,123,123,-.578,-.582],
] as const
const HEM_INNER = [
  [338,183,183,-.27,-.30], [360,176,204,-.35,-.40],
  [380,173,202,-.35,-.39], [392,176,210,-.32,-.38],
  [405,184,209,-.265,-.36], [414,185,201,-.275,-.33],
  [420,194,194,-.287,-.293],
] as const

// Height and outside/inside bounds in the front and left profiles. Each
// curl tapers to its own tip, with the lower root beneath the temple curl.
const TEMPLE_CURL = [
  [151, 187, 187, 196, 196], [157, 185, 196, 195, 199],
  [164, 183, 202, 191, 205], [176, 180, 203, 187, 213],
  [185, 179, 204, 185, 212], [193, 180, 204, 183, 209],
  [196, 184, 207, 181, 207], [198.5, 197, 210, 177, 196], [199.3, 198.5, 212, 175.5, 191.5],
  [200, 199, 211, 177, 188], [201.3, 198, 208, 171.5, 182],
  [202.5, 198, 203, 174, 178], [203.6, 201, 201, 176, 176],
] as const
const JAW_CURL = [
  [172, 188, 188, 207, 207], [177, 182, 193, 204, 214],
  [185, 180, 202, 201, 218], [193, 180, 201, 197, 220],
  [198, 181, 202, 194, 221], [201, 182, 204, 192, 222],
  [205, 185, 206, 187, 221],
  [209, 188, 209, 184, 220], [214, 193, 218, 180, 217],
  [217, 199, 221, 175, 209], [219, 204, 222, 172, 201],
  [221.5, 208, 216, 177, 197], [222.2, 210.4, 213.1, 177, 194],
  [223.2, 211, 211, 192, 192],
] as const
// A broad convex section fills the quarter turn while retaining both
// authored axis supports. This is one physical loft at every view.
const CHEEK_ROUNDNESS = .84
const monotoneSlope = (a: number, b: number) => a * b > 0 ? 2 * a * b / (a + b) : 0

function profileLockSection(sections: ProfileLockSections, pixel: number) {
  if (pixel < sections[0][0] || pixel > sections[sections.length - 1][0]) return
  const found = sections.findIndex(([height], index) => index > 0 && height >= pixel)
  const index = found < 0 ? sections.length - 1 : found
  const a = sections[index - 1], b = sections[index]
  const before = sections[Math.max(0,index - 2)], after = sections[Math.min(sections.length - 1,index + 1)]
  const span = b[0] - a[0], t = (pixel - a[0]) / span
  const sample = (axis: 1 | 2 | 3 | 4) => {
    const middle = (b[axis] - a[axis]) / span
    const first = monotoneSlope((a[axis] - before[axis]) / (a[0] - before[0] || 1), middle)
    const last = monotoneSlope(middle, (after[axis] - b[axis]) / (after[0] - b[0] || 1))
    return a[axis] + (b[axis] - a[axis]) * t * t * (3 - 2 * t)
      + span * t * (1 - t) * (first * (1 - t) - last * t)
  }
  const outside = (257 - sample(1)) * UNIT, inside = (257 - sample(2)) * UNIT
  const front = sample(3), back = sample(4)
  return { x: (outside + inside) / 2, width: (outside - inside) / 2,
    z: (front + back) / 2, depth: (front - back) / 2 }
}

function middleWaveSection(pixel: number) { return profileLockSection(MIDDLE_WAVE,pixel) }

function seatBehindMiddleWave(point: Vector3) {
  const pixel = 175.4 - point.y / UNIT, section = middleWaveSection(pixel)
  if (!section || section.width < .005) return point
  const across = (Math.abs(point.x) - section.x) / section.width
  const edge = Math.max(0, Math.min(1, (1.24 - Math.abs(across)) / .24))
  const root = Math.max(0, Math.min(1, (pixel - 312) / 10))
  const tip = Math.max(0, Math.min(1, (MIDDLE_WAVE[MIDDLE_WAVE.length - 1][0] - pixel) / 7))
  const back = section.z - section.depth * Math.sqrt(Math.max(0, 1 - across * across))
  const excess = Math.max(0, back + .045 - point.z)
  // Keep a positive depth derivative so the lining remains a solid volume
  // as it recedes behind the visible wave rather than collapsing to a plane.
  const inset = .96 * (excess - .010 * Math.tanh(excess / .010))
  point.z += inset * edge * edge * (3 - 2 * edge) * root * root * (3 - 2 * root) * tip * tip * (3 - 2 * tip)
  return point
}

function hemLining(point: Vector3) {
  const pixel = 175.4-point.y/UNIT
  if (pixel <= 355) return point
  const t = Math.min(1,(pixel-355)/35), blend = t*t*(3-2*t)
  const x = Math.abs(point.x)
  const tuckedX = .46+(x-.46)*.65
  const tuckedPixel = 355+36*Math.tanh((pixel-355)/36)
  const inner = profileLockSection(HEM_INNER,tuckedPixel)!.z
  const outer = profileLockSection(HEM_MAIN,tuckedPixel)!.z
  const center = inner+(outer-inner)*Math.max(0,Math.min(1,(tuckedX-.43)/.17))
  point.x += Math.sign(point.x)*(tuckedX-x)*blend
  point.y += (pixel-tuckedPixel)*UNIT
  point.z += (center+(point.z-center)*.12-point.z)*blend
  return point
}

function profileLockGeometry(side: number, sections: ProfileLockSections = MIDDLE_WAVE, facing: 'rear' | 'both' = 'rear', tint = 0x6e80e6) {
  const rows = 128, columns = 64, positions: number[] = [], colors: number[] = [], indices: number[] = []
  const base = new Color(tint), dark = new Color(0x4055ad), light = new Color(0x9aaaff), color = new Color()
  const triangle = side > 0 ? (a: number,b: number,c: number) => indices.push(a,b,c)
    : (a: number,b: number,c: number) => indices.push(a,c,b)
  const first = sections[0][0], last = sections[sections.length - 1][0]
  function pigment(across: number, around: number, t: number) {
    const rear = facing === 'both' ? Math.abs(around) : Math.max(0,-around), inner = Math.max(0,-across) ** 2
    const edge = Math.abs(across) ** 1.5
    const band = Math.exp(-(((across - .20 + .06 * Math.sin(t * 6)) / .20) ** 2))
    color.copy(base).lerp(dark,.38 * edge + .14 * (1 - rear) + .18 * inner * Math.sin(Math.PI * t) ** .4)
    color.lerp(light,.55 * band * rear * Math.sin(Math.PI * t) ** .5)
    colors.push(color.r,color.g,color.b)
  }
  for (let row = 0; row <= rows; row++) {
    const t = row / rows, pixel = first + (last - first) * t
    const section = profileLockSection(sections,pixel)!, pole = row === 0 || row === rows, offset = positions.length / 3
    for (let column = 0; column < (pole ? 1 : columns); column++) {
      const angle = 2 * Math.PI * column / columns, across = Math.cos(angle), around = Math.sin(angle)
      positions.push(side * (section.x + section.width * across), (175.4 - pixel) * UNIT, section.z + section.depth * around)
      pigment(across,around,t)
    }
    for (let column = 0; row > 0 && column < columns; column++) {
      const next = (column + 1) % columns
      if (row === 1) triangle(0,offset + next,offset + column)
      else if (row === rows) triangle(offset - columns + column,offset - columns + next,offset)
      else {
        const previous = offset - columns
        triangle(previous + column,previous + next,offset + column)
        triangle(previous + next,offset + next,offset + column)
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position',new Float32BufferAttribute(positions,3))
  geometry.setAttribute('color',new Float32BufferAttribute(colors,3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

// The lower clumps have a returning, concave edge. Build a closed curved
// volume from that outline, with its thickness authored in the side view.
// Each face belongs to this same mesh at every camera angle.
function hemCurlGeometry(side: number, sections: ProfileLockSections, start: readonly [number,number], curves: readonly Curve[], tint: number) {
  const shape = new Shape().moveTo((257 - start[0]) * UNIT,(175.4 - start[1]) * UNIT)
  for (const [a,b,c,d,e,f] of curves) shape.bezierCurveTo((257-a)*UNIT,(175.4-b)*UNIT,
    (257-c)*UNIT,(175.4-d)*UNIT,(257-e)*UNIT,(175.4-f)*UNIT)
  shape.closePath()
  const boundary = shape.getPoints(32)
  const source = new ExtrudeGeometry(shape,{ depth: .035, bevelEnabled: false, curveSegments: 32, steps: 1 })
  source.computeBoundingBox()
  const bottomPixel = 175.4-source.boundingBox!.min.y/UNIT
  const geometry = refineProfile(source,.018)
  source.dispose()
  const points = geometry.attributes.position, colors: number[] = []
  const base = new Color(tint), dark = new Color(0x4055ad), light = new Color(0x9aaaff), color = new Color()
  for (let index = 0; index < points.count; index++) {
    const x = points.getX(index), y = points.getY(index), face = points.getZ(index) / .035
    const intersections: number[] = []
    for (let segment = 1; segment < boundary.length; segment++) {
      const a = boundary[segment-1], b = boundary[segment]
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) intersections.push(a.x + (b.x-a.x)*(y-a.y)/(b.y-a.y))
    }
    intersections.sort((a,b) => a-b)
    let across = 0, dome = 0
    for (let interval = 1; interval < intersections.length; interval += 2) {
      const left = intersections[interval-1], right = intersections[interval]
      if (x < left-1e-6 || x > right+1e-6) continue
      across = Math.max(-1,Math.min(1,(2*x-left-right)/(right-left || 1)))
      dome = Math.sqrt(Math.max(0,1-across*across))
      break
    }
    const pixel = Math.max(sections[0][0],Math.min(sections[sections.length-1][0],175.4-y/UNIT))
    const section = profileLockSection(sections,pixel)!
    const t = (pixel-sections[0][0])/(sections[sections.length-1][0]-sections[0][0])
    const shear = -.56*section.depth*Math.sin(Math.PI*t)**.35
    const thickness = Math.sqrt(Math.max(0,section.depth*section.depth-shear*shear))
    const tip = sections === HEM_MAIN ? Math.max(0,Math.min(1,(pixel-399)/14)) : 0
    const turn = tip*tip*(3-2*tip)
    const rimDepth = .006+.028*turn
    const tipFall = Math.max(0,Math.min(1,(bottomPixel-pixel)/12))
    const tipVolume = .055+.945*Math.sin(Math.PI*tipFall/2)**.45
    // The returning outline ends in a narrow solid tip in both profiles.
    // A constant rim width left a rectangular end when viewed sideways.
    const depth = (rimDepth+Math.max(0,thickness-rimDepth)*dome)*tipVolume
    const returnFall = sections === HEM_MAIN ? Math.max(0,Math.min(1,(pixel-390)/25)) : 0
    const mainTipDistance=Math.hypot(x-(257-174)*UNIT,y-(175.4-407)*UNIT)
    const returnSweep = .070*returnFall*returnFall*(3-2*returnFall)*Math.exp(-((mainTipDistance/.085)**4))
    points.setXYZ(index,side*x,y,section.z-.018*turn-returnSweep+shear*across+(2*face-1)*depth)
    const edge = Math.abs(across)**1.5
    const band = Math.exp(-(((across-.20+.06*Math.sin(t*6))/.24)**2))
    color.copy(base).lerp(dark,.34*edge+.12*(1-dome))
    color.lerp(light,.43*band*dome*Math.sin(Math.PI*t)**.5)
    colors.push(color.r,color.g,color.b)
  }
  if (side < 0) {
    const indices = geometry.index!
    for (let index = 0; index < indices.count; index += 3) {
      const b = indices.getX(index+1); indices.setX(index+1,indices.getX(index+2)); indices.setX(index+2,b)
    }
  }
  geometry.setAttribute('color',new Float32BufferAttribute(colors,3))
  geometry.computeVertexNormals()
  return geometry
}

// Two authored contours constrain the same closed 3D curl. The field is
// used only to construct geometry; no raster, texture or camera enters it.
function continuousSideCurlGeometry(side: number, tint: number) {
  const x=(pixel:number)=>(257-pixel)*UNIT,y=(pixel:number)=>(175.4-pixel)*UNIT
  const z=(pixel:number)=>-(pixel-198)*UNIT-.01
  const front=new Shape().moveTo(x(155),y(299))
    .bezierCurveTo(x(142),y(315),x(126),y(335),x(128),y(353))
    .bezierCurveTo(x(112),y(371),x(116),y(391),x(130),y(403))
    .bezierCurveTo(x(141),y(414),x(160),y(421),x(174),y(407))
    .bezierCurveTo(x(162),y(413),x(164),y(405),x(164),y(396))
    .bezierCurveTo(x(162),y(379),x(175),y(363),x(182),y(344))
    .bezierCurveTo(x(192),y(325),x(170),y(314),x(155),y(299))
  const profile=new Shape().moveTo(z(286),y(299))
    .bezierCurveTo(z(300),y(322),z(303),y(347),z(309),y(370))
    .bezierCurveTo(z(317),y(391),z(306),y(408),z(289),y(415))
    .bezierCurveTo(z(277),y(420),z(266),y(415),z(267),y(405))
    .bezierCurveTo(z(270),y(412),z(280),y(416),z(285),y(407))
    .bezierCurveTo(z(281),y(410),z(278),y(408),z(280),y(398))
    .bezierCurveTo(z(286),y(380),z(270),y(366),z(264),y(348))
    .bezierCurveTo(z(256),y(328),z(271),y(308),z(286),y(299))
  front.closePath();profile.closePath()
  const contours=[front.getPoints(48),profile.getPoints(48)]
  function distance(px:number,py:number,boundary:typeof contours[number]) {
    let minimum=Infinity,inside=false
    for(let i=0,j=boundary.length-1;i<boundary.length;j=i++) {
      const a=boundary[j],b=boundary[i],dx=b.x-a.x,dy=b.y-a.y
      const t=Math.max(0,Math.min(1,((px-a.x)*dx+(py-a.y)*dy)/(dx*dx+dy*dy||1)))
      minimum=Math.min(minimum,(px-a.x-dx*t)**2+(py-a.y-dy*t)**2)
      if((a.y>py)!==(b.y>py)&&px<(b.x-a.x)*(py-a.y)/(b.y-a.y)+a.x) inside=!inside
    }
    return Math.sqrt(minimum)*(inside?-1:1)
  }
  const resolution=128,size=.80,center=new Vector3(.60,-1.04,-.49)
  const frontField=new Float32Array(resolution*resolution),sideField=new Float32Array(resolution*resolution)
  const coordinate=(i:number,c:number)=>c+(i/resolution-.5)*size
  for(let row=0;row<resolution;row++) for(let column=0;column<resolution;column++) {
    const py=coordinate(row,center.y)
    frontField[row*resolution+column]=distance(coordinate(column,center.x),py,contours[0])-.003
    sideField[row*resolution+column]=distance(coordinate(column,center.z),py,contours[1])-.003
  }
  function intervals(boundary:typeof contours[number],y:number) {
    const hits:number[]=[]
    for(let i=0,j=boundary.length-1;i<boundary.length;j=i++) {
      const a=boundary[j],b=boundary[i]
      if((a.y>y)!==(b.y>y))hits.push(a.x+(b.x-a.x)*(y-a.y)/(b.y-a.y))
    }
    hits.sort((a,b)=>a-b)
    const spans:{center:number,radius:number}[]=[]
    for(let i=1;i<hits.length;i+=2)spans.push({center:(hits[i-1]+hits[i])*.5,radius:(hits[i]-hits[i-1])*.5+.003})
    return spans
  }
  const sections=Array.from({length:resolution},(_,i)=>{
    const y=coordinate(i,center.y)
    return {front:intervals(contours[0],y),side:intervals(contours[1],y)}
  })
  const paint=new MeshBasicMaterial(),march=new MarchingCubes(resolution,paint,false,false,120000)
  march.isolation=0
  for(let iz=0;iz<resolution;iz++) for(let iy=0;iy<resolution;iy++) {
    const pixel=175.4-coordinate(iy,center.y)/UNIT
    const end=Math.max(0,Math.min(1,(pixel-399)/10)),fillet=.075*(1-end)+.008*end
    const b=sideField[iy*resolution+iz]
    for(let ix=0;ix<resolution;ix++) {
      const a=frontField[iy*resolution+ix],h=Math.max(0,fillet-Math.abs(a-b))/fillet
      const roundedBox=Math.max(a,b)+h*h*fillet*.25,row=sections[iy]
      let ellipse=Infinity
      for(const front of row.front)for(const profile of row.side) {
        const qx=(coordinate(ix,center.x)-front.center)/front.radius,qz=(coordinate(iz,center.z)-profile.center)/profile.radius
        ellipse=Math.min(ellipse,(Math.hypot(qx/.62,qz/.62)-1)*Math.min(front.radius,profile.radius))
      }
      const u=Math.max(0,Math.min(1,(pixel-324)/20)),blend=u*u*(3-2*u)
      const body=Number.isFinite(ellipse)?roundedBox+(ellipse-roundedBox)*blend:roundedBox,root=coordinate(iy,center.y)-y(320),join=.020,g=Math.max(0,join-Math.abs(body-root))/join
      march.field[ix+iy*resolution+iz*resolution*resolution]=-(Math.max(body,root)+g*g*join*.25)
    }
  }
  march.update()
  const raw=march.geometry.attributes.position,count=march.geometry.drawRange.count
  if(!Number.isFinite(count)||count>raw.count||count%3!==0)throw new Error('Curl authoring sampler exceeded its geometry capacity')
  const positions:number[]=[],indices:number[]=[],vertices=new Map<string,number>()
  for(let i=0;i<count;i++) {
    const px=(center.x+raw.getX(i)*size*.5)*side,py=center.y+raw.getY(i)*size*.5,pz=center.z+raw.getZ(i)*size*.5
    const key=Math.round(px*1e6)+':'+Math.round(py*1e6)+':'+Math.round(pz*1e6)
    let index=vertices.get(key)
    if(index===undefined) {index=positions.length/3;vertices.set(key,index);positions.push(px,py,pz)}
    indices.push(index)
  }
  march.geometry.dispose();paint.dispose()
  const geometry=new BufferGeometry()
  geometry.setAttribute('position',new Float32BufferAttribute(positions,3))
  if(side<0)for(let i=0;i<indices.length;i+=3){const t=indices[i+1];indices[i+1]=indices[i+2];indices[i+2]=t}
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  const normals=geometry.attributes.normal,colors:number[]=[],base=new Color(tint),dark=new Color(0x4055ad),light=new Color(0x9aaaff),color=new Color()
  for(let i=0;i<positions.length/3;i++) {
    const pixel=175.4-positions[i*3+1]/UNIT,across=(Math.abs(positions[i*3])-.57)/.19
    const band=Math.exp(-(((across-.15+.12*Math.sin(pixel*.07))/.40)**2))
    color.copy(base).lerp(dark,.12+.12*(1-Math.abs(normals.getZ(i))))
    color.lerp(light,.32*band*Math.abs(normals.getZ(i)))
    colors.push(color.r,color.g,color.b)
  }
  geometry.setAttribute('color',new Float32BufferAttribute(colors,3))
  geometry.userData.authoringSampler={resolution,usedTriangles:count/3,capacityTriangles:raw.count/3,peakExpandedVertices:count}
  return geometry
}

// Carry the former root's actual fin-clearance displacement onto the
// joined surface using the closest source triangle and its barycentric weights.
function curlSettlementGeometry(geometry:BufferGeometry,source:BufferGeometry) {
  const settlement=source.morphAttributes.position?.[0]
  if(!settlement)return
  const positions=source.attributes.position,index=source.index!,array=positions.array,lookup=index.array
  type Node={bounds:number[],left?:Node,right?:Node,faces?:number[]}
  const faces=Array.from({length:index.count/3},(_,i)=>i),bounds=faces.map(face=>{
    const ids=[lookup[face*3],lookup[face*3+1],lookup[face*3+2]]
    return [0,1,2].map(axis=>Math.min(...ids.map(i=>array[i*3+axis]))).concat([0,1,2].map(axis=>Math.max(...ids.map(i=>array[i*3+axis]))))
  })
  function build(faces:number[]):Node {
    const box=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity]
    for(const face of faces)for(let axis=0;axis<3;axis++){box[axis]=Math.min(box[axis],bounds[face][axis]);box[axis+3]=Math.max(box[axis+3],bounds[face][axis+3])}
    if(faces.length<=20)return{bounds:box,faces}
    const spans=[0,1,2].map(axis=>box[axis+3]-box[axis]),axis=spans.indexOf(Math.max(...spans))
    faces.sort((a,b)=>bounds[a][axis]+bounds[a][axis+3]-bounds[b][axis]-bounds[b][axis+3])
    const middle=Math.floor(faces.length/2)
    return{bounds:box,left:build(faces.slice(0,middle)),right:build(faces.slice(middle))}
  }
  const root=build(faces),p=geometry.attributes.position,target=new BufferGeometry(),values=new Float32BufferAttribute(new Float32Array(p.array),3)
  const a=new Vector3(),b=new Vector3(),c=new Vector3(),point=new Vector3(),nearest=new Vector3(),selected=new Vector3(),barycentric=new Vector3(),triangle=new Triangle(),stack:Node[]=[]
  const boxDistance=(box:number[])=>{
    const dx=Math.max(0,box[0]-point.x,point.x-box[3]),dy=Math.max(0,box[1]-point.y,point.y-box[4]),dz=Math.max(0,box[2]-point.z,point.z-box[5])
    return dx*dx+dy*dy+dz*dz
  }
  function vertices(face:number) {
    a.fromBufferAttribute(positions,lookup[face*3]);b.fromBufferAttribute(positions,lookup[face*3+1]);c.fromBufferAttribute(positions,lookup[face*3+2])
  }
  for(let i=0;i<p.count;i++) {
    point.fromBufferAttribute(p,i)
    if(175.4-point.y/UNIT>285)continue
    let best=.08*.08,face=-1
    stack.length=0;stack.push(root)
    while(stack.length) {
      const node=stack.pop()!
      if(boxDistance(node.bounds)>=best)continue
      if(node.faces)for(const candidate of node.faces) {
        vertices(candidate);triangle.set(a,b,c).closestPointToPoint(point,nearest)
        const d=point.distanceToSquared(nearest)
        if(d<best){best=d;face=candidate;selected.copy(nearest)}
      }else{const left=node.left!,right=node.right!;if(boxDistance(left.bounds)<boxDistance(right.bounds))stack.push(right,left);else stack.push(left,right)}
    }
    if(face<0)continue
    vertices(face);triangle.set(a,b,c).getBarycoord(selected,barycentric)
    const t=Math.max(0,Math.min(1,(Math.sqrt(best)-.02)/.06)),weight=1-t*t*(3-2*t),delta=new Vector3()
    for(let corner=0;corner<3;corner++) {
      const j=lookup[face*3+corner],b=corner===0?barycentric.x:corner===1?barycentric.y:barycentric.z
      delta.x+=(settlement.getX(j)-positions.getX(j))*b
      delta.y+=(settlement.getY(j)-positions.getY(j))*b
      delta.z+=(settlement.getZ(j)-positions.getZ(j))*b
    }
    values.setXYZ(i,point.x+delta.x*weight,point.y+delta.y*weight,point.z+delta.z*weight)
  }
  values.name='fin-clearance-root'
  target.setAttribute('position',values);target.setIndex(geometry.index);target.computeVertexNormals()
  return target
}

// Rebuild the visible shoulder S from the actual sculpted Y/Z boundary.
// Its outside X stays fixed; depth grows inward into a rounded section,
// whose gradual correlation follows the real 3D centre tangent.
// Rebuild the visible shoulder S from the actual sculpted Y/Z boundary.
// Its outside X stays fixed; depth grows inward into a rounded section,
// whose gradual correlation follows the real 3D centre tangent.
function sculptSideMainGeometry(source:BufferGeometry,lower:BufferGeometry,side:number,tint:number) {
  const p=source.attributes.position,q=source.index!.array
  let top=-Infinity,bottom=Infinity
  for(let i=0;i<p.count;i++){top=Math.max(top,p.getY(i));bottom=Math.min(bottom,p.getY(i))}
  const first=175.4-top/UNIT,sourceLast=175.4-bottom/UNIT,last=340,samples=96,sections:(readonly[number,number,number,number,number])[]=[]
  for(let row=0;row<=samples;row++) {
    const t=row/samples,pixel=first+(last-first)*t,py=(175.4-Math.min(sourceLast-.005,Math.max(first+.005,pixel)))*UNIT
    let outer=-Infinity,inner=Infinity,z0=Infinity,z1=-Infinity
    for(let face=0;face<q.length;face+=3)for(let edge=0;edge<3;edge++) {
      const a=q[face+edge],b=q[face+(edge+1)%3],ay=p.getY(a),by=p.getY(b)
      if((ay>py)===(by>py))continue
      const u=(py-ay)/(by-ay),x=Math.abs(p.getX(a)+(p.getX(b)-p.getX(a))*u),z=p.getZ(a)+(p.getZ(b)-p.getZ(a))*u
      outer=Math.max(outer,x);inner=Math.min(inner,x);z0=Math.min(z0,z);z1=Math.max(z1,z)
    }
    if(!Number.isFinite(outer))throw new Error('Shoulder lock has an empty source section')
    const root=Math.max(0,Math.min(1,(pixel-first)/12)),grow=root*root*(3-2*root)
    const end=1
    let rx=Math.max((outer-inner)*.5,.088*grow*end),cx=outer-rx,cz=(z0+z1)*.5,rz=(z1-z0)*.5
    if(pixel>285) {
      const lp=lower.attributes.position,lq=lower.index!.array,ly=(175.4-Math.max(324,Math.min(338,pixel)))*UNIT
      let lo=-Infinity,li=Infinity,lz0=Infinity,lz1=-Infinity
      for(let face=0;face<lq.length;face+=3)for(let edge=0;edge<3;edge++) {
        const a=lq[face+edge],b=lq[face+(edge+1)%3],ay=lp.getY(a),by=lp.getY(b)
        if((ay>ly)===(by>ly))continue
        const u=(ly-ay)/(by-ay),x=Math.abs(lp.getX(a)+(lp.getX(b)-lp.getX(a))*u),z=lp.getZ(a)+(lp.getZ(b)-lp.getZ(a))*u
        lo=Math.max(lo,x);li=Math.min(li,x);lz0=Math.min(lz0,z);lz1=Math.max(lz1,z)
      }
      if(!Number.isFinite(lo))throw new Error('Lower S join has an empty section')
      const t=Math.max(0,Math.min(1,(pixel-285)/40)),mix=t*t*(3-2*t)
      cx+=(.5*(lo+li)-cx)*mix;rx+=(.5*(lo-li)-rx)*mix
      cz+=(.5*(lz0+lz1)-cz)*mix;rz+=(.5*(lz1-lz0)-rz)*mix
      const c=Math.max(0,Math.min(1,(340-pixel)/14)),cap=c*c*(3-2*c)
      rx*=cap;rz*=cap
    }
    if(row===0){cx=(outer+inner)*.5;rx=0;rz=0}
    if(row===samples){rx=0;rz=0}
    sections.push([pixel,257-(cx+rx)/UNIT,257-(cx-rx)/UNIT,cz+rz,cz-rz])
  }
  const rows=160,columns=48,positions:number[]=[],indices:number[]=[],colors:number[]=[]
  const triangle=(a:number,b:number,c:number)=>side>0?indices.push(a,b,c):indices.push(a,c,b)
  for(let row=0;row<=rows;row++) {
    const t=row/rows,pixel=first+(last-first)*t,s=profileLockSection(sections,pixel)!,pole=row===0||row===rows,offset=positions.length/3
    const previous=profileLockSection(sections,Math.max(first,pixel-.5))!,next=profileLockSection(sections,Math.min(last,pixel+.5))!
    const dy=(Math.min(last,pixel+.5)-Math.max(first,pixel-.5))*UNIT||UNIT,sx=(next.x-previous.x)/dy,sz=(next.z-previous.z)/dy
    const rho=.65*sx*sz/Math.sqrt((1+sx*sx)*(1+sz*sz))*Math.sin(Math.PI*t)**2
    for(let column=0;column<(pole?1:columns);column++) {
      const angle=column/columns*Math.PI*2,across=Math.cos(angle),around=Math.sin(angle)
      positions.push(side*(s.x+s.width*across),(175.4-pixel)*UNIT,s.z+s.depth*(rho*across+Math.sqrt(1-rho*rho)*around))
    }
    for(let column=0;row>0&&column<columns;column++) {
      const next=(column+1)%columns
      if(row===1)triangle(0,offset+next,offset+column)
      else if(row===rows)triangle(offset-columns+column,offset-columns+next,offset)
      else {const previous=offset-columns;triangle(previous+column,previous+next,offset+column);triangle(previous+next,offset+next,offset+column)}
    }
  }
  const geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute(positions,3));geometry.setIndex(indices);geometry.computeVertexNormals()
  const normals=geometry.attributes.normal,base=new Color(tint),dark=new Color(0x4055ad),light=new Color(0x9aaaff),color=new Color()
  for(let i=0;i<positions.length/3;i++) {
    const pixel=175.4-positions[i*3+1]/UNIT,across=(Math.abs(positions[i*3])-.57)/.19,band=Math.exp(-(((across-.15+.12*Math.sin(pixel*.07))/.40)**2))
    color.copy(base).lerp(dark,.12+.12*(1-Math.abs(normals.getZ(i))));color.lerp(light,.32*band*Math.abs(normals.getZ(i)));colors.push(color.r,color.g,color.b)
  }
  geometry.setAttribute('color',new Float32BufferAttribute(colors,3))
  geometry.userData.sideMainLoft={sourceBoundarySlices:samples,rows,columns,preservesOutsideXAndYZBoundsAbove285:true,joinsActualLowerSections:[285,325,340],inwardRadius:.088,tangentDrivenCorrelation:true}
  return geometry
}

// A genuinely curved, tapering solid strand. Upper centres come from the
// actual shoulder lock; the lower guides form a continuous 3D return.
function guidedContinuousSGeometry(source:BufferGeometry,side:number,tint:number,part:'upper'|'lower'='lower') {
  const p=source.attributes.position,q=source.index!.array
  let top=-Infinity;for(let i=0;i<p.count;i++)top=Math.max(top,p.getY(i))
  const first=175.4-top/UNIT,guide:{point:Vector3,width:number,depth:number}[]=[]
  for(let row=0;row<=12;row++) {
    const pixel=first+(280-first)*row/12,py=(175.4-Math.max(first+.002,pixel))*UNIT
    let lo=-Infinity,li=Infinity,z0=Infinity,z1=-Infinity
    for(let f=0;f<q.length;f+=3)for(let k=0;k<3;k++) {
      const a=q[f+k],b=q[f+(k+1)%3],ay=p.getY(a),by=p.getY(b)
      if((ay>py)===(by>py))continue
      const u=(py-ay)/(by-ay),x=Math.abs(p.getX(a)+(p.getX(b)-p.getX(a))*u),z=p.getZ(a)+(p.getZ(b)-p.getZ(a))*u
      lo=Math.max(lo,x);li=Math.min(li,x);z0=Math.min(z0,z);z1=Math.max(z1,z)
    }
    if(!Number.isFinite(lo))throw new Error('Actual shoulder guide section is empty')
    guide.push({point:new Vector3(side*(lo+li)*.5,(175.4-pixel)*UNIT,(z0+z1)*.5),width:row===0?0:Math.min(.088,(lo-li)*.5),depth:row===0?0:(z1-z0)*.5})
  }
  // Keep the original physical root only. Old profile-section extrema are
  // not a centreline and their sampling density must not set the S turns.
  const root=guide[0];guide.length=0
  if(part==='upper')guide.push(root)
  const design=part==='upper'?[
    [225,.505,-.225,.045,.024],[245,.54,-.395,.072,.027],
    [265,.60,-.610,.083,.028],[285,.66,-.740,.090,.029],
    [300,.64,-.680,.120,.045],[316,.56,-.575,.090,.035],
    [324,.515,-.535,.040,.020],[327,.505,-.5264,0,0],
  ]:[
    [306,.57,-.640,0,0],[324,.58,-.610,.120,.045],
    [343,.62,-.520,.140,.055],[370,.65,-.530,.150,.060],
    [394,.63,-.540,.120,.050],[408,.57,-.430,.080,.040],
    [417,.52,-.360,.045,.024],[413,.47,-.280,.025,.018],
    [408,.45,-.270,0,0],
  ]
  for(const[y,x,z,width,depth]of design)guide.push({point:new Vector3(side*x,(175.4-y)*UNIT,z+(side>0?.045*Math.exp(-(((y-350)/40)**4)):0)),width,depth})
  const splineControls=guide.map(g=>[g.point.x,g.point.y,g.point.z,g.width,g.depth]),knots=Array.from({length:guide.length+4},(_,i)=>i<4?0:i>=guide.length?1:(i-3)/(guide.length-3))
  function splineSection(t:number) {
    const u=Math.max(0,Math.min(1,t));let span=guide.length-1
    if(u<1)for(let k=3;k<guide.length;k++)if(u>=knots[k]&&u<knots[k+1]){span=k;break}
    const d=Array.from({length:4},(_,j)=>splineControls[span-3+j].slice())
    for(let r=1;r<=3;r++)for(let j=3;j>=r;j--) {
      const i=span-3+j,den=knots[i+4-r]-knots[i],a=den?(u-knots[i])/den:0
      for(let k=0;k<5;k++)d[j][k]=d[j-1][k]*(1-a)+d[j][k]*a
    }
    return d[3]
  }
  const path=new class extends SpatialCurve<Vector3> {constructor(){super()} getPoint(t:number,target=new Vector3()){const p=splineSection(t);return target.set(p[0],p[1],p[2])}}()
  const rows=240,columns=48,positions:number[]=[],colors:number[]=[],indices:number[]=[],centres:Vector3[]=[]
  const base=new Color(tint),dark=new Color(0x4055ad),light=new Color(0x9aaaff),color=new Color(),widthAxis=new Vector3(side,0,0),depthAxis=new Vector3()
  const triangle=(a:number,b:number,c:number)=>indices.push(a,c,b)
  for(let row=0;row<=rows;row++) {
    const t=row/rows,section=splineSection(t),center=path.getPoint(t),tangent=path.getTangent(t).normalize(),baseWidth=section[3],baseDepth=section[4]
    const curvature=Math.max(...[-.5/rows,0,.5/rows].map(dt=>curlPathCurvature(path,Math.max(0,Math.min(1,t+dt)))))
    const pixelAt=175.4-center.y/UNIT,safeScale=(1+(Math.max(baseWidth,baseDepth)*curvature/.78)**6)**(-1/6)
    const width=baseWidth*safeScale,depth=baseDepth*safeScale
    widthAxis.addScaledVector(tangent,-widthAxis.dot(tangent)).normalize()
    const q=Math.max(0,Math.min(1,(t-.82)/.12)),roll=q*q*(3-2*q),widthGuide=new Vector3(side*.8,0,.6*(1-roll))
    const diagonal=widthGuide.clone().addScaledVector(tangent,-widthGuide.dot(tangent)),turn=Math.max(0,Math.min(1,(pixelAt-225)/80))
    if(diagonal.lengthSq()>.01){diagonal.normalize();if(diagonal.dot(widthAxis)<0)diagonal.negate();widthAxis.lerp(diagonal,.16*turn*turn*(3-2*turn)).addScaledVector(tangent,-widthAxis.dot(tangent)).normalize()}
    depthAxis.crossVectors(tangent,widthAxis).normalize()
    const acrossAxis=widthAxis.clone(),aroundAxis=depthAxis.clone()
    const pole=row===0||row===rows,offset=positions.length/3
    for(let column=0;column<(pole?1:columns);column++) {
      const angle=column/columns*Math.PI*2,a=Math.cos(angle),b=Math.sin(angle),point=center.clone().addScaledVector(acrossAxis,width*a).addScaledVector(aroundAxis,depth*b)
      positions.push(point.x,point.y,point.z);centres.push(center.clone())
      const band=Math.exp(-(((a-.2)/.30)**2)),turn=Math.sin(Math.PI*t)**.5
      color.copy(base).lerp(dark,.10+.16*Math.abs(a)**1.4+.10*(1-Math.abs(b)));color.lerp(light,.44*band*Math.abs(b)*turn);colors.push(color.r,color.g,color.b)
    }
    for(let k=0;row>0&&k<columns;k++) {
      const next=(k+1)%columns
      if(row===1)triangle(0,offset+k,offset+next)
      else if(row===rows)triangle(offset-columns+k,offset,offset-columns+next)
      else {const previous=offset-columns;triangle(previous+k,offset+k,previous+next);triangle(previous+next,offset+k,offset+next)}
    }
  }
  const geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute(positions,3));geometry.setAttribute('curlSectionAnchor',new Float32BufferAttribute(centres.flatMap(p=>[p.x,p.y,p.z]),3));geometry.setAttribute('color',new Float32BufferAttribute(colors,3));geometry.setIndex(indices);geometry.computeVertexNormals()
  geometry.userData.continuousS={part,rows,columns,parallelTransportFrame:true,trueFixedCentrelineFromRoot:part==='upper',fullyNormalFrame:true,continuouslyTapered:true}
  geometry.userData.finiteMainVolume={sourceSpace:'fixedXYZ',part,method:'fixed cubicB-spline; separate upper pointed wave and buried-root lower curl; finite normal-plane ellipse',majorHalfMax:part==='upper'?.120:.150,minorHalfMax:part==='upper'?.045:.060,returnWidthRoll:'positiveZ tangent to pureX along path.82.. .94',rootOriginal:part==='upper',buriedUpperJoin:part==='lower',returnTipRebuilt:true,noCameraInput:true,lowerReturnRevision:33}
  return geometry
}

// Keep the lower return with the pelvis while its root follows the head.
// Every complete cross-section shares a weight, including the attached ridge.
function lowerReturnWeights(geometry:BufferGeometry,headThrough=230,hipsFrom=310) {
  const sections=geometry.attributes.curlSectionAnchor??geometry.attributes.position
  const joints:number[]=[],weights:number[]=[]
  for(let i=0;i<sections.count;i++) {
    const pixel=175.4-sections.getY(i)/UNIT,t=Math.max(0,Math.min(1,(pixel-headThrough)/(hipsFrom-headThrough)))
    const hip=t*t*(3-2*t)
    joints.push(0,1,0,0);weights.push(1-hip,hip,0,0)
  }
  geometry.setAttribute('skinIndex',new Uint16BufferAttribute(joints,4))
  geometry.setAttribute('skinWeight',new Float32BufferAttribute(weights,4))
}

function lowerReturnMesh(geometry:BufferGeometry,material:MeshPhongMaterial|MeshBasicMaterial,parent:Object3D,range:readonly[number,number]=[230,310],headRoot=false) {
  let hips:Object3D|undefined=parent
  while(hips&&hips.name!=='hips')hips=hips.parent??undefined
  if(!(parent instanceof Bone)||!(hips instanceof Bone))throw new Error('Lower hair requires back-hair and pelvis bones')
  lowerReturnWeights(geometry,...range)
  const mesh=new SkinnedMesh(geometry,material)
  parent.add(mesh);mesh.updateWorldMatrix(true,false);mesh.bind(new Skeleton([headRoot?parent.parent as Bone:parent,hips]))
  mesh.userData.lowerReturnAnchor={headThrough:range[0],hipsFrom:range[1],sectionWeights:true,noCameraInput:true}
  return mesh
}

// The waist curls rest against the torso. Keep their closed upper wave
// on one affine torso blend; only the lower return settles toward the hips.
function bindTorsoCurl(mesh:Mesh,parent:Object3D,upper=false) {
  if(!(mesh instanceof SkinnedMesh))throw new Error('Waist curl must be a skinned volume')
  let spine:Object3D|undefined=parent,hips:Object3D|undefined=parent
  while(spine&&spine.name!=='spine')spine=spine.parent??undefined
  while(hips&&hips.name!=='hips')hips=hips.parent??undefined
  if(!(spine instanceof Bone)||!(hips instanceof Bone))throw new Error('Waist curl requires torso bones')
  lowerReturnWeights(mesh.geometry,306,360)
  const weights=mesh.geometry.attributes.skinWeight
  for(let i=0;i<weights.count;i++){const torso=upper?.5:.5*weights.getX(i);weights.setXY(i,torso,1-torso)}
  mesh.updateWorldMatrix(true,false);mesh.bind(new Skeleton([spine,hips]))
  delete mesh.userData.lowerReturnAnchor
  mesh.userData.torsoCurlAnchor={spineBone:spine.name,hipsBone:hips.name,upperAffineBlend:upper,spineRootWeight:.5,fullyPelvicFrom:360,sourceRoot:306,noCameraInput:true}
}

// Trim the old folded backing at its actual material chart and close the cut.
// All surviving crown vertices retain their authored positions and skin anchors.
function crownBackingOnly(source:BufferGeometry,headAnchors:number[],chart:number[]) {
  const cutoff=(175.4-225)*UNIT,position=source.attributes.position
  const names=Object.keys(source.attributes).filter(n=>n!=='normal')
  const values:Record<string,number[]>={},anchors:number[]=[],coordinates:number[]=[],indices:number[]=[]
  for(const name of names)values[name]=[]
  const vertices=new Map<string,number>()
  const add=(key:string,a:number,b=a,t=0)=>{
    const present=vertices.get(key);if(present!==undefined)return present
    const index=anchors.length;vertices.set(key,index)
    for(const name of names){const attribute=source.attributes[name];for(let k=0;k<attribute.itemSize;k++)values[name].push(attribute.array[a*attribute.itemSize+k]*(1-t)+attribute.array[b*attribute.itemSize+k]*t)}
    anchors.push(headAnchors[a]*(1-t)+headAnchors[b]*t)
    for(let k=0;k<3;k++)coordinates.push(chart[a*3+k]*(1-t)+chart[b*3+k]*t)
    return index
  }
  for(let f=0;f<source.index!.count;f+=3) {
    const ids=[0,1,2].map(k=>source.index!.getX(f+k)),polygon:number[]=[]
    for(let k=0;k<3;k++) {
      const a=ids[k],b=ids[(k+1)%3],ay=chart[a*3+1],by=chart[b*3+1]
      if(ay>=cutoff)polygon.push(add('v'+a,a))
      if((ay>=cutoff)!==(by>=cutoff)) {
        const t=(cutoff-ay)/(by-ay)
        polygon.push(add('e'+Math.min(a,b)+':'+Math.max(a,b),a,b,t))
      }
    }
    for(let i=1;i<polygon.length-1;i++)indices.push(polygon[0],polygon[i],polygon[i+1])
  }
  const points=values.position,weld=new Map<string,number>(),welded:number[]=[],edges=new Map<string,{a:number,b:number,count:number}>()
  for(let i=0;i<anchors.length;i++) {
    const key=[0,1,2].map(k=>Math.round(points[i*3+k]*1e7)).join(':')
    if(!weld.has(key))weld.set(key,i)
    welded.push(weld.get(key)!)
  }
  for(let f=0;f<indices.length;f+=3)for(let k=0;k<3;k++) {
    const a=welded[indices[f+k]],b=welded[indices[f+(k+1)%3]]
    if(a===b)continue
    if(Math.abs(coordinates[a*3+1]-cutoff)>.000002||Math.abs(coordinates[b*3+1]-cutoff)>.000002)continue
    const key=Math.min(a,b)+':'+Math.max(a,b),edge=edges.get(key)
    if(edge)edge.count++;else edges.set(key,{a,b,count:1})
  }
  const remaining=new Map([...edges].filter(([,e])=>e.count===1)),loops:number[][]=[]
  while(remaining.size) {
    const [key,first]=remaining.entries().next().value!;remaining.delete(key)
    const loop=[first.a,first.b];let previous=first.a,current=first.b
    while(current!==loop[0]) {
      const choices=[...remaining].filter(([,e])=>e.a===current||e.b===current)
      if(choices.length!==1)throw new Error('Crown backing cut does not form simple closed boundary loops')
      const [key,e]=choices[0];remaining.delete(key)
      const next=e.a===current?e.b:e.a
      if(next===previous)throw new Error('Crown backing cut doubled back')
      previous=current;current=next;if(current!==loop[0])loop.push(current)
    }
    loops.push(loop)
  }
  const capStart=indices.length
  let capTriangles=0
  const cap=(a:number,b:number,c:number)=>{
    if(a===b||a===c||b===c)return
    const y=(points[b*3+2]-points[a*3+2])*(points[c*3]-points[a*3])-(points[b*3]-points[a*3])*(points[c*3+2]-points[a*3+2])
    if(Math.abs(y)<1e-18)return
    indices.push(a,y>0?c:b,y>0?b:c);capTriangles++
  }
  for(const loop of loops) {
    let low=0,high=0
    for(let i=1;i<loop.length;i++){if(coordinates[loop[i]*3]<coordinates[loop[low]*3])low=i;if(coordinates[loop[i]*3]>coordinates[loop[high]*3])high=i}
    const rail=(step:number)=>{const result=[loop[low]];let i=low;while(i!==high){i=(i+step+loop.length)%loop.length;result.push(loop[i]);if(result.length>loop.length)throw new Error('Invalid crown cap rail')}return result}
    const front=rail(1),back=rail(-1);let i=0,j=0
    while(i<front.length-1||j<back.length-1) {
      if(j===back.length-1||(i<front.length-1&&coordinates[front[i+1]*3]<=coordinates[back[j+1]*3])){cap(front[i],back[j],front[i+1]);i++}
      else{cap(front[i],back[j],back[j+1]);j++}
    }
  }
  // Conform every cap edge to the retained rim's collinear boundary vertices.
  // The zipper alone can span several old rim segments at its two ends.
  const boundaryVertices=loops.flat(),queue:number[][]=[],capCoordinates=Float32Array.from(points)
  const sourceMin=Math.min(...boundaryVertices.map(i=>capCoordinates[i*3])),sourceMax=Math.max(...boundaryVertices.map(i=>capCoordinates[i*3]))
  for(let t=capStart;t<indices.length;t+=3)queue.push(indices.slice(t,t+3))
  indices.length=capStart;capTriangles=0;let capBoundarySplits=0,capVisits=0
  while(queue.length) {
    if(++capVisits>10000)throw new Error('Crown cap stitching did not converge')
    const triangle=queue.pop()!;let split=false
    const [pa,pb,pc]=triangle
    if((capCoordinates[pb*3+2]-capCoordinates[pa*3+2])*(capCoordinates[pc*3]-capCoordinates[pa*3])-(capCoordinates[pb*3]-capCoordinates[pa*3])*(capCoordinates[pc*3+2]-capCoordinates[pa*3+2])===0)continue
    for(let k=0;k<3&&!split;k++) {
      const a=triangle[k],b=triangle[(k+1)%3],opposite=triangle[(k+2)%3]
      const sourceX=capCoordinates[a*3]
      if(Math.abs(sourceX-capCoordinates[b*3])>1e-10||Math.min(Math.abs(sourceX-sourceMin),Math.abs(sourceX-sourceMax))>1e-10)continue
      const delta=[0,1,2].map(j=>capCoordinates[b*3+j]-capCoordinates[a*3+j]),length=delta.reduce((n,v)=>n+v*v,0)
      if(length<1e-24)continue
      const knots:{index:number,t:number}[]=[]
      for(const index of boundaryVertices) {
        if(index===a||index===b||index===opposite||Math.abs(capCoordinates[index*3]-sourceX)>1e-10)continue
        const offset=[0,1,2].map(j=>capCoordinates[index*3+j]-capCoordinates[a*3+j]),t=offset.reduce((n,v,j)=>n+v*delta[j],0)/length
        if(t<=1e-7||t>=1-1e-7)continue
        if(offset.reduce((n,v,j)=>n+(v-t*delta[j])**2,0)>1e-18)continue
        knots.push({index,t})
      }
      if(!knots.length)continue
      knots.sort((a,b)=>a.t-b.t)
      const rail=[a,...knots.filter((v,i)=>i===0||v.t-knots[i-1].t>1e-7).map(v=>v.index),b]
      for(let j=1;j<rail.length;j++)queue.push([rail[j-1],rail[j],opposite])
      capBoundarySplits+=rail.length-2;split=true
    }
    if(!split)cap(triangle[0],triangle[1],triangle[2])
  }
  if(!loops.length||!capTriangles)throw new Error('Crown backing cap is empty')
  // Clipping through an existing source vertex can emit zero-area triangles.
  // Clean in the actual Float32 coordinates before binding or computing normals.
  const rounded=Float32Array.from(values.position),clean:number[]=[],used=new Set<number>()
  let degenerateTrianglesRemoved=0
  for(let t=0;t<indices.length;t+=3) {
    const [a,b,c]=indices.slice(t,t+3),ab=new Vector3(rounded[b*3]-rounded[a*3],rounded[b*3+1]-rounded[a*3+1],rounded[b*3+2]-rounded[a*3+2]),ac=new Vector3(rounded[c*3]-rounded[a*3],rounded[c*3+1]-rounded[a*3+1],rounded[c*3+2]-rounded[a*3+2])
    if(ab.cross(ac).lengthSq()===0){degenerateTrianglesRemoved++;continue}
    clean.push(a,b,c);used.add(a);used.add(b);used.add(c)
  }
  const retained=[...used],lookup=new Map(retained.map((v,i)=>[v,i])),result=new BufferGeometry()
  for(const name of names){const size=source.attributes[name].itemSize;result.setAttribute(name,new Float32BufferAttribute(retained.flatMap(i=>values[name].slice(i*size,(i+1)*size)),size))}
  result.setAttribute('rearBackingSource',new Float32BufferAttribute(retained.flatMap(i=>coordinates.slice(i*3,i*3+3)),3))
  result.setIndex(clean.map(i=>lookup.get(i)!));result.computeVertexNormals();result.computeBoundingSphere()
  result.userData={...source.userData,rearBackingCrop:{sourceCutoff:225,originalVertices:position.count,retainedVertices:retained.length,degenerateTrianglesRemoved,capLoops:loops.length,capTriangles,capMethod:'source-X zipper with conforming Float32 physical rim',capBoundarySplits,closedCut:true,noCameraInput:true}}
  headAnchors.length=0;for(const i of retained)headAnchors.push(anchors[i])
  source.dispose();return result
}

// Separate closed volumes form the inner lower hair rather than a folded sheet.
function innerBackingGeometry(crown:BufferGeometry,side:number,tint:number) {
  const root=new Vector3(side*.32,(175.4-224)*UNIT,0),p=crown.attributes.position,idx=crown.index!,depths:number[]=[]
  for(let t=0;t<idx.count;t+=3) {
    const a=idx.getX(t),b=idx.getX(t+1),c=idx.getX(t+2)
    const ax=p.getX(a),ay=p.getY(a),bx=p.getX(b),by=p.getY(b),cx=p.getX(c),cy=p.getY(c)
    const den=(by-cy)*(ax-cx)+(cx-bx)*(ay-cy)
    if(Math.abs(den)<1e-14)continue
    const u=((by-cy)*(root.x-cx)+(cx-bx)*(root.y-cy))/den,v=((cy-ay)*(root.x-cx)+(ax-cx)*(root.y-cy))/den
    if(u>=-1e-7&&v>=-1e-7&&u+v<=1+1e-7)depths.push(u*p.getZ(a)+v*p.getZ(b)+(1-u-v)*p.getZ(c))
  }
  if(depths.length<2||Math.max(...depths)-Math.min(...depths)<.00001)throw new Error('Inner hair root must lie inside actual closed crown')
  root.z=(Math.min(...depths)+Math.max(...depths))*.5
  const guide:{point:Vector3,width:number,depth:number}[]=[{point:root,width:0,depth:0}]
  for(const[y,x,z,width,depth]of[
    [245,.36,-.66,.080,.040],[265,.40,-.60,.130,.060],
    [285,.42,-.54,.150,.065],[305,.42,-.54,.150,.065],
    [325,.44,-.61+(side>0?.12:0),.135,.060],[345,.49+(side>0?.06:0),-.70+(side>0?.16:0),.120,.055],
    [365,.54+(side>0?.12:0),-.69+(side>0?.16:0),.105,.050],[385,.54+(side>0?.10:0),-.64+(side>0?.13:0),.080,.040],
    [400,.49+(side>0?.06:0),-.60+(side>0?.10:0),.050,.025],[405,.43+(side>0?.04:0),-.55+(side>0?.07:0),.020,.010],
    [400,.42+(side>0?.04:0),-.53+(side>0?.06:0),0,0],
  ])guide.push({point:new Vector3(side*x,(175.4-y)*UNIT,z),width,depth})
  const splineControls=guide.map(g=>[g.point.x,g.point.y,g.point.z,g.width,g.depth]),knots=Array.from({length:guide.length+4},(_,i)=>i<4?0:i>=guide.length?1:(i-3)/(guide.length-3))
  function splineSection(t:number) {
    const u=Math.max(0,Math.min(1,t));let span=guide.length-1
    if(u<1)for(let k=3;k<guide.length;k++)if(u>=knots[k]&&u<knots[k+1]){span=k;break}
    const d=Array.from({length:4},(_,j)=>splineControls[span-3+j].slice())
    for(let r=1;r<=3;r++)for(let j=3;j>=r;j--) {
      const i=span-3+j,den=knots[i+4-r]-knots[i],a=den?(u-knots[i])/den:0
      for(let k=0;k<5;k++)d[j][k]=d[j-1][k]*(1-a)+d[j][k]*a
    }
    return d[3]
  }
  const path=new class extends SpatialCurve<Vector3> {constructor(){super()} getPoint(t:number,target=new Vector3()){const p=splineSection(t);return target.set(p[0],p[1],p[2])}}()
  const rows=240,columns=48,positions:number[]=[],colors:number[]=[],indices:number[]=[],centres:Vector3[]=[]
  const base=new Color(tint),dark=new Color(0x4055ad),light=new Color(0x9aaaff),color=new Color(),widthAxis=new Vector3(side,0,0),depthAxis=new Vector3()
  const triangle=(a:number,b:number,c:number)=>indices.push(a,c,b)
  for(let row=0;row<=rows;row++) {
    const t=row/rows,section=splineSection(t),center=path.getPoint(t),tangent=path.getTangent(t).normalize(),baseWidth=section[3],baseDepth=section[4]
    const curvature=Math.max(...[-.5/rows,0,.5/rows].map(dt=>curlPathCurvature(path,Math.max(0,Math.min(1,t+dt)))))
    const pixelAt=175.4-center.y/UNIT,safeScale=(1+(Math.max(baseWidth,baseDepth)*curvature/.78)**6)**(-1/6)
    const width=baseWidth*safeScale,depth=baseDepth*safeScale
    widthAxis.addScaledVector(tangent,-widthAxis.dot(tangent)).normalize()
    const q=Math.max(0,Math.min(1,(t-.82)/.12)),roll=q*q*(3-2*q),widthGuide=new Vector3(side*.8,0,-.6*(1-roll))
    const diagonal=widthGuide.clone().addScaledVector(tangent,-widthGuide.dot(tangent)),turn=Math.max(0,Math.min(1,(pixelAt-225)/80))
    if(diagonal.lengthSq()>.01){diagonal.normalize();if(diagonal.dot(widthAxis)<0)diagonal.negate();widthAxis.lerp(diagonal,.16*turn*turn*(3-2*turn)).addScaledVector(tangent,-widthAxis.dot(tangent)).normalize()}
    depthAxis.crossVectors(tangent,widthAxis).normalize()
    const acrossAxis=widthAxis.clone(),aroundAxis=depthAxis.clone()
    const pole=row===0||row===rows,offset=positions.length/3
    for(let column=0;column<(pole?1:columns);column++) {
      const angle=column/columns*Math.PI*2,a=Math.cos(angle),b=Math.sin(angle),point=center.clone().addScaledVector(acrossAxis,width*a).addScaledVector(aroundAxis,depth*b)
      positions.push(point.x,point.y,point.z);centres.push(center.clone())
      const band=Math.exp(-(((a-.2)/.30)**2)),turn=Math.sin(Math.PI*t)**.5
      color.copy(base).lerp(dark,.10+.16*Math.abs(a)**1.4+.10*(1-Math.abs(b)));color.lerp(light,.44*band*Math.abs(b)*turn);colors.push(color.r,color.g,color.b)
    }
    for(let k=0;row>0&&k<columns;k++) {
      const next=(k+1)%columns
      if(row===1)triangle(0,offset+k,offset+next)
      else if(row===rows)triangle(offset-columns+k,offset,offset-columns+next)
      else {const previous=offset-columns;triangle(previous+k,offset+k,previous+next);triangle(previous+next,offset+k,offset+next)}
    }
  }
  const geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute(positions,3));geometry.setAttribute('curlSectionAnchor',new Float32BufferAttribute(centres.flatMap(p=>[p.x,p.y,p.z]),3));geometry.setAttribute('color',new Float32BufferAttribute(colors,3));geometry.setIndex(indices);geometry.computeVertexNormals()
  geometry.userData.innerBackingVolume={actualCrownRoot:true,root:root.toArray(),rows,columns,closedNormalSections:true,finiteThickness:true,noCameraInput:true}
  return geometry
}

// A rounded inner lock is swept from a bone-driven cubic control cage.
// The bind radii and colors stay fixed. Parallel slices retain axial order in every pose.
function middleJunctionMesh(crown:BufferGeometry,lower:BufferGeometry,side:number,material:MeshPhongMaterial,parent:Object3D) {
  if(!(parent instanceof Bone))throw new Error('Middle junction requires the actual back-hair bone')
  let hips:Object3D|undefined=parent
  while(hips&&hips.name!=='hips')hips=hips.parent??undefined
  if(!(hips instanceof Bone))throw new Error('Middle junction requires the actual pelvis')
  const root=new Vector3(side*.24,(175.4-224)*UNIT,0),p=crown.attributes.position,idx=crown.index!,depths:number[]=[]
  for(let t=0;t<idx.count;t+=3){
    const a=idx.getX(t),b=idx.getX(t+1),c=idx.getX(t+2),ax=p.getX(a),ay=p.getY(a),bx=p.getX(b),by=p.getY(b),cx=p.getX(c),cy=p.getY(c)
    const den=(by-cy)*(ax-cx)+(cx-bx)*(ay-cy);if(Math.abs(den)<1e-14)continue
    const u=((by-cy)*(root.x-cx)+(cx-bx)*(root.y-cy))/den,v=((cy-ay)*(root.x-cx)+(ax-cx)*(root.y-cy))/den
    if(u>=-1e-7&&v>=-1e-7&&u+v<=1+1e-7)depths.push(u*p.getZ(a)+v*p.getZ(b)+(1-u-v)*p.getZ(c))
  }
  if(depths.length<2||Math.max(...depths)-Math.min(...depths)<.00001)throw new Error('Middle junction root must be inside the actual crown')
  root.z=Math.min(...depths)+(Math.max(...depths)-Math.min(...depths))*.18
  const centres=lower.attributes.curlSectionAnchor;let nearest=0,distance=Infinity
  for(let i=0;i<centres.count;i++){const delta=Math.abs(175.4-centres.getY(i)/UNIT-338);if(delta<distance){distance=delta;nearest=i}}
  const end=new Vector3().fromBufferAttribute(centres,nearest)
  const guide=[{point:root,width:0,depth:0},
    ...[[245,.34,-.60,.035,.025],[265,.40,-.36,.050,.030],[285,.37,-.24,.075,.045],[300,.37,-.22,.080,.050],[315,.44,-.40,.050,.025]]
      .map(([y,x,z,width,depth])=>({point:new Vector3(side*x,(175.4-y)*UNIT,z),width,depth})),
    {point:end,width:0,depth:0}]
  const controls=guide.map(g=>[g.point.x,g.point.y,g.point.z,g.width,g.depth]),knots=Array.from({length:guide.length+4},(_,i)=>i<4?0:i>=guide.length?1:(i-3)/(guide.length-3))
  function section(t:number){
    const u=Math.max(0,Math.min(1,t));let span=guide.length-1
    if(u<1)for(let k=3;k<guide.length;k++)if(u>=knots[k]&&u<knots[k+1]){span=k;break}
    const d=Array.from({length:4},(_,j)=>controls[span-3+j].slice())
    for(let r=1;r<=3;r++)for(let j=3;j>=r;j--){const i=span-3+j,den=knots[i+4-r]-knots[i],a=den?(u-knots[i])/den:0;for(let k=0;k<5;k++)d[j][k]=d[j-1][k]*(1-a)+d[j][k]*a}
    return d[3]
  }
  const path=new class extends SpatialCurve<Vector3>{constructor(){super()}getPoint(t:number,target=new Vector3()){const s=section(t);return target.set(s[0],s[1],s[2])}}()
  const rows=160,columns=48,positions:number[]=[],colors:number[]=[],indices:number[]=[],anchors:number[]=[],widthAxis=new Vector3(side,0,0)
  const bindDirection=end.clone().sub(root).normalize(),bindScale:number[]=[]
  widthAxis.addScaledVector(bindDirection,-widthAxis.dot(bindDirection)).normalize()
  const bindWidth=widthAxis.clone(),bindDepth=new Vector3().crossVectors(bindDirection,bindWidth).normalize()
  const base=new Color(0x6579d5),dark=new Color(0x4055ad),light=new Color(0x9aaaff),color=new Color(),triangle=(a:number,b:number,c:number)=>indices.push(a,c,b)
  for(let row=0;row<=rows;row++){
    const t=row/rows,s=section(t),center=path.getPoint(t),safe=1
    bindScale.push(safe);const depthAxis=bindDepth
    const pole=row===0||row===rows,offset=positions.length/3
    for(let column=0;column<(pole?1:columns);column++){
      const angle=column/columns*Math.PI*2,a=Math.cos(angle),b=Math.sin(angle),point=center.clone().addScaledVector(widthAxis,s[3]*safe*a).addScaledVector(depthAxis,s[4]*safe*b)
      positions.push(point.x,point.y,point.z);anchors.push(center.x,center.y,center.z)
      color.copy(base).lerp(dark,.10+.12*Math.abs(a)**1.4+.10*(1-Math.abs(b)));color.lerp(light,.30*Math.exp(-(((a-.2)/.32)**2))*Math.abs(b));colors.push(color.r,color.g,color.b)
    }
    for(let k=0;row>0&&k<columns;k++){
      const next=(k+1)%columns
      if(row===1)triangle(0,offset+k,offset+next)
      else if(row===rows)triangle(offset-columns+k,offset,offset-columns+next)
      else{const previous=offset-columns;triangle(previous+k,offset+k,previous+next);triangle(previous+next,offset+k,offset+next)}
    }
  }
  const geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute(positions,3));geometry.setAttribute('color',new Float32BufferAttribute(colors,3));geometry.setAttribute('middleSectionAnchor',new Float32BufferAttribute(anchors,3))
  geometry.setIndex(indices);geometry.computeVertexNormals();geometry.computeBoundingSphere()
  geometry.userData.middleJunctionVolume={root:root.toArray(),end:end.toArray(),side,rows,columns,actualCrownRoot:true,actualInnerCurlEnd:true,controlCage:true,monotoneBindAxis:true,backHairThrough:230,hipsFrom:265,closedParallelSections:true,stableBindRadii:true,noCameraInput:true}
  const mesh=new Mesh(geometry,material);parent.add(mesh);mesh.updateWorldMatrix(true,false)
  const bones=[parent,hips],boundControls=controls.map(c=>c.slice()),bindTransforms=bones.map(bone=>bone.matrixWorld.clone().invert().multiply(parent.matrixWorld))
  const cageWeights=boundControls.map(c=>{const pixel=175.4-c[1]/UNIT,q=Math.max(0,Math.min(1,(pixel-230)/35)),back=1-q*q*(3-2*q);return[back,1-back]})
  const bindAxis=new Vector3().fromArray(boundControls.at(-1)!).sub(new Vector3().fromArray(boundControls[0])),bindLength=bindAxis.lengthSq()
  const bindFractions=boundControls.map(c=>new Vector3().fromArray(c).sub(new Vector3().fromArray(boundControls[0])).dot(bindAxis)/bindLength)
  for(let i=1;i<bindFractions.length;i++)if(bindFractions[i]<=bindFractions[i-1])throw new Error('Middle junction cage must have an ordered bind axis')
  mesh.userData.updateBluefishHairGeometry=()=>{
    const inverse=parent.matrixWorld.clone().invert(),transforms=bones.map((bone,i)=>inverse.clone().multiply(bone.matrixWorld).multiply(bindTransforms[i]))
    for(let i=0;i<controls.length;i++){
      const rest=new Vector3().fromArray(boundControls[i]),point=new Vector3()
      for(let k=0;k<bones.length;k++)if(cageWeights[i][k])point.addScaledVector(rest.clone().applyMatrix4(transforms[k]),cageWeights[i][k])
      for(let k=0;k<3;k++)controls[i][k]=point.getComponent(k)
    }
    // Keep valid bone-space stations unchanged; resolve only a reversed station.
    const first=new Vector3().fromArray(controls[0]),axis=new Vector3().fromArray(controls.at(-1)!).sub(first),length=axis.lengthSq(),epsilon=.001
    const raw=controls.map(c=>new Vector3().fromArray(c).sub(first).dot(axis)/length),stations=raw.map((v,i)=>Math.max(i*epsilon,Math.min(1-(controls.length-1-i)*epsilon,v)))
    for(let i=1;i<stations.length;i++)stations[i]=Math.max(stations[i],stations[i-1]+epsilon)
    stations[stations.length-1]=1
    for(let i=stations.length-2;i>=0;i--)stations[i]=Math.min(stations[i],stations[i+1]-epsilon)
    for(let i=1;i<controls.length-1;i++)for(let k=0;k<3;k++)controls[i][k]+=axis.getComponent(k)*(stations[i]-raw[i])
    const position=geometry.attributes.position;let index=0
    const direction=axis.clone().normalize(),rotationAxis=new Vector3().crossVectors(bindDirection,direction),cosine=Math.max(-1,Math.min(1,bindDirection.dot(direction))),depthAxis=bindDepth.clone()
    widthAxis.copy(bindWidth)
    if(rotationAxis.lengthSq()>1e-16){rotationAxis.normalize();const angle=Math.acos(cosine);widthAxis.applyAxisAngle(rotationAxis,angle);depthAxis.applyAxisAngle(rotationAxis,angle)}
    else if(cosine<0)depthAxis.negate()
    for(let row=0;row<=rows;row++){
      const t=row/rows,s=section(t),center=path.getPoint(t),safe=bindScale[row]
      const pole=row===0||row===rows
      for(let column=0;column<(pole?1:columns);column++){
        const angle=column/columns*Math.PI*2,point=center.clone().addScaledVector(widthAxis,s[3]*safe*Math.cos(angle)).addScaledVector(depthAxis,s[4]*safe*Math.sin(angle))
        position.setXYZ(index++,point.x,point.y,point.z)
      }
    }
    position.needsUpdate=true;geometry.computeVertexNormals();geometry.computeBoundingSphere()
  }
  mesh.name=side<0?'middle-inner-junction-left':'middle-inner-junction-right';mesh.userData.middleJunctionVolume=true
  return mesh
}

// A separate closed neck volume joins the preserved crown to the body-side tie.
// Regular normal sections avoid bending the old extrusion's cap slivers.
function neckBackingMesh(crown:BufferGeometry,material:MeshPhongMaterial,parent:Object3D) {
  if(!(parent instanceof Bone))throw new Error('Neck hair requires its actual back-hair bone')
  let spine:Object3D|undefined=parent
  while(spine&&spine.name!=='spine')spine=spine.parent??undefined
  if(!(spine instanceof Bone))throw new Error('Neck hair requires the actual spine')
  const root=new Vector3(0,(175.4-216)*UNIT,0),p=crown.attributes.position,idx=crown.index!,depths:number[]=[]
  for(let t=0;t<idx.count;t+=3) {
    const a=idx.getX(t),b=idx.getX(t+1),c=idx.getX(t+2)
    const ax=p.getX(a),ay=p.getY(a),bx=p.getX(b),by=p.getY(b),cx=p.getX(c),cy=p.getY(c)
    const den=(by-cy)*(ax-cx)+(cx-bx)*(ay-cy)
    if(Math.abs(den)<1e-14)continue
    const u=((by-cy)*(root.x-cx)+(cx-bx)*(root.y-cy))/den,v=((cy-ay)*(root.x-cx)+(ax-cx)*(root.y-cy))/den
    if(u>=-1e-7&&v>=-1e-7&&u+v<=1+1e-7)depths.push(u*p.getZ(a)+v*p.getZ(b)+(1-u-v)*p.getZ(c))
  }
  if(depths.length<2||Math.max(...depths)-Math.min(...depths)<.00001)throw new Error('Neck root must lie inside the actual crown')
  const crownDepth=[Math.min(...depths),Math.max(...depths)]
  root.z=crownDepth[0]+(crownDepth[1]-crownDepth[0])*.18
  const controls=[
    [216,0,0,root.z],[221,.22,.020,-.630],[230,.48,.040,-.640],
    [247,.50,.042,-.585],[260,.46,.040,-.540],[268,.34,.028,-.530],[276,0,0,-.530],
  ]
  const knots=Array.from({length:controls.length+4},(_,i)=>i<4?0:i>=controls.length?1:(i-3)/(controls.length-3))
  function section(t:number) {
    const u=Math.max(0,Math.min(1,t));let span=controls.length-1
    if(u<1)for(let k=3;k<controls.length;k++)if(u>=knots[k]&&u<knots[k+1]){span=k;break}
    const d=Array.from({length:4},(_,j)=>controls[span-3+j].slice())
    for(let r=1;r<=3;r++)for(let j=3;j>=r;j--){const i=span-3+j,den=knots[i+4-r]-knots[i],a=den?(u-knots[i])/den:0;for(let k=0;k<4;k++)d[j][k]=d[j-1][k]*(1-a)+d[j][k]*a}
    return d[3]
  }
  const path=new class extends SpatialCurve<Vector3> {constructor(){super()}getPoint(t:number,target=new Vector3()){const s=section(t);return target.set(0,(175.4-s[0])*UNIT,s[3])}}()
  const rows=128,columns=64,positions:number[]=[],colors:number[]=[],indices:number[]=[],centres:number[]=[],joints:number[]=[],weights:number[]=[]
  const base=new Color(0x6579d5),dark=new Color(0x4055ad),light=new Color(0x9aaaff),color=new Color()
  const triangle=(a:number,b:number,c:number)=>indices.push(a,c,b)
  for(let row=0;row<=rows;row++) {
    const t=row/rows,s=section(t),center=path.getPoint(t),tangent=path.getTangent(t).normalize(),normal=new Vector3(0,tangent.z,-tangent.y).normalize()
    const curvature=curlPathCurvature(path,t),depth=s[2]*(1+(s[2]*curvature/.65)**6)**(-1/6)
    const pole=row===0||row===rows,offset=positions.length/3,q=Math.max(0,Math.min(1,(s[0]-225)/40)),body=Math.round(q*q*(3-2*q)*16777216)/16777216
    for(let column=0;column<(pole?1:columns);column++) {
      const angle=column/columns*Math.PI*2,a=Math.cos(angle),b=Math.sin(angle),point=center.clone().add(new Vector3(s[1]*a,0,0)).addScaledVector(normal,depth*b)
      positions.push(point.x,point.y,point.z);centres.push(center.x,center.y,center.z);joints.push(0,1,0,0);weights.push(1-body,body,0,0)
      color.copy(base).lerp(dark,.10+.12*Math.abs(a)**1.4+.08*(1-Math.abs(b)));color.lerp(light,.16*Math.exp(-(((a-.18)/.42)**2))*Math.abs(b));colors.push(color.r,color.g,color.b)
    }
    for(let k=0;row>0&&k<columns;k++) {
      const next=(k+1)%columns
      if(row===1)triangle(0,offset+k,offset+next)
      else if(row===rows)triangle(offset-columns+k,offset,offset-columns+next)
      else{const previous=offset-columns;triangle(previous+k,offset+k,previous+next);triangle(previous+next,offset+k,offset+next)}
    }
  }
  const geometry=new BufferGeometry()
  geometry.setAttribute('position',new Float32BufferAttribute(positions,3));geometry.setAttribute('color',new Float32BufferAttribute(colors,3))
  geometry.setAttribute('neckSectionAnchor',new Float32BufferAttribute(centres,3));geometry.setAttribute('skinIndex',new Uint16BufferAttribute(joints,4));geometry.setAttribute('skinWeight',new Float32BufferAttribute(weights,4))
  geometry.setIndex(indices);geometry.computeVertexNormals();geometry.computeBoundingSphere()
  geometry.userData.neckBackingVolume={root:root.toArray(),crownDepth,rootDepthFraction:.18,actualCrownRoot:true,rows,columns,closedNormalSections:true,finiteThickness:true,backHairThrough:225,spineFrom:265,noCameraInput:true}
  const mesh=new SkinnedMesh(geometry,material)
  parent.add(mesh);mesh.updateWorldMatrix(true,false);mesh.bind(new Skeleton([parent,spine]))
  mesh.name='rear-neck-volume';mesh.userData.neckBackingVolume=true
  return mesh
}

// Pin the upper side roots to the actual head bone, then blend the same
// surface into the moving back-hair bone through a continuous skin.
function sideWaveRootMesh(geometry:BufferGeometry,material:MeshPhongMaterial|MeshBasicMaterial,parent:Object3D) {
  if(!(parent instanceof Bone)||!(parent.parent instanceof Bone))throw new Error('Side wave roots require the head/back-hair bones')
  const p=geometry.attributes.position,joints:number[]=[],weights:number[]=[]
  for(let i=0;i<p.count;i++) {
    const anchorY=geometry.userData.profileNormalSections?geometry.attributes.curlSectionAnchor.getY(i):p.getY(i)
    const pixel=175.4-anchorY/UNIT,t=Math.max(0,Math.min(1,(pixel-216)/84))
    const anchor=Math.round((1-t*t*(3-2*t))*16777216)/16777216
    joints.push(0,1,0,0);weights.push(anchor,1-anchor,0,0)
  }
  geometry.setAttribute('skinIndex',new Uint16BufferAttribute(joints,4))
  geometry.setAttribute('skinWeight',new Float32BufferAttribute(weights,4))
  const mesh=new SkinnedMesh(geometry,material)
  parent.add(mesh);mesh.updateWorldMatrix(true,false);mesh.bind(new Skeleton([parent.parent,parent]))
  mesh.userData.sideRootAnchor={sourceYHeldThrough:216,sourceYFreeFrom:300,headBone:parent.parent.name,movingBone:parent.name,noCameraInput:true}
  return mesh
}

function authoredSideWaveGeometry(root:Vector3,side:number,tint:number) {
  const first=175.4-root.y/UNIT,profileRoot=198-root.z/UNIT
  const u=(pixel:number)=>(pixel-198)*UNIT,y=(pixel:number)=>(175.4-pixel)*UNIT
  // One closed, curved volume follows both sides of the actual profile S.
  // Its X depth is sculpted continuously; no camera or raster is sampled.
  const shape=new Shape().moveTo(u(profileRoot),root.y)
    .bezierCurveTo(u(238),y(244),u(253),y(255),u(276),y(268))
    .bezierCurveTo(u(294),y(279),u(311),y(297),u(304),y(316))
    .bezierCurveTo(u(298),y(334),u(280),y(348),u(269),y(343))
    .bezierCurveTo(u(286),y(340),u(286),y(328),u(279),y(314))
    .bezierCurveTo(u(269),y(297),u(250),y(281),u(240),y(264))
    .bezierCurveTo(u(229),y(249),u(225),y(232),u(profileRoot),root.y)
  shape.closePath()
  const boundary=shape.getPoints(48),geometry=roundedProfileStrandSource(boundary)
  const p=geometry.attributes.position,colors:number[]=[],base=new Color(tint),dark=new Color(0x4055ad),light=new Color(0x9aaaff),color=new Color()
  const controls=[[first,Math.abs(root.x)],[240,.680],[260,.740],[280,.780],[300,.780],[320,.730],[345,.690]]
  const centre=(pixel:number)=>{
    const j=Math.max(1,controls.findIndex(([at])=>at>=pixel)),a=controls[j-1],b=controls[j]
    if(pixel>=345)return .690
    const t=Math.max(0,Math.min(1,(pixel-a[0])/(b[0]-a[0])))
    const seat=Math.max(0,Math.min(1,(pixel-first)/(232-first)))
    return a[1]+(b[1]-a[1])*t*t*(3-2*t)-.14*(1-seat*seat*(3-2*seat))
  }
  for(let i=0;i<p.count;i++) {
    const pu=p.getX(i),py=p.getY(i),face=p.getZ(i)/.045,pixel=175.4-py/UNIT
    let distance=Infinity;const hits:number[]=[]
    for(let j=1;j<boundary.length;j++) {
      const a=boundary[j-1],b=boundary[j],du=b.x-a.x,dy=b.y-a.y
      const t=Math.max(0,Math.min(1,((pu-a.x)*du+(py-a.y)*dy)/(du*du+dy*dy||1)))
      distance=Math.min(distance,Math.hypot(pu-a.x-t*du,py-a.y-t*dy))
      if((a.y>py)!==(b.y>py))hits.push(a.x+du*(py-a.y)/dy)
    }
    hits.sort((a,b)=>a-b);let across=0
    for(let j=1;j<hits.length;j+=2)if(pu>=hits[j-1]-1e-6&&pu<=hits[j]+1e-6) {
      across=Math.max(-1,Math.min(1,(2*pu-hits[j]-hits[j-1])/(hits[j]-hits[j-1]||1)));break
    }
    const dome=Math.sin(Math.min(1,distance/.080)*Math.PI/2),fall=Math.max(0,Math.min(1,(pixel-first)/18))
    const depth=.003+.045*dome*fall*fall*(3-2*fall)
    const bend=.018*across*Math.sin(Math.PI*Math.max(0,Math.min(1,(pixel-first)/(345-first))))
    p.setXYZ(i,side*(centre(pixel)+bend+(2*face-1)*depth),py,-pu)
    const edge=Math.exp(-distance/.018),band=Math.exp(-(((across+.05)/.42)**2))
    color.copy(base).lerp(dark,.37*edge+.10*(1-face))
    color.lerp(light,.32*band*face*Math.sin(Math.PI*Math.max(0,Math.min(1,(pixel-first)/(345-first))))**.5)
    colors.push(color.r,color.g,color.b)
  }
  if(side<0){const indices=geometry.index!;for(let i=0;i<indices.count;i+=3){const b=indices.getX(i+1);indices.setX(i+1,indices.getX(i+2));indices.setX(i+2,b)}}
  geometry.setAttribute('color',new Float32BufferAttribute(colors,3));geometry.computeVertexNormals()
  geometry.userData.authoredProfileWave={sourceStart:[246,194],sourceRoot:root.toArray(),profileTip:[269,343],curvedDepth:true,minimumHalfDepth:.003,maximumHalfDepth:.048,noCameraInput:true,imageTexture:false,revision:14}
  geometry.userData.authoredProfileOutline=boundary.slice(0,-1).filter(point=>175.4-point.y/UNIT>=226).map(point=>{
    const pixel=175.4-point.y/UNIT
    return [side*(centre(pixel)+.003),point.y,-point.x]
  })
  return geometry
}

function guidedShoulderCompanionGeometry(source:BufferGeometry,side:number,tint:number) {
  const p=source.attributes.position,guide=[{point:new Vector3().fromBufferAttribute(p,0),width:0,depth:0}]
  for(const[y,x,z,width,depth]of[
    [240,.665,-.340,.038,.020],[260,.725,-.510,.052,.023],
    [280,.805,-.680,.062,.025],[300,.815,-.720,.062,.025],
    [317,.770,-.680,.052,.024],[331,.690,-.590,.036,.021],
    [337,.635,-.505,.014,.010],[333,.615,-.475,0,0],
  ])guide.push({point:new Vector3(side*x,(175.4-y)*UNIT,z),width,depth})
  const splineControls=guide.map(g=>[g.point.x,g.point.y,g.point.z,g.width,g.depth]),knots=Array.from({length:guide.length+4},(_,i)=>i<4?0:i>=guide.length?1:(i-3)/(guide.length-3))
  function splineSection(t:number) {
    const u=Math.max(0,Math.min(1,t));let span=guide.length-1
    if(u<1)for(let k=3;k<guide.length;k++)if(u>=knots[k]&&u<knots[k+1]){span=k;break}
    const d=Array.from({length:4},(_,j)=>splineControls[span-3+j].slice())
    for(let r=1;r<=3;r++)for(let j=3;j>=r;j--) {
      const i=span-3+j,den=knots[i+4-r]-knots[i],a=den?(u-knots[i])/den:0
      for(let k=0;k<5;k++)d[j][k]=d[j-1][k]*(1-a)+d[j][k]*a
    }
    return d[3]
  }
  const path=new class extends SpatialCurve<Vector3> {constructor(){super()} getPoint(t:number,target=new Vector3()){const p=splineSection(t);return target.set(p[0],p[1],p[2])}}()
  const rows=180,columns=40,positions:number[]=[],colors:number[]=[],indices:number[]=[],centres:Vector3[]=[]
  const base=new Color(tint),dark=new Color(0x4055ad),light=new Color(0x9aaaff),color=new Color(),widthAxis=new Vector3(side,0,0),depthAxis=new Vector3()
  const triangle=(a:number,b:number,c:number)=>indices.push(a,c,b)
  for(let row=0;row<=rows;row++) {
    const t=row/rows,section=splineSection(t),center=path.getPoint(t),tangent=path.getTangent(t).normalize(),baseWidth=section[3],baseDepth=section[4]
    const curvature=Math.max(...[-.5/rows,0,.5/rows].map(dt=>curlPathCurvature(path,Math.max(0,Math.min(1,t+dt)))))
    const pixelAt=175.4-center.y/UNIT,safeScale=(1+(Math.max(baseWidth,baseDepth)*curvature/.70)**6)**(-1/6)
    const width=baseWidth*safeScale,depth=baseDepth*safeScale
    widthAxis.addScaledVector(tangent,-widthAxis.dot(tangent)).normalize()
    const q=Math.max(0,Math.min(1,(t-.80)/.18)),roll=q*q*(3-2*q),widthGuide=new Vector3(side*.8,0,-side*.6*(1-roll))
    const diagonal=widthGuide.clone().addScaledVector(tangent,-widthGuide.dot(tangent)),turn=Math.max(0,Math.min(1,(pixelAt-225)/80))
    if(diagonal.lengthSq()>.01){diagonal.normalize();if(diagonal.dot(widthAxis)<0)diagonal.negate();widthAxis.lerp(diagonal,.16*turn*turn*(3-2*turn)).addScaledVector(tangent,-widthAxis.dot(tangent)).normalize()}
    depthAxis.crossVectors(tangent,widthAxis).normalize()
    const acrossAxis=widthAxis.clone(),aroundAxis=depthAxis.clone()
    const pole=row===0||row===rows,offset=positions.length/3
    for(let column=0;column<(pole?1:columns);column++) {
      const angle=column/columns*Math.PI*2,a=Math.cos(angle),b=Math.sin(angle),point=center.clone().addScaledVector(acrossAxis,width*a).addScaledVector(aroundAxis,depth*b)
      positions.push(point.x,point.y,point.z);centres.push(center.clone())
      const band=Math.exp(-(((a-.2)/.30)**2)),turn=Math.sin(Math.PI*t)**.5
      color.copy(base).lerp(dark,.10+.16*Math.abs(a)**1.4+.10*(1-Math.abs(b)));color.lerp(light,.44*band*Math.abs(b)*turn);colors.push(color.r,color.g,color.b)
    }
    for(let k=0;row>0&&k<columns;k++) {
      const next=(k+1)%columns
      if(row===1)triangle(0,offset+k,offset+next)
      else if(row===rows)triangle(offset-columns+k,offset,offset-columns+next)
      else {const previous=offset-columns;triangle(previous+k,offset+k,previous+next);triangle(previous+next,offset+k,offset+next)}
    }
  }
  const geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute(positions,3));geometry.setAttribute('curlSectionAnchor',new Float32BufferAttribute(centres.flatMap(p=>[p.x,p.y,p.z]),3));geometry.setAttribute('color',new Float32BufferAttribute(colors,3));geometry.setIndex(indices);geometry.computeVertexNormals()
  geometry.userData.normalPlaneCompanion={sourceStart:[231,223],rows,columns,finiteNormalFrame:true,closed:true}
  geometry.userData.finiteShoulderCompanion={sourceSpace:'fixedXYZ',rootOriginal:true,returnTipRebuilt:true,noCameraInput:true}
  return geometry
}

function guidedInnerReturnGeometry(side:number,tint:number,main?:BufferGeometry) {
  const controls=[
    [335,.55,-.38,0,0],[345,side>0?.55:.59,side>0?-.42:-.44,side>0?.045:.055,.025],
    [365,side>0?.59:.67,side>0?-.48:-.51,.065,.025],
    [385,side>0?.61:.75,side>0?-.54:-.56,side>0?.067:.065,.025],
    [397,side>0?.59:.73,side>0?-.52:-.55,side>0?.050:.052,side>0?.022:.024],
    [406,side>0?.56:.68,side>0?-.48:-.50,.024,.014],
    [400,side>0?.54:.65,-.47,0,0],
  ]
  if(main) {
    const anchors=main.getAttribute('curlSectionAnchor'),centres:Vector3[]=[]
    for(let i=0;i<anchors.count;i++) {
      const point=new Vector3().fromBufferAttribute(anchors,i)
      if(!centres.length||point.distanceToSquared(centres[centres.length-1])>1e-14)centres.push(point)
    }
    const at=(pixel:number)=>{
      const y=(175.4-pixel)*UNIT
      const j=centres.findIndex((p,i)=>i>0&&centres[i-1].y>=y&&p.y<=y)
      if(j<1)throw new Error('Main curl has no descending centre section at '+pixel)
      const a=centres[j-1],b=centres[j],t=(y-a.y)/(b.y-a.y)
      return a.clone().lerp(b,t)
    }
    controls.length=0
    for(const[pixel,width,depth]of[[335,0,0],[345,.040,.014],[365,.045,.016],[385,.035,.014],[397,.020,.010],[406,0,0]]) {
      const center=at(pixel),t=(pixel-335)/(406-335)
      // Both ends join the actual primary volume. The small forward
      // offset exposes the companion ridge without a free hook.
      controls.push([pixel,Math.abs(center.x),center.z+.028*Math.sin(Math.PI*t),width,depth])
    }
  }
  const guide=controls.map(([y,x,z,width,depth])=>({point:new Vector3(side*x,(175.4-y)*UNIT,z),width,depth}))
  const splineControls=guide.map(g=>[g.point.x,g.point.y,g.point.z,g.width,g.depth]),knots=Array.from({length:guide.length+4},(_,i)=>i<4?0:i>=guide.length?1:(i-3)/(guide.length-3))
  function splineSection(t:number) {
    const u=Math.max(0,Math.min(1,t));let span=guide.length-1
    if(u<1)for(let k=3;k<guide.length;k++)if(u>=knots[k]&&u<knots[k+1]){span=k;break}
    const d=Array.from({length:4},(_,j)=>splineControls[span-3+j].slice())
    for(let r=1;r<=3;r++)for(let j=3;j>=r;j--) {
      const i=span-3+j,den=knots[i+4-r]-knots[i],a=den?(u-knots[i])/den:0
      for(let k=0;k<5;k++)d[j][k]=d[j-1][k]*(1-a)+d[j][k]*a
    }
    return d[3]
  }
  const path=new class extends SpatialCurve<Vector3> {constructor(){super()} getPoint(t:number,target=new Vector3()){const p=splineSection(t);return target.set(p[0],p[1],p[2])}}()
  const rows=180,columns=40,positions:number[]=[],colors:number[]=[],indices:number[]=[],centres:Vector3[]=[]
  const base=new Color(tint),dark=new Color(0x4055ad),light=new Color(0x9aaaff),color=new Color(),widthAxis=new Vector3(side,0,0),depthAxis=new Vector3()
  const triangle=(a:number,b:number,c:number)=>indices.push(a,c,b)
  for(let row=0;row<=rows;row++) {
    const t=row/rows,section=splineSection(t),center=path.getPoint(t),tangent=path.getTangent(t).normalize(),baseWidth=section[3],baseDepth=section[4]
    const curvature=Math.max(...[-.5/rows,0,.5/rows].map(dt=>curlPathCurvature(path,Math.max(0,Math.min(1,t+dt)))))
    const pixelAt=175.4-center.y/UNIT,fade=Math.max(0,Math.min(1,(pixelAt-300)/20)),safeScale=(1+(Math.max(baseWidth,baseDepth)*curvature/.72)**6)**(-1/6)
    const scale=1-(1-safeScale)*fade*fade*(3-2*fade),width=baseWidth*scale,depth=baseDepth*scale
    widthAxis.addScaledVector(tangent,-widthAxis.dot(tangent)).normalize();depthAxis.crossVectors(tangent,widthAxis).normalize()
    const pixel=175.4-center.y/UNIT,v=Math.max(0,Math.min(1,(pixel-280)/40)),blend=v*v*(3-2*v)
    const acrossAxis=new Vector3(side,0,0).lerp(widthAxis,blend),aroundAxis=new Vector3(0,0,side).lerp(depthAxis,blend)
    const pole=row===0||row===rows,offset=positions.length/3
    for(let column=0;column<(pole?1:columns);column++) {
      const angle=column/columns*Math.PI*2,a=Math.cos(angle),b=Math.sin(angle),point=center.clone().addScaledVector(acrossAxis,width*a).addScaledVector(aroundAxis,depth*b)
      positions.push(point.x,point.y,point.z);centres.push(center.clone())
      const band=Math.exp(-(((a-.2)/.30)**2)),turn=Math.sin(Math.PI*t)**.5
      color.copy(base).lerp(dark,.10+.16*Math.abs(a)**1.4+.10*(1-Math.abs(b)));color.lerp(light,.44*band*Math.abs(b)*turn);colors.push(color.r,color.g,color.b)
    }
    for(let k=0;row>0&&k<columns;k++) {
      const next=(k+1)%columns
      if(row===1)triangle(0,offset+k,offset+next)
      else if(row===rows)triangle(offset-columns+k,offset,offset-columns+next)
      else {const previous=offset-columns;triangle(previous+k,offset+k,previous+next);triangle(previous+next,offset+k,offset+next)}
    }
  }
  const geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute(positions,3));geometry.setAttribute('curlSectionAnchor',new Float32BufferAttribute(centres.flatMap(p=>[p.x,p.y,p.z]),3));geometry.setAttribute('color',new Float32BufferAttribute(colors,3));geometry.setIndex(indices);geometry.computeVertexNormals()
  geometry.userData.continuousS={innerReturn:true,sourceRoot:335,lowerReturnGuides:main?6:7,rows,columns,parallelTransportFrame:true,continuouslyTapered:true}
  geometry.userData.finiteInnerJunction={method:main?'inner ridge attached to actual primary centre sections335..406':'legacy lower companion',widthHalfMax:main?.045:.075,depthHalfMax:main?.016:.025,sourceSide:side,noCameraInput:true,attachedToActualMain:!!main,lowerReturnRevision:31}
  return geometry
}

// A regular closed lens follows the actual authoring contour. The old
// extrusion's thin Earcut triangles folded under the strong lower tuck.
function roundedProfileStrandSource(boundary:readonly {x:number;y:number}[]) {
  let top=-Infinity,bottom=Infinity
  for(const p of boundary){top=Math.max(top,p.y);bottom=Math.min(bottom,p.y)}
  const rows=192,columns=48,positions:number[]=[],indices:number[]=[]
  const triangle=(a:number,b:number,c:number)=>indices.push(a,c,b)
  for(let row=0;row<=rows;row++){
    const t=row/rows,y=top+(bottom-top)*t,sampleY=Math.max(bottom+.0000001,Math.min(top-.0000001,y)),hits:number[]=[]
    for(let j=1;j<boundary.length;j++){
      const a=boundary[j-1],b=boundary[j]
      if((a.y>sampleY)!==(b.y>sampleY))hits.push(a.x+(b.x-a.x)*(sampleY-a.y)/(b.y-a.y))
    }
    hits.sort((a,b)=>a-b)
    if(hits.length!==2)throw new Error('Returning strand requires one closed interval per authoring row')
    const center=(hits[0]+hits[1])/2,pole=row===0||row===rows,width=pole?0:(hits[1]-hits[0])/2
    const end=Math.max(0,Math.min(1,Math.min(top-y,y-bottom)/(.0056*6))),round=Math.sqrt(end*(2-end)),offset=positions.length/3
    for(let column=0;column<(pole?1:columns);column++){
      const phase=column/columns*Math.PI*2
      const angle=Math.atan2(.35*Math.sin(phase),Math.cos(phase))
      positions.push(center+width*Math.cos(angle),y,.045*(.5+.5*round*Math.sin(angle)))
    }
    if(row>0)for(let k=0;k<columns;k++){
      const next=(k+1)%columns
      if(row===1)triangle(0,offset+k,offset+next)
      else if(row===rows)triangle(offset-columns+k,offset,offset-columns+next)
      else{const previous=offset-columns;triangle(previous+k,offset+k,previous+next);triangle(previous+next,offset+k,offset+next)}
    }
  }
  const geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute(positions,3));geometry.setIndex(indices)
  geometry.userData.roundedProfileSource={rows,columns,regularClosedLens:true,authoringBoundaryIntervals:1}
  return geometry
}

function curlPathCurvature(path:SpatialCurve<Vector3>,t:number) {
  const a=path.getPoint(Math.max(0,t-.002)),b=path.getPoint(t),c=path.getPoint(Math.min(1,t+.002)),ab=b.clone().sub(a),ac=c.clone().sub(a),bc=c.clone().sub(b)
  const denominator=ab.length()*ac.length()*bc.length()
  return denominator>1e-15?2*ab.cross(ac).length()/denominator:0
}

// Transfer the existing fin-clearance motion as rigid section translation.
// Keep its root anchor, and smooth only the displacement along the strand.
function preserveSettlementSections(geometry:BufferGeometry,target:BufferGeometry) {
  const anchors=geometry.getAttribute('curlSectionAnchor'),p=geometry.attributes.position,t=target.attributes.position
  if(!anchors)return
  const map=new Map<string,{ids:number[],delta:Vector3}>()
  for(let i=0;i<p.count;i++) {
    const key=anchors.getX(i)+':'+anchors.getY(i)+':'+anchors.getZ(i)
    if(!map.has(key))map.set(key,{ids:[],delta:new Vector3()})
    const group=map.get(key)!;group.ids.push(i);group.delta.add(new Vector3(t.getX(i)-p.getX(i),t.getY(i)-p.getY(i),t.getZ(i)-p.getZ(i)))
  }
  const groups=[...map.values()];for(const group of groups)group.delta.divideScalar(group.ids.length)
  for(let pass=0;pass<3;pass++) {
    const next=groups.map(g=>g.delta.clone())
    for(let i=1;i<groups.length-1;i++)next[i].copy(groups[i-1].delta).multiplyScalar(.25).addScaledVector(groups[i].delta,.5).addScaledVector(groups[i+1].delta,.25)
    groups.forEach((g,i)=>g.delta.copy(next[i]))
  }
  let maxWithinSectionChange=0
  for(const group of groups)for(const i of group.ids) {
    const x=p.getX(i)+group.delta.x,y=p.getY(i)+group.delta.y,z=p.getZ(i)+group.delta.z
    maxWithinSectionChange=Math.max(maxWithinSectionChange,Math.hypot(x-t.getX(i),y-t.getY(i),z-t.getZ(i)))
    t.setXYZ(i,x,y,z)
  }
  target.computeVertexNormals();geometry.userData.sectionSettlement={method:'mean original barycentric displacement per actual3D ring, three adjacent-ring smoothing passes, endpoint anchors retained',maxWithinSectionChange}
}

// The crown and its overlying locks share one monotone height profile. The
// pole must remain above the surrounding rings instead of forming a dimple.
export function bluefishCrownLift(y: number, radius: number, rear: number) {
  const t = Math.max(0, Math.min(1, (y - .40) / .169))
  // This fixed upper crown surface is shared by the scalp and its locks.
  // Signed rear preserves the forehead and reaches the common pole smoothly.
  const direction = Math.max(-1, Math.min(1, rear))
  const x = .465 * radius * Math.sqrt(Math.max(0, 1 - direction * direction))
  const z = -.139 - (.437 + .065 * Math.max(0, direction)) * radius * direction
  const smooth = (v: number, lo: number, hi: number) => {
    const q = Math.max(0, Math.min(1, (v - lo) / (hi - lo)))
    return q * q * (3 - 2 * q)
  }
  const raised = 0.06 * smooth(y, .38, .55) * smooth(-z, .055, .16) * (1 - smooth(x, .26, .43))
  return .021 * t * t * (3 - 2 * t) + raised
}

export function bluefishCrownInset(x: number, y: number, z: number) {
  const smooth = (v: number, lo: number, hi: number) => {
    const q = Math.max(0, Math.min(1, (v - lo) / (hi - lo)))
    return q * q * (3 - 2 * q)
  }
  return .025 * smooth(y, .46, .59) * smooth(-z, .23, .38) * (1 - smooth(Math.abs(x), .25, .43))
}

export function bluefishCrownRadius(y: number) {
  const height = Math.abs((y - .15) / .419)
  return Math.sqrt(Math.max(0, 1 - height ** (y > .15 ? 3.4 : 2)))
}

// Shape the indentation above the lower hook and gather the last tips.
// The same cross-section applies to the side locks, back locks and joins.
function lowerLockWidth(x: number, y: number) {
  const pixel = 175.4 - y / UNIT
  const edge = Math.max(0, Math.min(1, (Math.abs(x) - .57) / .30))
  const fold = .085 * Math.exp(-(((pixel - 334) / 6.2) ** 2))
  const down = Math.max(0, Math.min(1, (pixel - 387) / 9))
  const end = Math.max(0, Math.min(1, (414 - pixel) / 8))
  const tips = .071 * down * down * (3 - 2 * down) * end * end * (3 - 2 * end)
  return x - Math.sign(x) * edge * edge * (3 - 2 * edge) * (fold + tips)
}

function drapeAroundDress(x: number, y: number, z: number) {
  const band = Math.exp(-(((y + .651) / .218) ** 4))
  const inward = Math.max(0, Math.min(1, (.448 - Math.abs(x)) / .174))
  const outer = Math.max(0, Math.min(1, (Math.abs(x) - .245) / .224))
  const gather = band * inward * inward * (3 - 2 * inward)
  const frontCurl = .184 * band * outer * outer * (3 - 2 * outer) * Math.exp(-(((z + .248) / .167) ** 2))
  const hem = Math.exp(-(((y + 1.093) / .158) ** 4))
  const hemCurl = .101 * hem * outer * outer * (3 - 2 * outer) * Math.exp(-(((z + .265) / .177) ** 2))
  const lowerPart = .085 * Math.tanh(x / .20) * Math.exp(-(((y + 1.013) / .147) ** 4)
    - (((z + .64) / .255) ** 4) - (((Math.abs(x) - .387) / .23) ** 4))
  const loosen = .061 * band * Math.tanh(x / .11) * Math.exp(-(((Math.abs(x) - .294) / .147) ** 4))
  // Pull the gathered roots against the back as the outer locks pass
  // behind the apron tie. Keep the tie visible through the side part.
  const held = gather * Math.max(0, Math.min(1, (-.262 - z) / .132))
  // Leave the two surfaces of the gathered lock separated at the waist.
  return new Vector3(x * (1 - .40 * held) + loosen * (1 - held) ** 2 + lowerPart,
    y, z + Math.max(0, -.220 - z) * .994 * gather - frontCurl - hemCurl)
}

function upperBackFlow(y: number) {
  const pixel=175.4-y/UNIT
  return .100*Math.exp(-(((pixel-210)/28)**2))
}

function lowerFinSeat(y: number, z: number) {
  return .070 * Math.exp(-(((y + .177) / .048) ** 4) - (((z + .281) / .076) ** 4))
}

// Shape the inner mass to leave clear space inside the outer curls.
function tuckBehindUpperCurls(point: Vector3, outerRear = false, profileSurface = false) {
  const pixel = 175.4 - point.y / UNIT
  const sideWindow = Math.exp(-(((pixel - 241) / 17) ** 6))
  const sideEdge = .544 + .0014 * (pixel - 228)
  const sideExcess = Math.max(0, Math.abs(point.x) - sideEdge)
  const sideInset = sideExcess - .065 * Math.tanh(sideExcess / .065)
  point.x -= Math.sign(point.x) * sideInset * sideWindow
  const rearWindow = profileSurface || outerRear ? 0 : Math.exp(-(((pixel - 211) / 13) ** 6))
  const rearEdge = .635 + .0012 * (pixel - 204)
  const rearExcess = Math.max(0, -point.z - rearEdge)
  const rearInset = rearExcess - .062 * Math.tanh(rearExcess / .062)
  point.z += rearInset * rearWindow
  const middleWindow = Math.exp(-(((pixel - 264) / 13) ** 6))
  const middleEdge = .750 + .0011 * (pixel - 256)
  const middleExcess = Math.max(0, -point.z - middleEdge)
  point.z += (middleExcess - .043 * Math.tanh(middleExcess / .043)) * middleWindow
  return point
}

// The outer waist, hook and hem locks return into the inner mass.
function tuckBehindLowerCurls(point: Vector3) {
  const pixel = 175.4 - point.y / UNIT
  const waist = Math.exp(-(((pixel - 308) / 22) ** 4))
  const hook = Math.exp(-(((pixel - 338) / 10) ** 4))
  const hem = Math.exp(-(((pixel - 377) / 19) ** 4))
  const edge = .690 + .006 * waist + .030 * hook - .007 * hem
  const radius = .058 + .005 * hem + .010 * hook
  const excess = Math.max(0, Math.abs(point.x) - edge)
  point.x -= Math.sign(point.x) * (excess - radius * Math.tanh(excess / radius)) * Math.max(waist, hook, hem)
  return point
}

function gatherHemTips(point: Vector3, lateralShare = .46) {
  const pixel = 175.4 - point.y / UNIT
  const fall = Math.max(0, Math.min(1, (pixel - 361) / 54))
  const limit = .822 + .615 * (1 - fall) ** 1.65
  const excess = Math.max(0, Math.abs(point.x) - point.z - limit)
  const seat = Math.min(1, fall * 3)
  // Retain the thickness of the stacked locks through the inward turn.
  const inset = .88 * (excess - .026 * Math.tanh(excess / .026)) * seat * seat * (3 - 2 * seat)
  // The lining curves inward and forward beneath the petticoat.
  point.x -= Math.sign(point.x) * inset * lateralShare
  point.z += inset * (1 - lateralShare)
  return point
}

function sideSection(height: number) {
  const pixel = 175.4 - height / UNIT
  const found = SIDE_SECTIONS.findIndex(([y]) => y > pixel)
  const index = found < 0 ? SIDE_SECTIONS.length - 1 : Math.max(1, found)
  const before = SIDE_SECTIONS[Math.max(0, index - 2)], top = SIDE_SECTIONS[index - 1]
  const bottom = SIDE_SECTIONS[index], after = SIDE_SECTIONS[Math.min(SIDE_SECTIONS.length - 1, index + 1)]
  const span = bottom[0] - top[0]
  const v = Math.max(0, Math.min(1, (pixel - top[0]) / span))
  const u = v * v * (3 - 2 * v)
  const section = (component: 1 | 2) => {
    const middle = (bottom[component] - top[component]) / span
    const first = (top[component] - before[component]) / (top[0] - before[0] || 1)
    const last = (after[component] - bottom[component]) / (after[0] - bottom[0] || 1)
    const slope = monotoneSlope(first, middle) * (1 - v) - monotoneSlope(middle, last) * v
    return top[component] + (bottom[component] - top[component]) * u + span * v * (1 - v) * slope
  }
  return { radius: section(1), axis: section(2) }
}

type CheekSections = typeof TEMPLE_CURL | typeof JAW_CURL

function cheekSection(sections: CheekSections, pixel: number) {
  const upper = sections.findIndex(([height], index) => index > 0 && height >= pixel)
  const index = upper < 0 ? sections.length - 1 : upper
  const a = sections[index - 1], b = sections[index]
  const before = sections[Math.max(0, index - 2)], after = sections[Math.min(sections.length - 1, index + 1)]
  const span = b[0] - a[0], u = (pixel - a[0]) / span
  const sample = (axis: 1 | 2 | 3 | 4) => {
    const slope = (b[axis] - a[axis]) / span
    let start = monotoneSlope((a[axis] - before[axis]) / (a[0] - before[0] || 1), slope)
    let end = monotoneSlope(slope, (after[axis] - b[axis]) / (after[0] - b[0] || 1))
    // The profile tip is a real spatial crease on the closed lock.
    // The frontal return stays smooth as it turns into this pointed edge.
    const point = sections === TEMPLE_CURL && axis === 3 ? 201.3 : undefined
    if (a[0] === point) start = slope
    if (b[0] === point) end = slope
    return a[axis] + (b[axis] - a[axis]) * u * u * (3 - 2 * u)
      + span * u * (1 - u) * (start * (1 - u) - end * u)
  }
  const outer = (257 - sample(1)) * UNIT, inner = (257 - sample(2)) * UNIT
  const front = (198 - sample(3)) * UNIT - .01, back = (198 - sample(4)) * UNIT - .01
  // Start the turn high on the lock, then ease it back toward the jaw.
  // Rolling the cross-section keeps the front and side widths fitted.
  const turn = sections === TEMPLE_CURL ? .60 - .98 * Math.exp(-(((pixel - 187) / 15) ** 4))
    : .48 - 1.35 * Math.exp(-(((pixel - 206) / 14) ** 4))
  const cross = Math.sqrt(1-turn*turn)
  const dualPower = 2/(2-CHEEK_ROUNDNESS)
  const support = (Math.abs(turn)**dualPower+cross**dualPower)**(1/dualPower)
  return { x: (outer + inner) / 2, z: (front + back) / 2, width: (outer - inner) / 2,
    depth: (front - back) / 2, turn, cross, support }
}

function cheekGeometry(side: number, sections: CheekSections) {
  const temple = sections === TEMPLE_CURL
  const [first] = sections[0], [last] = sections[sections.length - 1]
  const tips = temple ? [198.5,199.3,200,201.3,202.5] : []
  const regular = Array.from({length:77},(_,i)=>first+(last-first)*i/76)
  const ringPixels = [...regular.filter(pixel=>tips.every(tip=>Math.abs(pixel-tip)>.04)),...tips].sort((a,b)=>a-b)
  const rings = ringPixels.length-1, segments = 48
  const positions: number[] = [], colors: number[] = [], flowChart: number[] = [], indices: number[] = []
  const hair = new Color(temple ? 0x697bdf : 0x6e7ee3), shadow = new Color(0x5061bc), sheen = new Color(0x929eef)
  const pigment = new Color()
  const triangle = side > 0
    ? (a: number, b: number, c: number) => indices.push(a, b, c)
    : (a: number, b: number, c: number) => indices.push(a, c, b)
  for (let row = 0; row <= rings; row++) {
    const pixel = temple ? ringPixels[row] : first+(last-first)*(row/rings)
    const t = temple ? (pixel-first)/(last-first) : row/rings
    const section = cheekSection(sections, pixel)
    const above = !temple && pixel < TEMPLE_CURL[TEMPLE_CURL.length - 1][0] ? cheekSection(TEMPLE_CURL, pixel) : undefined
    const sweep = Math.sin(Math.PI * t) ** 1.4
    const pole = row === 0 || row === rings
    const offset = positions.length / 3
    for (let segment = 0; segment < (pole ? 1 : segments); segment++) {
      const angle = segment / segments * Math.PI * 2
      // A softly flattened section gives the lock a broad face and rolled
      // edges. Normalize its support to retain the authored profile depth.
      const across = Math.sign(Math.cos(angle))*Math.abs(Math.cos(angle))**CHEEK_ROUNDNESS
      const around = Math.sign(Math.sin(angle))*Math.abs(Math.sin(angle))**CHEEK_ROUNDNESS
      const x = section.x + section.width * across
      let z = section.z + section.depth * (-section.turn * across + section.cross * around)/section.support
      if (temple && pixel>191) {
        const y = (175.4-pixel)*UNIT
        const skinDepth = bluefishFaceClearanceDepth(side*x,y)
        if (skinDepth!==undefined) {
          const frontAround = Math.max(0,1-Math.abs(across)**(2/CHEEK_ROUNDNESS))**(CHEEK_ROUNDNESS/2)
          const front = section.z+section.depth*(-section.turn*across+section.cross*frontAround)/section.support
          const fall = Math.max(0,Math.min(1,(pixel-191)/5))
          const clearance = Math.max(0,skinDepth+.008-front)
          // Translate both sides of each section together. The tapered
          // tip clears the cheek without collapsing its closed volume.
          z += clearance*fall*fall*(3-2*fall)
        }
      }
      positions.push(side * x, (175.4 - pixel) * UNIT, z)
      flowChart.push(t,Math.cos(angle),Math.sin(angle),Math.max(.004,(section.width+section.depth)*.5))
      const flow = angle - .47 * Math.sin(Math.PI * (t - .13))
      const profileX = 198 - (z + .01) / UNIT
      const sideFacing = Math.max(0, across) ** .75
      const hookLight = Math.exp(-(((profileX - (temple ? 185 : 189)) / 7) ** 2)
        - (((pixel - (temple ? 198 : 214)) / 6) ** 2)) * sideFacing
      const shine = .33 * (.5 + .5 * Math.cos(flow - .68)) ** 9 * sweep + .26 * hookLight
      const strand = .18 * Math.exp(-(((flow - .28) / .126) ** 2)) * sweep
      const undercurl = .08 * (.5 - .5 * Math.cos(angle - .82)) ** 2 + .06 * t ** 4
      const fold = Math.max(0, Math.min(1, (pixel - 199) / 23))
      const foldShadow = temple ? .58 * Math.exp(-(((pixel - 174) / 2.9) ** 2) - (((profileX - 198) / 9) ** 4))
        : .43 * Math.exp(-(((profileX - (215 - 20 * fold ** 1.58)) / 2.8) ** 2)) * Math.sin(Math.PI * fold) ** .70
      let contact = 0
      if (above && above.width > .004 && above.depth > .004) {
        // Measure from the actual upper curl, so the shadow follows the
        // meeting edge as the lock turns and falls away near the tip.
        const dx = (x - above.x) / above.width
        const dz = ((z-above.z)/above.depth*above.support+above.turn*dx)/above.cross
        const power = 2/CHEEK_ROUNDNESS
        const clearance = Math.max(0,(Math.abs(dx)**power+Math.abs(dz)**power)**(1/power)-1)
        contact = .43 * Math.exp(-((clearance / .20) ** 2)) * Math.min(1, above.width / .032) * sweep
      }
      const shade = undercurl + strand + contact + foldShadow * sideFacing + (side>0?.06*sweep:0)
      pigment.copy(hair).lerp(shadow, Math.min(1, shade)).lerp(sheen, shine * (1 - contact))
      colors.push(pigment.r, pigment.g, pigment.b)
    }
    for (let segment = 0; row > 0 && segment < segments; segment++) {
      const next = (segment + 1) % segments
      if (row === 1) triangle(0, offset + next, offset + segment)
      else if (row === rings) triangle(offset - segments + segment, offset - segments + next, offset)
      else {
        const previous = offset - segments
        // Mirror the cap diagonals around the section. Both sides then
        // interpolate the same X/Y grid as they bend around the cheek;
        // mismatched diagonals can cross where the hair thins near skin.
        if(segment<segments/2){
          triangle(previous + segment, previous + next, offset + segment)
          triangle(previous + next, offset + next, offset + segment)
        }else{
          triangle(previous + segment, previous + next, offset + next)
          triangle(previous + segment, offset + next, offset + segment)
        }
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  geometry.setAttribute('curlFlow',new Float32BufferAttribute(flowChart,4))
  geometry.computeVertexNormals()
  return geometry
}


// The rear authoring contours are the reference rails. Give their lower
// surfaces a fixed spatial depth and finite thickness along the actual
// mid-surface normal; do not gather/flatten them through old view fields.

// Improve only lower authoring-chart cap diagonals. No vertex, boundary,
// upper crown triangle or skin weight moves. Convex quality-increasing flips
// remove nearly-collinear cap slivers before the fixed 3D chart is bent.
function retessellateRearChart(g:BufferGeometry){
  const p=g.attributes.position,q=g.index!,indices=Array.from(q.array),cross=(a:number,b:number,c:number)=>(p.getX(b)-p.getX(a))*(p.getY(c)-p.getY(a))-(p.getY(b)-p.getY(a))*(p.getX(c)-p.getX(a))
  const quality=(a:number,b:number,c:number)=>Math.abs(cross(a,b,c))/((p.getX(a)-p.getX(b))**2+(p.getY(a)-p.getY(b))**2+(p.getX(b)-p.getX(c))**2+(p.getY(b)-p.getY(c))**2+(p.getX(c)-p.getX(a))**2+(p.getY(c)-p.getY(a))**2||1)
  let flips=0
  for(let pass=0;pass<12;pass++){
    const edges=new Map<string,number[]>(),cap=new Set<number>(),used=new Set<number>();let changes=0
    for(let t=0;t<indices.length;t+=3){const a=indices[t],b=indices[t+1],c=indices[t+2];if(p.getZ(a)!==p.getZ(b)||p.getZ(a)!==p.getZ(c))continue
      if(Math.min(175.4-p.getY(a)/UNIT,175.4-p.getY(b)/UNIT,175.4-p.getY(c)/UNIT)<=235)continue
      cap.add(t);for(const[u,v]of[[a,b],[b,c],[c,a]]){const key=Math.min(u,v)+':'+Math.max(u,v),e=edges.get(key)||[];e.push(t);edges.set(key,e)}
    }
    for(const[key,ts]of edges){if(ts.length!==2||ts.some(t=>used.has(t)))continue;const[a,b]=key.split(':').map(Number),[s,t]=ts,c=indices.slice(s,s+3).find(v=>v!==a&&v!==b)!,d=indices.slice(t,t+3).find(v=>v!==a&&v!==b)!;if(c===d||p.getZ(c)!==p.getZ(d))continue
      const ca=cross(c,d,a),cb=cross(c,d,b),ac=cross(a,b,c),ad=cross(a,b,d);if(ca*cb>=0||ac*ad>=0)continue
      const old=Math.min(quality(a,b,c),quality(a,b,d)),next=Math.min(quality(c,d,a),quality(c,d,b));if(next<=old*(1+1e-5)+1e-12)continue
      const sign=Math.sign(cross(indices[s],indices[s+1],indices[s+2])),one=ca*sign>0?[c,d,a]:[c,a,d],two=cb*sign>0?[c,d,b]:[c,b,d];for(let j=0;j<3;j++){indices[s+j]=one[j];indices[t+j]=two[j]}used.add(s);used.add(t);changes++;flips++
    }
    if(!changes)break
  }
  g.setIndex(indices);g.userData.chartDiagonalFlips={flips,sourcePixelMin:235,positionsUnchanged:true,boundaryUnchanged:true}
}

function authoredRearFlowPoint(px:number,py:number,face:number,dome:number,tuft:boolean) {
  const pixel=175.4-py/UNIT,guide=tuft?[[235,-.650],[250,-.650],[270,-.620],[285,-.610]]:[[225,-.730],[235,-.735],[250,-.760],[270,-.770],[290,-.730],[310,-.680],[330,-.660]]
  const depth=(y:number)=>{
    let i=1;while(i<guide.length-1&&y>guide[i][0])i++
    const a=guide[i-1],b=guide[i],before=guide[Math.max(0,i-2)],after=guide[Math.min(guide.length-1,i+1)],span=b[0]-a[0],t=Math.max(0,Math.min(1,(y-a[0])/span)),slope=(b[1]-a[1])/span
    const first=monotoneSlope((a[1]-before[1])/(a[0]-before[0]||1),slope),last=monotoneSlope(slope,(after[1]-b[1])/(after[0]-b[0]||1))
    return a[1]+(b[1]-a[1])*t*t*(3-2*t)+span*t*(1-t)*(first*(1-t)-last*t)
  }
  const dzdy=-(depth(pixel+.05)-depth(pixel-.05))/(.10*UNIT),normal=new Vector3(0,dzdy,-1).normalize(),half=(tuft?.005:.006)+(tuft?.017:.024)*dome
  // Retain the one-to-one authored XY chart. Axial separation has the
  // requested finite component along the true curved mid-surface normal.
  return new Vector3(-px,py,depth(pixel)-(2*face-1)*half/Math.abs(normal.z))
}

function crownRootSource(source:BufferGeometry){
 const geometry=source.clone()
 let p=geometry.attributes.position,indices=Array.from(geometry.index!.array)
 const face={getZ:(i:number)=>p.getZ(i)/.045},edges=new Map<string,Set<number>>(),active=new Set<number>();let flips=0;
 const key=(a:number,b:number)=>Math.min(a,b)+':'+Math.max(a,b),ids=(t:number)=>indices.slice(t*3,t*3+3) as[number,number,number],orient=(a:number,b:number,c:number)=>(p.getX(b)-p.getX(a))*(p.getY(c)-p.getY(a))-(p.getY(b)-p.getY(a))*(p.getX(c)-p.getX(a));
 const eligible=(t:number)=>{const v=ids(t);return Math.max(...v.map(i=>p.getY(i)))<.375&&Math.min(...v.map(i=>p.getY(i)))>-.28&&v.every(i=>Math.abs(face.getZ(i)-face.getZ(v[0]))<1e-7)&&(Math.abs(face.getZ(v[0]))<1e-7||Math.abs(face.getZ(v[0])-1)<1e-7)};
 const add=(t:number)=>{const v=ids(t);for(let i=0;i<3;i++){const k=key(v[i],v[(i+1)%3]);if(!edges.has(k))edges.set(k,new Set());edges.get(k)!.add(t)}};
 const remove=(t:number)=>{const v=ids(t);for(let i=0;i<3;i++){const k=key(v[i],v[(i+1)%3]);edges.get(k)!.delete(t);if(!edges.get(k)!.size)edges.delete(k)}};
 for(let t=0;t<indices.length/3;t++)if(eligible(t)){active.add(t);add(t)}
 const queue:string[]=[...edges.keys()];let cursor=0;
 function quality(a:number,b:number,c:number){const cross=orient(a,b,c),length=(i:number,j:number)=>(p.getX(i)-p.getX(j))**2+(p.getY(i)-p.getY(j))**2,l=[length(a,b),length(b,c),length(c,a)];return Math.min(cross*cross/(l[0]*l[1]),cross*cross/(l[1]*l[2]),cross*cross/(l[2]*l[0]))}
 while(cursor<queue.length){const edge=queue[cursor++],adj=edges.get(edge);if(!adj||adj.size!==2)continue;const[t,u]=[...adj],[i,j]=edge.split(':').map(Number),a=ids(t).find(v=>v!==i&&v!==j)!,b=ids(u).find(v=>v!==i&&v!==j)!;if(Math.abs(face.getZ(a)-face.getZ(b))>1e-7)continue;
  const oldSign=orient(...ids(t));if(orient(i,j,a)*orient(i,j,b)>=-1e-20||orient(a,b,i)*orient(a,b,j)>=-1e-20)continue;
  const old=Math.min(quality(i,j,a),quality(i,j,b)),next=Math.min(quality(a,b,i),quality(a,b,j));if(next<old+1e-10)continue;
  let first:[number,number,number]=[a,b,i],second:[number,number,number]=[b,a,j];if(orient(...first)*oldSign<0){first=[b,a,i];second=[a,b,j]}remove(t);remove(u);indices.splice(t*3,3,...first);indices.splice(u*3,3,...second);add(t);add(u);for(const v of[first,second])for(let k=0;k<3;k++)queue.push(key(v[k],v[(k+1)%3]));flips++;if(flips>500000)throw Error('Crown cap edge-flip convergence failed')
 }
 const positions=Array.from(p.array),originalVertices=p.count
 for(let pass=0;pass<6;pass++){
  const midpoints=new Map<string,number>()
  const midpoint=(a:number,b:number)=>{
    const k=key(a,b);if(midpoints.has(k))return midpoints.get(k)!
    const id=positions.length/3;for(let q=0;q<3;q++)positions.push((positions[a*3+q]+positions[b*3+q])/2)
    midpoints.set(k,id);return id
  }
  for(let t=0;t<indices.length/3;t++)if(eligible(t)){
    const [a,b,c]=ids(t);if(quality(a,b,c)>.0004)continue
    for(const [i,j]of[[a,b],[b,c],[c,a]])if((p.getX(i)-p.getX(j))**2+(p.getY(i)-p.getY(j))**2>.0028**2)midpoint(i,j)
  }
  if(!midpoints.size)break
  const refined:number[]=[]
  for(let t=0;t<indices.length/3;t++){
    const [a,b,c]=ids(t),ab=midpoints.get(key(a,b))??-1,bc=midpoints.get(key(b,c))??-1,ca=midpoints.get(key(c,a))??-1,mask=(ab>=0?1:0)|(bc>=0?2:0)|(ca>=0?4:0)
    switch(mask){
      case 0:refined.push(a,b,c);break
      case 1:refined.push(a,ab,c,ab,b,c);break
      case 2:refined.push(a,b,bc,a,bc,c);break
      case 3:refined.push(a,ab,c,ab,bc,c,ab,b,bc);break
      case 4:refined.push(a,b,ca,b,c,ca);break
      case 5:refined.push(a,ab,ca,ab,b,c,ab,c,ca);break
      case 6:refined.push(a,b,bc,a,bc,ca,bc,c,ca);break
      case 7:refined.push(a,ab,ca,ab,b,bc,ca,bc,c,ab,bc,ca);break
    }
  }
  indices=refined;p=new Float32BufferAttribute(positions,3)
 }
 geometry.setAttribute('position',new Float32BufferAttribute(positions,3));geometry.setIndex(indices)
 geometry.userData.crownRootRefinement={flips,eligibleTriangles:active.size,addedVertices:positions.length/3-originalVertices,sourceSupport:[108.4,225.4]}
 source.dispose();return geometry
}


// Sew only the real upper crown roots to the head. The same lower lock
// keeps its existing back-hair motion through a continuous physical skin.
function crownRootMesh(geometry:BufferGeometry,material:MeshPhongMaterial,parent:Object3D,anchors:readonly number[]) {
  if(!(parent instanceof Bone)||!(parent.parent instanceof Bone))throw new Error('Crown roots require the actual head/back-hair bones')
  const joints:number[]=[],weights:number[]=[]
  for(const value of anchors){
    // Binary complementary weights sum to exactly one after Float32 storage.
    const anchor=Math.round(value*16777216)/16777216
    joints.push(0,1,0,0);weights.push(anchor,1-anchor,0,0)
  }
  geometry.setAttribute('skinIndex',new Uint16BufferAttribute(joints,4))
  geometry.setAttribute('skinWeight',new Float32BufferAttribute(weights,4))
  const mesh=new SkinnedMesh(geometry,material)
  parent.add(mesh);mesh.updateWorldMatrix(true,false)
  mesh.bind(new Skeleton([parent.parent,parent]))
  mesh.userData.crownRootAnchor={sourceYHeldThrough:114,sourceYFreeFrom:200,headBone:parent.parent.name,movingBone:parent.name}
  return mesh
}

// A material chart on actual closed cross-sections. Coordinates follow the
// rest volume through skinning and settlement; no camera or image is sampled.
function hairFlowChart(geometry:BufferGeometry,sectionAnchor:Float32BufferAttribute) {
  const p=geometry.attributes.position,groups:{first:number,end:number,center:Vector3,length:number}[]=[]
  for(let i=0;i<p.count;) {
    const first=i,center=new Vector3().fromBufferAttribute(sectionAnchor,i)
    for(i++;i<p.count&&sectionAnchor.getX(i)===center.x&&sectionAnchor.getY(i)===center.y&&sectionAnchor.getZ(i)===center.z;i++);
    const previous=groups[groups.length-1]
    groups.push({first,end:i,center,length:previous?previous.length+previous.center.distanceTo(center):0})
  }
  const total=groups[groups.length-1].length,chart:number[]=[],point=new Vector3()
  if(!(total>.01)||groups.length<4)throw new Error('Hair flow requires finite ordered sections')
  for(const row of groups) {
    const count=row.end-row.first
    if(count===1){chart.push(row.length/total,0,0,0);continue}
    const widthAxis=new Vector3().fromBufferAttribute(p,row.first).sub(row.center),width=widthAxis.length()
    widthAxis.normalize()
    const depthAxis=new Vector3().fromBufferAttribute(p,row.first+Math.floor(count/4)).sub(row.center)
    depthAxis.addScaledVector(widthAxis,-depthAxis.dot(widthAxis));const depth=depthAxis.length();depthAxis.normalize()
    if(width<1e-8||depth<1e-8)throw new Error('Hair flow section collapsed')
    for(let i=row.first;i<row.end;i++) {
      point.fromBufferAttribute(p,i).sub(row.center)
      chart.push(row.length/total,point.dot(widthAxis)/width,point.dot(depthAxis)/depth,width)
    }
  }
  geometry.setAttribute('hairFlowCoordinate',new Float32BufferAttribute(chart,4))
  geometry.userData.hairFlowChart={actualClosedSections:groups.length,centerlineLength:total,noCameraInput:true,imageTexture:false}
}

function sweptHairFlowChart(geometry:BufferGeometry,rows:number,columns:number) {
  const p=geometry.attributes.position,anchors:number[]=[],center=new Vector3()
  for(let row=0;row<=rows;row++) {
    center.set(0,0,0)
    for(let column=0;column<columns;column++)center.add(new Vector3().fromBufferAttribute(p,row*columns+column))
    center.divideScalar(columns)
    for(let column=0;column<columns;column++)anchors.push(center.x,center.y,center.z)
  }
  hairFlowChart(geometry,new Float32BufferAttribute(anchors,3))
}

function hairFlowMaterial(source:MeshPhongMaterial) {
  const paint=source.clone()
  paint.onBeforeCompile=(shader,renderer)=>{
    source.onBeforeCompile(shader,renderer)
    shader.uniforms.hairFlowInk={value:new Color(0x4354a2)}
    shader.uniforms.hairFlowSheen={value:new Color(0x9aa5ef)}
    shader.vertexShader='attribute vec4 hairFlowCoordinate; varying vec4 hairFlow;\n'+shader.vertexShader
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\n hairFlow=hairFlowCoordinate;')
    shader.fragmentShader='varying vec4 hairFlow; uniform vec3 hairFlowInk,hairFlowSheen;\n'+shader.fragmentShader
    shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`
      float flowT=clamp(hairFlow.x,0.,1.);
      float flowWidth=max(.0001,hairFlow.w);
      float flowAcross=hairFlow.y;
      float firstFlow=.34+.095*sin(5.2*flowT+.35);
      float secondFlow=-.43+.075*sin(6.8*flowT+1.1);
      float firstDistance=abs(flowAcross-firstFlow)*flowWidth;
      float secondDistance=abs(flowAcross-secondFlow)*flowWidth;
      float flowAA=max(.00025,.75*fwidth(firstDistance));
      float firstStroke=1.-smoothstep(.0010-flowAA,.0010+flowAA,firstDistance);
      float secondStroke=1.-smoothstep(.0007-flowAA,.0007+flowAA,secondDistance);
      float firstTaper=smoothstep(.08,.24,flowT)*(1.-smoothstep(.72,.93,flowT));
      float secondTaper=smoothstep(.21,.38,flowT)*(1.-smoothstep(.66,.84,flowT));
      float flowFace=smoothstep(.16,.48,abs(hairFlow.z));
      float flowFold=(.20*pow(abs(flowAcross),2.5)+.14*exp(-pow((flowAcross+.54)/.23,2.)))*flowFace;
      outgoingLight=mix(outgoingLight,hairFlowInk,flowFold);
      float flowStroke=(.62*firstStroke*firstTaper+.35*secondStroke*secondTaper)*flowFace;
      outgoingLight=mix(outgoingLight,hairFlowInk,flowStroke);
      float flowGlint=exp(-pow((flowAcross-firstFlow-.10)*flowWidth/.020,2.));
      outgoingLight=mix(outgoingLight,hairFlowSheen,.14*flowGlint*firstTaper*flowFace);
      #include <opaque_fragment>
    `)
  }
  paint.customProgramCacheKey=()=>source.customProgramCacheKey()+'|fixed-hair-flow-v2'
  paint.userData={...paint.userData,fixedHairFlow:{realSectionChart:true,imageTexture:false,cameraWarp:false}}
  return paint
}

/** Closed, tapered locks authored as silhouettes with sculpted depth.
 * Every lock is actual geometry, including its colored edges and shading. */
export function createBluefishHair(parent: Object3D, fringe: Object3D) {
  const shoulderLocks: Mesh[] = []
  function addSettlement(mesh: Mesh, target: BufferGeometry) {
    mesh.geometry.morphAttributes.position = [target.attributes.position]
    mesh.geometry.morphAttributes.normal = [target.attributes.normal]
    mesh.updateMorphTargets()
    target.dispose()
    shoulderLocks.push(mesh)
  }
  const material = new MeshPhongMaterial({ vertexColors: true, shininess: 1, specular: 0x000000 })
  material.userData.outlineParameters = { color: new Color(0x3c4c8b).toArray(), thickness: .00135 }
  const ink = new MeshBasicMaterial({ color: 0x3c4c8b })
  ink.userData.outlineParameters = { visible: false }
  material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <envmap_fragment>', `
      float lightLevel = dot(reflectedLight.directDiffuse + reflectedLight.indirectDiffuse, vec3(.2126,.7152,.0722));
      float pigmentLevel = max(.01, dot(diffuseColor.rgb,vec3(.2126,.7152,.0722)));
      outgoingLight = diffuseColor.rgb * (.86 + .17 * smoothstep(.25,1.2,lightLevel/pigmentLevel));
      #include <envmap_fragment>
    `)
  }
  const reflections = REAR_REFLECTIONS.map((polygon,index) => {
    const xs=polygon.map(point=>point[0]), ys=polygon.map(point=>point[1]), count=polygon.length
    const vertices=polygon.map(([x,y])=>`vec2(${x.toFixed(1)},${y.toFixed(1)})`).join(',')
    return {
      shader:`float rearReflection${index}(vec2 p) {
        const vec2 shape[${count}] = vec2[${count}](${vertices});
        float distanceSquared = 10000.;
        bool inside = false;
        for (int i=0;i<${count};i++) {
          vec2 a=shape[i], b=shape[(i+1)%${count}], edge=b-a, offset=p-a;
          vec2 nearest=offset-edge*clamp(dot(offset,edge)/max(dot(edge,edge),.00001),0.,1.);
          distanceSquared=min(distanceSquared,dot(nearest,nearest));
          float dy=abs(edge.y)<.00001 ? .00001 : edge.y;
          if (((a.y>p.y)!=(b.y>p.y)) && p.x<edge.x*(p.y-a.y)/dy+a.x) inside=!inside;
        }
        float distance=(inside ? -1. : 1.)*sqrt(distanceSquared);
        return 1.-smoothstep(-1.3,.6,distance);
      }`,
      sample:`if (p.x>${Math.min(...xs)-1}. && p.x<${Math.max(...xs)+1}.
        && p.y>${Math.min(...ys)-1}. && p.y<${Math.max(...ys)+1}.)
        mask=max(mask,rearReflection${index}(p));`,
    }
  })
  const reflectionShader=reflections.map(part=>part.shader).join('\n')+`
    float rearReflection(vec2 p) {
      float mask=0.;
      ${reflections.map(part=>part.sample).join('\n')}
      return mask*smoothstep(95.,101.,p.y);
    }
    float rearPart(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d) {
      float distanceSquared=10000.;
      float nearest=0.;
      vec2 previous=a;
      for(int i=1;i<=24;i++) {
        float t=float(i)/24., u=1.-t;
        vec2 point=u*u*u*a+3.*u*u*t*b+3.*u*t*t*c+t*t*t*d;
        vec2 edge=point-previous, offset=p-previous;
        float fraction=clamp(dot(offset,edge)/max(dot(edge,edge),.00001),0.,1.);
        vec2 delta=offset-fraction*edge;
        if(dot(delta,delta)<distanceSquared) {
          distanceSquared=dot(delta,delta);
          nearest=(float(i)-1.+fraction)/24.;
        }
        previous=point;
      }
      return exp(-distanceSquared/1.1)*smoothstep(0.,.17,nearest)
        *(1.-smoothstep(.88,1.,nearest));
    }`
  const rearPaint = material.clone()
  rearPaint.userData.outlineParameters = { visible: false }
  rearPaint.onBeforeCompile = (shader,renderer) => {
    material.onBeforeCompile(shader,renderer)
    shader.uniforms.rearSheen = { value:new Color(0x9ba7ff) }
    shader.uniforms.rearPartInk = { value:new Color(0x4253ad) }
    shader.uniforms.rearContourInk = { value:new Color(0x3c4c8b) }
    shader.vertexShader = 'attribute vec3 rearPaintPoint; attribute vec2 hairContour; varying vec3 rearField; varying vec2 rearContour; varying float rearFacing;\n'+shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <defaultnormal_vertex>',
      '#include <defaultnormal_vertex>\n rearFacing = max(0.,-normalize(objectNormal).z);')
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n rearField = rearPaintPoint; rearContour = hairContour;')
    shader.fragmentShader = `varying vec3 rearField;
      varying vec2 rearContour;
      varying float rearFacing;
      uniform vec3 rearSheen, rearPartInk, rearContourInk;
    `+reflectionShader+'\n'+shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      vec2 p = rearField.xy;
      float sheen = rearReflection(p);
      float side = sign(p.x-257.);
      float flow = p.x-.0018*side*(p.y-104.)*(p.y-104.);
      float fibers = pow(.5+.5*sin(6.2831853*flow/8.2),32.);
      float field = smoothstep(91.,104.,p.y)*(1.-smoothstep(172.,198.,p.y))
        *(1.-smoothstep(57.,74.,abs(p.x-257.)));
      diffuseColor.rgb *= 1.-.055*fibers*field*rearField.z;
      diffuseColor.rgb = mix(diffuseColor.rgb,rearSheen,.34*sheen*rearField.z);
      if(p.x>232. && p.x<279. && p.y>134. && p.y<204.) {
        float part=max(rearPart(p,vec2(238.,149.),vec2(236.,171.),vec2(247.,187.),vec2(257.,198.)),
          rearPart(p,vec2(272.,139.),vec2(273.,165.),vec2(267.,185.),vec2(254.,200.)));
        diffuseColor.rgb=mix(diffuseColor.rgb,rearPartInk,.48*part*rearField.z);
      }
    `)
    // The drawn seam belongs to the rear surface. A round tube protruded
    // into the side view even when the lock itself had turned edge-on.
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      float contourAA=max(.0003,.65*fwidth(rearContour.x));
      float contour=(1.-smoothstep(.0052-contourAA,.0052+contourAA,rearContour.x))
        *smoothstep(.55,.90,rearField.z)*rearContour.y
        *(.80+.20*smoothstep(.18,.65,rearFacing));
      outgoingLight=mix(outgoingLight,rearContourInk,.92*contour);
      #include <opaque_fragment>
    `)
  }
  const outlined = material.clone()
  outlined.onBeforeCompile = material.onBeforeCompile
  outlined.userData.outlineParameters = { color: new Color(0x38467f).toArray(), thickness: .00185 }
  const hemPaint = material.clone()
  hemPaint.userData.outlineParameters = { visible: false }
  const hemInk = new Color(0x3c4c8b)
  hemPaint.onBeforeCompile = (shader,renderer) => {
    material.onBeforeCompile(shader,renderer)
    shader.uniforms.hemInk = { value: hemInk }
    shader.fragmentShader = 'uniform vec3 hemInk;\n'+shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      float hemGrazing = abs(dot(normalize(normal),normalize(vViewPosition)));
      float hemAA=max(.009,.85*fwidth(hemGrazing));
      outgoingLight = mix(outgoingLight,hemInk,.72*(1.-smoothstep(.012-hemAA,.012+hemAA,hemGrazing)));
      #include <opaque_fragment>
    `)
  }
  function rearFlowMaterial(contour: readonly Vector3[], guide: readonly Vector3[]) {
    const points=(values:readonly Vector3[])=>values.map(p=>`vec2(${(257-p.x/UNIT).toFixed(5)},${(175.4-p.y/UNIT).toFixed(5)})`).join(',')
    const contourData=points(contour),guideData=points(guide)
    const field=`
      vec2 continuousRearEdge(vec2 p) {
        const vec2 points[${contour.length}]=vec2[${contour.length}](${contourData});
        float distanceSquared=1000000.,outerDistanceSquared=1000000.;
        for(int i=0;i<${contour.length-1};i++) {
          vec2 a=points[i],edge=points[i+1]-a,offset=p-a;
          vec2 delta=offset-edge*clamp(dot(offset,edge)/max(dot(edge,edge),.000001),0.,1.);
          distanceSquared=min(distanceSquared,dot(delta,delta));
          // The first four authored Bezier curves form the outer fold.
          // The return contour remains available for the fine edge line.
          if(i<64)outerDistanceSquared=min(outerDistanceSquared,dot(delta,delta));
        }
        return sqrt(vec2(distanceSquared,outerDistanceSquared));
      }
      vec2 continuousRearGlint(vec2 p) {
        const vec2 points[${guide.length}]=vec2[${guide.length}](${guideData});
        float distanceSquared=1000000.,along=0.;
        for(int i=0;i<${guide.length-1};i++) {
          vec2 a=points[i],edge=points[i+1]-a,offset=p-a;
          float t=clamp(dot(offset,edge)/max(dot(edge,edge),.000001),0.,1.);
          vec2 delta=offset-edge*t;
          if(dot(delta,delta)<distanceSquared) {
            distanceSquared=dot(delta,delta);
            along=(float(i)+t)/${(guide.length-1).toFixed(1)};
          }
        }
        return vec2(sqrt(distanceSquared),along);
      }
    `
    const paint=rearPaint.clone()
    paint.onBeforeCompile=(shader,renderer)=>{
      rearPaint.onBeforeCompile(shader,renderer)
      shader.uniforms.continuousRearSheen={value:new Color(0x8f9aee)}
      shader.uniforms.continuousRearFoldInk={value:new Color(0x3b4c97)}
      shader.fragmentShader='uniform vec3 continuousRearSheen,continuousRearFoldInk;\n'+field+shader.fragmentShader
      shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`
        #include <color_fragment>
        vec2 rearFieldEdge=continuousRearEdge(rearField.xy);
        float rearFoldWidth=14.-10.*smoothstep(226.,309.,rearField.y);
        float rearFoldShade=(1.-smoothstep(.5*rearFoldWidth,rearFoldWidth,rearFieldEdge.y))
          *smoothstep(145.,190.,rearField.y)*(1.-smoothstep(318.,338.,rearField.y));
        diffuseColor.rgb=mix(diffuseColor.rgb,continuousRearFoldInk,.72*rearFoldShade*rearField.z);
        vec2 rearGlintSample=continuousRearGlint(rearField.xy);
        float rearGlintTaper=pow(max(0.,sin(3.14159265359*rearGlintSample.y)),.65);
        float rearGlintSheen=(.30*exp(-pow(rearGlintSample.x/9.28571429,2.))+.12*exp(-pow(rearGlintSample.x/2.85714286,2.)))*.65;
        diffuseColor.rgb=mix(diffuseColor.rgb,continuousRearSheen,rearGlintSheen*rearGlintTaper*rearField.z);
      `)
      shader.fragmentShader=shader.fragmentShader.replace(
        'float contourAA=max(.0003,.65*fwidth(rearContour.x));\n      float contour=(1.-smoothstep(.0052-contourAA,.0052+contourAA,rearContour.x))',
        'float fixedRearDistance=rearFieldEdge.x;\n      float contourAA=max(.12,.65*fwidth(fixedRearDistance));\n      float contour=(1.-smoothstep(.93-contourAA,.93+contourAA,fixedRearDistance))')
    }
    paint.customProgramCacheKey=()=>rearPaint.customProgramCacheKey()+'|continuous-rear-flow-v1|'+contourData+'|'+guideData+'|outer-edge-fold-v4'
    paint.userData={...paint.userData,continuousRearFlow:{contourPoints:contour.length,guidePoints:guide.length,geometryBound:true,imageTexture:false,edgeFoldShadow:true,outerRailPoints:65}}
    return paint
  }

  function cheekFlowPaint(temple: boolean) {
    const paint=outlined.clone()
    paint.onBeforeCompile=(shader,renderer)=>{
      outlined.onBeforeCompile(shader,renderer)
      shader.uniforms.curlFlowInk={value:new Color(0x3c4c8b)}
      shader.vertexShader='attribute vec4 curlFlow; varying vec4 curlChart;\n'+shader.vertexShader
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\n curlChart=curlFlow;')
      shader.fragmentShader='varying vec4 curlChart; uniform vec3 curlFlowInk;\n'+shader.fragmentShader
      shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`
        float curlT=clamp(curlChart.x,0.,1.);
        float curlAngle=atan(curlChart.z,curlChart.y);
        float curlGuide=.20+.42*sin(3.14159265359*curlT)-.42*curlT;
        float curlDelta=atan(sin(curlAngle-curlGuide),cos(curlAngle-curlGuide));
        float curlDistance=abs(curlDelta)*max(.004,curlChart.w);
        float curlAA=max(.00025,.65*fwidth(curlDistance));
        float curlTaper=smoothstep(.16,.27,curlT)*(1.-smoothstep(.83,.94,curlT));
        float curlStroke=(1.-smoothstep(.00125-curlAA,.00125+curlAA,curlDistance))*curlTaper;
        outgoingLight=mix(outgoingLight,curlFlowInk,.55*curlStroke);
        #include <opaque_fragment>
      `)
    }
    paint.customProgramCacheKey=()=>outlined.customProgramCacheKey()+'|cheek-fixed-section-flow-v1|'+Number(temple)
    paint.userData={...outlined.userData,cheekFlow:{fixedSectionChart:true,imageTexture:false,cameraWarp:false}}
    return paint
  }

  function lowerCurl(side: number, name: string, sections: ProfileLockSections, start: readonly [number,number], curves: readonly Curve[], tint: number) {
    const geometry = sections===HEM_MAIN?continuousSideCurlGeometry(side,tint):sections===HEM_INNER?guidedInnerReturnGeometry(side,tint):hemCurlGeometry(side,sections,start,curves,tint)
    const mesh = sections===HEM_MAIN||sections===HEM_INNER
      ?lowerReturnMesh(geometry,hemPaint,parent):new Mesh(geometry,hemPaint)
    mesh.name = name+'-curl'
    if(sections===HEM_MAIN||sections===HEM_INNER)mesh.userData.preserveCurlSections=true
    parent.add(mesh)
  }
  for (const side of [-1, 1]) {
    for (const sections of [TEMPLE_CURL, JAW_CURL]) {
      const temple = sections === TEMPLE_CURL
      const lock = new Mesh(cheekGeometry(side, sections), cheekFlowPaint(temple))
      lock.name = temple ? 'temple-curl' : 'jaw-curl'
      fringe.add(lock)
      const frontDepth = profileFrontDepth(lock.geometry)
      const guides = temple
        ? [[[187,166],[186,178],[194,191],[209.5,199.5]]]
        : [[[186,180],[184,192],[192,210],[205,218],[215,220],[219,219]]]
      for (const guide of guides) {
        const path = new CatmullRomCurve3(guide.map(([x,y])=>
          new Vector3(side*(257-x)*UNIT,(175.4-y)*UNIT,0)))
        const stroke = new class extends SpatialCurve<Vector3> {
          constructor() { super() }
          getPoint(t: number, target = new Vector3()) {
            path.getPoint(t,target)
            const depth = frontDepth(target.x,target.y)
            // The authoring guides stay on the curved lock, including its
            // taper. Sampling every point avoids a chord through the curl.
            target.z = (depth ?? 0)+.0014
            return target
          }
        }()
        const tube = new TubeGeometry(stroke,120,.0019,6)
        const vertices = tube.attributes.position, center = new Vector3()
        for (let row=0;row<=120;row++) {
          const t=row/120
          stroke.getPointAt(t,center)
          const end = Math.min(1,t/.05,(1-t)/.07)
          const radius = Math.max(.025,end*end*(3-2*end))
          for (let j=0;j<=6;j++) {
            const i=row*7+j
            vertices.setXYZ(i,center.x+(vertices.getX(i)-center.x)*radius,
              center.y+(vertices.getY(i)-center.y)*radius,center.z+(vertices.getZ(i)-center.z)*radius)
          }
        }
        tube.computeVertexNormals()
        const strand = new Mesh(tube,ink)
        strand.name=temple?'temple-front-strand':'jaw-front-strand'
        fringe.add(strand)
      }
    }
  }

  // Join the side and rear masses under the drawn locks. A continuous
  // swept surface gives the hair depth at angles between the reference views.
  const joins = [
    // Height, front X/Z, widest X/Z, rear X/Z.
    [-.13, .35, -.24, .43, -.42, .34, -.59],
    [-.28, .43, -.22, .52, -.46, .40, -.68],
    [-.49, .51, -.23, .61, -.46, .50, -.73],
    [-.69, .59, -.28, .72, -.51, .64, -.76],
    [-.90, .62, -.28, .74, -.56, .66, -.76],
    [-1.08, .53, -.30, .66, -.49, .57, -.69],
    [-1.21, .43, -.34, .52, -.46, .44, -.60],
    [-1.26, .33, -.46, .36, -.44, .30, -.52],
  ]
  const frontJoin = new CatmullRomCurve3(joins.map(([y, x, z]) => new Vector3(x, y, z)))
  const sideJoin = new CatmullRomCurve3(joins.map(([y, , , x, z]) => new Vector3(x, y, z)))
  const rearJoin = new CatmullRomCurve3(joins.map(([y, , , , , x, z]) => new Vector3(x, y, z)))
  const joinPositions: number[] = [], joinColors: number[] = [], joinIndices: number[] = []
  const joinBase = new Color(0x576ac4), joinLight = new Color(0x7286dc), joinColor = new Color()
  const joinRows = 48, joinColumns = 24
  for (const side of [-1, 1]) {
    const offset = joinPositions.length / 3
    for (let row = 0; row <= joinRows; row++) {
      const t = row / joinRows
      const front = frontJoin.getPoint(t), middle = sideJoin.getPoint(t), rear = rearJoin.getPoint(t)
      for (let column = 0; column <= joinColumns; column++) {
        const u = column / joinColumns
        const bulge = Math.sin(Math.PI * u)
        const x = front.x + (rear.x - front.x) * u + (middle.x - (front.x + rear.x) / 2) * bulge
        const z = front.z + (rear.z - front.z) * u + (middle.z - (front.z + rear.z) / 2) * bulge
        const wave = .5 + .5 * Math.cos(5.8 * Math.PI * t - 3.9 * u + .52 * Math.sin(3.1 * t * Math.PI))
        const relief = .043 * (wave - .70) * bulge ** 2 * Math.sin(Math.PI * t)
        const point = seatBehindMiddleWave(hemLining(gatherHemTips(tuckBehindLowerCurls(drapeAroundDress(lowerLockWidth(side * (x + relief), middle.y), middle.y, z)))))
        point.z+=upperBackFlow(point.y)
        // The side/rear join fills the inside of the hairstyle. Keep its
        // waist surface beneath the closed outer curls as they return.
        const joinPixel=175.4-point.y/UNIT
        const joinBack=Math.max(0,Math.min(1,(u-.25)/.65))
        const joinSeat=Math.exp(-(((joinPixel-296)/48)**4))*joinBack*joinBack*(3-2*joinBack)*(side<0?1:.35)
        point.x-=side*.035*joinSeat
        point.z+=.060*joinSeat
        joinPositions.push(point.x, point.y, point.z)
        joinColor.copy(joinBase).lerp(joinLight, bulge * (.09 + .32 * wave ** 2))
        joinColors.push(joinColor.r, joinColor.g, joinColor.b)
        if (row < joinRows && column < joinColumns) {
          const a = offset + row * (joinColumns + 1) + column, b = a + joinColumns + 1
          if (side > 0) joinIndices.push(a, b, a + 1, a + 1, b, b + 1)
          else joinIndices.push(a, a + 1, b, a + 1, b + 1, b)
        }
      }
    }
  }
  const joinGeometry = new BufferGeometry()
  joinGeometry.setAttribute('position', new Float32BufferAttribute(joinPositions, 3))
  joinGeometry.setAttribute('color', new Float32BufferAttribute(joinColors, 3))
  joinGeometry.setIndex(joinIndices)
  joinGeometry.computeVertexNormals()
  parent.add(new Mesh(joinGeometry, material))

  function patch(view: View, start: readonly [number,number], curves: readonly Curve[], layer = 0, tint = 0x6577d4,
    surface: LockSurface = {}) {
    const sideView = view === 'left' || view === 'right'
    const roundedSide=sideView&&start[0]===743&&start[1]===223
    const roundedUpper=sideView&&start[0]===748&&start[1]===147
    const roundedUpperBacking=sideView&&start[0]===746&&start[1]===155
    const roundedSource=roundedSide||roundedUpper||roundedUpperBacking
    const originX = sideView ? 710 : 257
    const x = (n: number) => (n-originX)*UNIT
    const y = (n: number) => (175.4-n)*UNIT
    const shape = new Shape().moveTo(x(start[0]),y(start[1]))
    for (const [a,b,c,d,e,f] of curves) shape.bezierCurveTo(x(a),y(b),x(c),y(d),x(e),y(f))
    shape.closePath()
    const boundary = shape.getPoints(sideView ? 96 : 9)
    const glintPath = surface.glint?.map(([u,v]) => [x(u), y(v)] as const)
    const fineContour = surface.root || surface.waistFlow || surface.waistTuft
    const original = roundedSource?roundedProfileStrandSource(boundary):new ExtrudeGeometry(shape,{
      depth: 1, bevelEnabled: false, curveSegments: fineContour ? 32 : 18, steps: 1,
    })
    // Normalize depth before tessellation so the triangulation density is
    // driven by the silhouette, rather than a temporary extrusion length.
    if(!roundedSource)original.scale(1,1,.045)
    const anchoredCrown=view==='back'&&start[1]<=110
    const refined = roundedSource?original:refineProfile(original, sideView && fineContour ? .0125 : fineContour ? .025 : .039)
    let geometry=anchoredCrown?crownRootSource(refined):refined
    if(view==='back'&&surface.waistFlow)retessellateRearChart(geometry)
    if(!roundedSource)original.dispose()
    const positions = geometry.attributes.position
    const settledRoot = surface.root?.settled
    const settled = settledRoot && new Float32BufferAttribute(new Float32Array(positions.count * 3), 3)
    const colors: number[] = [], rearPoints: number[] = [], contourDistances: number[] = []
    const crownAnchors:number[]=[]
    const backingSource:number[]=[]
    const base = new Color(tint), dark = new Color(surface.waistTuft ? 0x4055bb : 0x3e4e9f)
    const light = new Color(0x8f9aee), color = new Color()
    const fold = surface.underlay && !sideView ? new Color(0x384bb5) : undefined
    function project(px: number, py: number, face: number, dome: number, root?: LockRoot) {
      let depth: number
      let crownLift = 0
      const lowerFall = Math.max(0, Math.min(1, (-py - .40) / .28))
      const lowerEnd = Math.max(0, Math.min(1, (py + 1.40) / .35))
      const lowerWrap = lowerFall * lowerFall * (3 - 2 * lowerFall) * lowerEnd * lowerEnd * (3 - 2 * lowerEnd)
      if(view==='back') {
        const crownRadius = Math.max(Math.sqrt(.001), bluefishCrownRadius(py))
        const crownAngle = Math.sqrt(Math.max(0, 1 - (px / (.465 * crownRadius)) ** 2))
        const crown = .158 + (.437 + .065 * crownAngle) * crownRadius * crownAngle
        crownLift = bluefishCrownLift(py, crownRadius, crownAngle)
        const blend=Math.min(1,Math.max(0,(.12-py)/.42))
        const outer = Math.max(0, Math.min(1, (Math.abs(px) - .33) / .45))
        const wrap = .106 * Math.min(1, Math.abs(px) / .86) ** 2 + .155 * lowerWrap * outer * outer
        const tip = Math.max(0, Math.min(1, (-py - .80) / .54))
        // The inner lower strands curve toward the waist, opening the
        // back of the petticoat while the outside curls retain their depth.
        const hemHeight = Math.exp(-(((py + 1.13) / .147) ** 4))
        const hemWidth = Math.max(0, Math.min(1, (.64 - Math.abs(px)) / .20))
        const tuck = .34 * hemHeight * hemWidth * hemWidth * (3 - 2 * hemWidth)
        const sweep = .80 + .08 * Math.sin((py + .18) * 3.4) - wrap - .32 * tip ** 2 - tuck
        // Gather the main locks into the crown at the part, then let
        // their full overlap emerge below it. Keeping the lower layer
        // offset at the root raised every seam into a separate ridge.
        const rootFall = Math.max(0, Math.min(1, (.50-py)/.43))
        const layerDepth = surface.waistFlow
          ? layer*(.10+.90*rootFall*rootFall*(3-2*rootFall)) : layer
        depth = crown * (1 - blend) + sweep * blend + layerDepth
        // The broad strand covers the joining curl, while the inner lining
        // still tucks beneath it. Preserve this order around the shoulder.
        const joinCover = surface.waistFlow ? Math.exp(-(((py + .17) / .12) ** 4)
          - (((Math.abs(px) - .172) / .065) ** 4)) : 0
        depth += Math.max(0, .797 - depth) * joinCover
      } else if(view==='front') {
        const fall = Math.max(0, Math.min(1, (-py - .16) / .70))
        const sweep = .12 + .085 * Math.sin(-py * 8.2 + layer * 17)
        depth = -.12 - .18 * (Math.abs(px) / .9) ** 1.4 + layer - fall * sweep
        // Turn the outside edge of each frontal lock into the side mass.
        // Its end should follow the side section instead of cutting across it.
        const edge = Math.max(0, Math.min(1, (Math.abs(px) - .53) / .32))
        const side = sideSection(py)
        depth += (-side.axis + .27 * layer - depth) * edge * edge * (3 - 2 * edge) * .79 * fall
      } else {
        const { radius, axis } = sideSection(py)
        const width = view === 'right' ? radius * .964 : radius
        const lower = Math.max(0, Math.min(1, (-py - .78) / .48))
        const inset = surface.underlay ? .051 * lower * lower : 0
        depth = (surface.depth?.(px, py) ?? width * Math.sqrt(Math.max(.035, 1 - ((px - axis) / .57) ** 2))) + layer - inset
      }
      // Sink the back of the crown locks into the scalp. The outside
      // contour stays on the sculpted surface as the model turns sideways.
      const crownOverlap = view === 'back' ? .106 * Math.max(0, Math.min(1, (py + .22) / .20)) : 0
      const waistBend = view === 'back' && surface.waistFlow
        ? .12 * Math.exp(-(((py + .64) / .22) ** 4)) : 0
      const pz=depth+(face-.5)*(.010+((roundedUpper?.105:roundedUpperBacking?.075:.056)+waistBend)*dome)-(1-face)*crownOverlap
      if (view === 'front') {
        // Keep the lock and its drawn edge behind the pearled fin rim.
        const finSeat = .028 * Math.exp(-(((Math.abs(px) - .515) / .082) ** 4)
          - (((py + .119) / .061) ** 4) - (((pz + .247) / .061) ** 4))
        const lowerSeat = lowerFinSeat(py, pz)
        const fall = Math.max(0, Math.min(1, (-py - .132) / .055))
        // Once below the fin's root, the strand curves forward under the
        // rim. The folded membrane then peeks out on the outer side.
        const under = fall * fall * (3 - 2 * fall)
        const x = Math.sign(px) * Math.max(0, Math.abs(px) - lowerSeat * (1 - under))
        const tip = Math.max(0, Math.min(1, (-py - 1.20) / .13))
        const tipSweep = .051 * tip * tip * (3 - 2 * tip) * Math.exp(-(((pz + .200) / .090) ** 2))
        return drapeAroundDress(lowerLockWidth(x, py), py, pz - finSeat + .91 * lowerSeat * under - tipSweep)
      }
      if (view === 'back') {
        const fall = Math.max(0, Math.min(1, (-py - .80) / .34))
        const sweep = .055 * fall * Math.exp(-(((Math.abs(px) - .33) / .16) ** 4))
        const raw = new Vector3(lowerLockWidth(-px - Math.sign(px) * sweep, py),
          py + crownLift + .22 * Math.max(0, -py - 1.23), -pz)
        raw.z += bluefishCrownInset(raw.x,raw.y,raw.z)
        const point = drapeAroundDress(raw.x, raw.y, raw.z)
        // These short tips finish above the bow. Keep their lateral width
        // instead of gathering them into the long hair's waist attachment.
        if (surface.waistTuft) point.x = raw.x
        if (surface.waistFlow) {
          // Let the long rear locks flow around the bow. Flattening their
          // full width against the waist created a shelf in oblique views.
          const waist = Math.exp(-(((py + .64) / .20) ** 4))
          const side = Math.max(0, Math.min(1, (Math.abs(raw.x) - .20) / .17))
          const flank = side * side * (3 - 2 * side)
          point.lerp(raw, .92 * waist * flank)
          point.x += Math.sign(raw.x) * .012 * waist * flank
          // Keep the returning tip deep in the curl. Gathering it forward
          // with the lining makes a long flat blade in oblique views.
          const tip = Math.exp(-(((py + .75) / .08) ** 4))
          const inner = Math.max(0, Math.min(1, (.47 - Math.abs(raw.x)) / .10))
          const forward = Math.max(0, point.z + .72)
          point.z -= .96 * (forward - .010 * Math.tanh(forward / .010)) * tip * inner
        }
        return point
      }
      const outerWave = Math.exp(-(((py + .59) / .29) ** 4))
      const rearEdge = Math.max(0, Math.min(1, (px - .48) / .26))
      // Seat the root under the fin, then sweep the lock forward below it.
      const rootFall = Math.max(0, Math.min(1, (y(start[1]) - py) / .235))
      const rootSeat = (root?.inset ?? 0) * (1 - rootFall * rootFall * (3 - 2 * rootFall))
      const delay = root?.delay ?? 0
      const sweepFall = Math.max(0, (rootFall - delay) / (1 - delay))
      const shoulderTurn = (root?.forward ?? 0) * Math.sin(Math.PI * sweepFall) ** 2 * (.92 + .36 * rootFall)
      // Spread the downward bend over enough length to keep the strand's
      // vertical order through the full settled pose.
      const rootDrop = (root?.drop ?? 0) * Math.exp(-(((py + .195) / .205) ** 4))
      const z = -px - .090 * outerWave * rearEdge + shoulderTurn
      // The side locks seat under the folded fin, then fan back out at
      // the shoulder. The fins and the hair remain separate surfaces.
      const finSeat = Math.max(lowerFinSeat(py, z), .044 * Math.exp(-(((py + .117) / .080) ** 4) - (((z + .242) / .105) ** 4)))
      // The waves at the rear sit closer to the spine than the outside
      // shoulder locks. Keep the side contour as the rear edge curves in.
      const rearWrap = Math.max(0, Math.min(1, (-z - .47) / .37))
      // The outer skirt-side lock passes over this layer. Recess the
      // underlying surface before it comes back out at the hem.
      const frontSeat = .089 * Math.exp(-(((py + 1.046) / .271) ** 4) - (((z + .391) / .166) ** 4))
      const width = Math.max(0, pz - finSeat - frontSeat - rootSeat - .266 * lowerWrap * rearWrap * rearWrap * (3 - 2 * rearWrap))
      return drapeAroundDress(lowerLockWidth(view === 'left' ? width : -width, py), py - rootDrop, z)
    }
    function legacySculpt(px: number, py: number, face: number, dome: number, root: LockRoot | undefined = surface.root) {
      const point = tuckBehindLowerCurls(tuckBehindUpperCurls(project(px, py, face, dome, root), surface.waistFlow, sideView))
      if (surface.tailPassage) {
        // Lift the lining around the tail on the side where it leaves the
        // waist. The outer locks still carry the visible curl contours.
        const side = Math.max(0, Math.min(1, (point.x - .13) / .23))
        const depth = Math.exp(-(((point.z + .55) / .31) ** 4))
        const waist = Math.exp(-(((point.y + .91) / .27) ** 4))
        const clearance = .16 * side * side * (3 - 2 * side) * depth * waist
        point.z += clearance
        // This closed side backing follows the authored downward wave.
        // Retain depth clearance without lifting its lower sections into a shelf.
        if(!roundedUpperBacking)point.y += clearance
      }
      const gathered = gatherHemTips(point, sideView ? .83 : .31)
      const seated=seatBehindMiddleWave(surface.underlay ? hemLining(gathered) : gathered)
      if (surface.underlay && view==='back') {
        // The lining belongs beneath the outer locks and behind the
        // petticoat. Scale the whole local section, retaining its volume.
        const pixel=175.4-seated.y/UNIT
        const hem=Math.exp(-(((pixel-361)/34)**4))
        const front=Math.max(0,Math.min(1,(seated.z+.48)/.24))
        seated.x*=1-.11*hem*front*front*(3-2*front)
      }
      // Move the rear layers together at each height. Their separation and
      // depth order stay intact while clearing the independent outer loop.
      if(view==='back') seated.z+=upperBackFlow(seated.y)
      return seated
    }
    function sculpt(px: number, py: number, face: number, dome: number, root: LockRoot | undefined = surface.root) {
      const seated=legacySculpt(px,py,face,dome,root)
      if(view==='back'&&(surface.waistFlow||surface.waistTuft)){
        const pixel=175.4-py/UNIT,t=Math.max(0,Math.min(1,(pixel-235)/25)),blend=t*t*(3-2*t)
        if(blend){
          const target=authoredRearFlowPoint(px,py,face,dome,!!surface.waistTuft)
          const anchored=legacySculpt(px,(175.4-235)*UNIT,face,dome,root)
          // One common material chart leaves the preserved source235 root.
          // Do not blend per-vertex lateral tuck wrinkles into a narrow rail.
          const tangent=(legacySculpt(px,(175.4-235.1)*UNIT,face,dome,root).x-legacySculpt(px,(175.4-234.9)*UNIT,face,dome,root).x)/.2
          seated.x=-px+(anchored.x+px+tangent*(pixel-235))*(1-blend)
          seated.y=py
          seated.z+=(target.z-seated.z)*blend
        }
      }
      return seated
    }
    for (let i=0;i<positions.count;i++) {
      const px=positions.getX(i), py=positions.getY(i), face=positions.getZ(i)/.045
      if(view==='back'&&surface.underlay)backingSource.push(px,py,face)
      let distance=Infinity
      for (let j=0;j<boundary.length-1;j++) {
        const a=boundary[j],b=boundary[j+1],dx=b.x-a.x,dy=b.y-a.y
        const t=Math.max(0,Math.min(1,((px-a.x)*dx+(py-a.y)*dy)/(dx*dx+dy*dy || 1)))
        distance=Math.min(distance,Math.hypot(px-a.x-dx*t,py-a.y-dy*t))
      }
      const dome=Math.sin(Math.min(1,distance/.095)*Math.PI/2)
      if(anchoredCrown){
        const t=Math.max(0,Math.min(1,((175.4-py/UNIT)-114)/86))
        crownAnchors.push(1-t*t*(3-2*t))
      }
      const point=sculpt(px,py,face,dome)
      positions.setXYZ(i,point.x,point.y,point.z)
      if (view==='back') {
        rearPoints.push(257-point.x/UNIT,175.4-point.y/UNIT,face)
      }
      if (settled) {
        const tucked = sculpt(px, py, face, dome, settledRoot)
        settled.setXYZ(i, tucked.x, tucked.y, tucked.z)
      }
      const edge=Math.exp(-distance/(surface.waistFlow ? .012 : .024))
      const sweep = .5 + .5 * Math.sin(px * 8 + py * 5.1 + layer * 18)
      const ribbon = Math.exp(-(((distance - .034) / .019) ** 2))
      const glint = ribbon * (.5 + .5 * Math.sin(py * 10 + layer * 19)) ** 2
      const crownGlint = Math.exp(-(((py - .29 + .042 * sweep) / .052) ** 2))
      const lowerRoot = surface.root ? Math.max(0, Math.min(1, (-py - .55) / .25)) : 0
      let rootSeam = view==='back' ? Math.max(0,Math.min(1,((175.4-point.y/UNIT)-82)/14)) : 1
      if (view==='back' && surface.waistFlow) {
        const part=Math.max(0,Math.min(1,((175.4-point.y/UNIT)-158)/40))
        const offCenter=Math.max(0,Math.min(1,Math.abs(px)/.070))
        rootSeam *= offCenter+(1-offCenter)*part*part*(3-2*part)
      }
      if(view==='back') contourDistances.push(distance,rootSeam)
      const edgeShade = (surface.underlay ? .16 : sideView ? .36 - .15 * lowerRoot : .46)*rootSeam
      color.copy(base).lerp(dark, edge * edgeShade + (1 - face) * .16)
      const bodyGain = surface.root ? .60 : surface.waistFlow || surface.waistTuft ? .55 : 1
      const bodyLight = dome * (.06 + .30 * sweep ** 3) * bodyGain
      color.lerp(light, bodyLight + (glint * .20 + crownGlint * sweep * .13) * face)
      if (glintPath && !surface.waistFlow) {
        // Shade along the turn of the curl. These are vertex colors on the
        // lock itself, so the highlight follows the mesh through the orbit.
        let nearest = Infinity, along = 0
        for (let j = 0; j < glintPath.length - 1; j++) {
          const [ax,ay] = glintPath[j], [bx,by] = glintPath[j + 1]
          const dx = bx - ax, dy = by - ay
          const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
          const d = Math.hypot(px - ax - t * dx, py - ay - t * dy)
          if (d < nearest) {
            nearest = d
            along = (j + t) / (glintPath.length - 1)
          }
        }
        const taper = Math.sin(along * Math.PI) ** .65
        const broadBand = surface.waistTuft ? .028 : .052
        const fineBand = surface.waistTuft ? .010 : .016
        const sheen = (.30 * Math.exp(-((nearest / broadBand) ** 2)) + .12 * Math.exp(-((nearest / fineBand) ** 2)))
          * (surface.root ? .70 : surface.waistFlow ? .65 : 1)
        color.lerp(light, sheen * taper * face)
      }
      if (surface.shadow) color.lerp(dark, surface.shadow(px, py))
      if (fold) {
        // The exposed lining sits beneath the waist curls. Paint its inner
        // side as a recessed fold while retaining the outward-facing color.
        const innerFace = view === 'back' ? face : 1 - face
        const waist = Math.exp(-(((py + .64) / .22) ** 4))
        color.lerp(fold, .55 * waist * innerFace)
      }
      colors.push(color.r,color.g,color.b)
    }
    if(roundedUpper) {
      // Follow the actual three-dimensional turn with complete closed sections.
      // Horizontal author rows remain the material chart, not the sweep plane.
      const {rows,columns}=geometry.userData.roundedProfileSource
      const sections:{start:number;count:number;center:Vector3}[]=[]
      let start=0
      for(let row=0;row<=rows;row++) {
        const count=row===0||row===rows?1:columns,center=new Vector3()
        for(let column=0;column<count;column++)center.add(new Vector3().fromBufferAttribute(positions,start+column))
        sections.push({start,count,center:center.divideScalar(count)});start+=count
      }
      const centers=sections.map(section=>section.center.clone())
      // Fair only the interior guide; retain the physical root and end pole.
      for(let pass=0;pass<16;pass++) {
        const next=centers.map(p=>p.clone())
        for(let row=1;row<rows;row++)next[row].copy(centers[row-1]).multiplyScalar(.25).addScaledVector(centers[row],.5).addScaledVector(centers[row+1],.25)
        centers.forEach((p,row)=>p.copy(next[row]))
      }
      const blend=(pixel:number)=>{const t=MathUtils.clamp((pixel-195)/23,0,1);return t*t*t*(t*(6*t-15)+10)}
      centers.forEach((p,row)=>p.lerpVectors(sections[row].center,p.clone(),blend(175.4-sections[row].center.y/UNIT)))
      const down=new Vector3(0,-1,0),rotation=new Quaternion(),identity=new Quaternion(),offset=new Vector3()
      let minimumRadiusScale=1,maximumGuideShift=0
      for(let row=1;row<rows;row++) {
        const section=sections[row],center=centers[row],pixel=175.4-section.center.y/UNIT,amount=blend(pixel)
        const first=centers[Math.max(0,row-2)],last=centers[Math.min(rows,row+2)],tangent=last.clone().sub(first).normalize()
        const ab=center.clone().sub(first),ac=last.clone().sub(first),bc=last.clone().sub(center),denominator=ab.length()*ac.length()*bc.length()
        const curvature=denominator>1e-15?2*ab.cross(ac).length()/denominator:0
        const bendDirection=bc.clone().normalize().sub(center.clone().sub(first).normalize())
        bendDirection.addScaledVector(tangent,-bendDirection.dot(tangent)).normalize()
        const innerRadius=curvature>1e-8?.65/curvature:1e8
        maximumGuideShift=Math.max(maximumGuideShift,center.distanceTo(section.center))
        rotation.setFromUnitVectors(down,tangent).slerp(identity,1-amount)
        for(let column=0;column<section.count;column++) {
          const index=section.start+column
          offset.fromBufferAttribute(positions,index).sub(section.center).applyQuaternion(rotation)
          // Only the concave side needs curvature clearance. Retain the
          // drawn convex rail instead of shrinking the entire cross-section.
          const length=offset.length(),inside=Math.max(0,offset.dot(bendDirection))
          offset.addScaledVector(bendDirection,-amount*(inside-innerRadius*Math.tanh(inside/innerRadius)))
          minimumRadiusScale=Math.min(minimumRadiusScale,length>1e-12?offset.length()/length:1)
          offset.add(center)
          positions.setXYZ(index,offset.x,offset.y,offset.z)
        }
      }
      geometry.userData.profileNormalSections={authorRootHeldThrough:195,fullyOrientedFrom:218,sourceCenterlineFairedPasses:16,minimumRadiusScale,maximumGuideShift,curvatureRadiusLimit:.65,concaveOnly:true,convexRailRadiusHeld:true,completeSectionRotation:true,noCameraInput:true}
    }
    if(roundedSide||roundedUpperBacking||roundedUpper) {
      const {rows,columns}=geometry.userData.roundedProfileSource
      const anchors:number[]=[]
      let offset=0
      for(let row=0;row<=rows;row++) {
        const count=row===0||row===rows?1:columns,center=new Vector3()
        for(let column=0;column<count;column++)center.add(new Vector3().fromBufferAttribute(positions,offset+column))
        center.divideScalar(count)
        for(let column=0;column<count;column++)anchors.push(center.x,center.y,center.z)
        offset+=count
      }
      geometry.setAttribute('curlSectionAnchor',new Float32BufferAttribute(anchors,3))
    }
    geometry.setAttribute('color',new Float32BufferAttribute(colors,3))
    if (view==='back') {
      geometry.setAttribute('rearPaintPoint',new Float32BufferAttribute(rearPoints,3))
      geometry.setAttribute('hairContour',new Float32BufferAttribute(contourDistances,2))
    }
    if(view==='right') {
      const indices=geometry.index!
      for(let i=0;i<indices.count;i+=3) {
        const b=indices.getX(i+1);indices.setX(i+1,indices.getX(i+2));indices.setX(i+2,b)
      }
    }
    geometry.computeVertexNormals()
    geometry.computeBoundingSphere()
    if(view==='back'&&surface.underlay)geometry=crownBackingOnly(geometry,crownAnchors,backingSource)
    if(roundedUpper||roundedUpperBacking)geometry.userData.upperProfileVolume={sourceStart:[...start],closedLens:true,sectionThickness:roundedUpper?.115:.085,noCameraInput:true};
    let lockPaint=roundedSource?hemPaint:view==='back'?rearPaint:material
    if(view==='back'&&surface.waistFlow&&glintPath) {
      const outline=shape.getPoints(16).map(p=>sculpt(p.x,p.y,1,0))
      const glintCurve=new CatmullRomCurve3(glintPath.map(([x,y])=>new Vector3(x,y,0)),false,'catmullrom',.25)
      const guide=glintCurve.getPoints(48).map(p=>sculpt(p.x,p.y,1,.5))
      lockPaint=rearFlowMaterial(outline,guide)
    }
    const authoredSideWave=sideView&&start[0]===758&&start[1]===194
    let finalGeometry=geometry
    if(authoredSideWave) {
      finalGeometry=authoredSideWaveGeometry(sculpt(x(start[0]),y(start[1]),1,0),view==='left'?1:-1,tint)
      geometry.dispose()
    }
    const mesh=authoredSideWave?sideWaveRootMesh(finalGeometry,lockPaint,parent):anchoredCrown?crownRootMesh(geometry,lockPaint,parent,crownAnchors):roundedUpper?sideWaveRootMesh(geometry,lockPaint,parent):roundedUpperBacking?lowerReturnMesh(geometry,lockPaint,parent,[175,310],true):roundedSide?lowerReturnMesh(geometry,lockPaint,parent):new Mesh(geometry,lockPaint)
    mesh.name=`sculpted-hair-${view}`
    if(view==='back'&&(surface.waistFlow||surface.waistTuft))geometry.userData.authoredRearFlow={sourceStart:[...start],sourcePixelStart:235,fullyAuthoredAfter:260,normalThickness:true,noCameraInput:true}
    if(roundedSide)mesh.userData.preserveCurlSections=true
    if((view==="left"||view==="right")&&start[0]===741&&start[1]===204)mesh.userData.junctionOld=true
    parent.add(mesh)
    const replaceSideMain=(view==='left'||view==='right')&&start[0]===741&&start[1]===204
    if(replaceSideMain) {
      const original=mesh.geometry
      if(settled)original.morphAttributes.position=[settled]
      const rounded=sculptSideMainGeometry(original,(parent.children.find(o=>o instanceof Mesh&&o.name==='hem-main-curl'&&Math.sign(o.geometry.attributes.position.getX(0))===(view==='left'?1:-1)) as Mesh).geometry,view==='left'?1:-1,tint??0x697ee2)
      const target=curlSettlementGeometry(rounded,original)
      mesh.geometry=rounded
      if(target)addSettlement(mesh,target)
      original.dispose()
    } else if(roundedSide) {
      // The adjacent shoulder leaf uses the same physical-root contract as
      // the mainS, without the old side projection and lower flattening.
      const original=mesh.geometry
      if(settled)original.morphAttributes.position=[settled]
      const rounded=guidedShoulderCompanionGeometry(original,view==='left'?1:-1,tint??0x6e80eb)
      // The shoulder root follows the head; the long return settles with the hips.
      lowerReturnWeights(rounded)
      const target=curlSettlementGeometry(rounded,original)
      mesh.geometry=rounded
      if(target){preserveSettlementSections(rounded,target);addSettlement(mesh,target)}
      original.dispose()
    } else if (settled) {
      const target = new BufferGeometry()
      target.setIndex(geometry.index)
      target.setAttribute('position', settled)
      if(roundedSide)preserveSettlementSections(geometry,target)
      target.computeVertexNormals()
      addSettlement(mesh, target)
    }
    if (surface.underlay || view==='back' || roundedSide) return
    const edgeBoundary = fineContour ? shape.getPoints(32) : boundary
    function edgeCurve(root?: LockRoot) {
      const authored=mesh.geometry.userData.authoredProfileOutline as number[][]|undefined
      if(authored)return new CatmullRomCurve3(authored.map(p=>new Vector3().fromArray(p)),false,'catmullrom',.15)
      const seam = edgeBoundary.slice(0, -1).map(point => sculpt(point.x, point.y, roundedUpper?.5:1, 0, root))
      return new CatmullRomCurve3(seam, true, 'catmullrom', .15)
    }
    const contour = edgeCurve()
    const edgeSegments = Math.min(500, (edgeBoundary.length - 1) * 3)
    const edgeGeometry = new TubeGeometry(contour, edgeSegments, authoredSideWave?.00085:.0024, 5, !authoredSideWave)
    const edge = authoredSideWave||roundedUpper?sideWaveRootMesh(edgeGeometry,ink,parent):new Mesh(edgeGeometry,ink)
    if(roundedUpper)edge.name=`upper-profile-contour-${view}`
    if(mesh.userData.junctionOld)edge.userData.junctionOldEdge=true
    parent.add(edge)
    if (settledRoot) {
      const settledContour = edgeCurve(settledRoot)
      // Keep each outline vertex at the same authored point of the lock.
      // Resampling both ends by their own length would slide the outline
      // along the surface while the two shapes are being interpolated.
      settledContour.getUtoTmapping = contour.getUtoTmapping.bind(contour)
      addSettlement(edge, new TubeGeometry(settledContour, edgeSegments, .0024, 5, true))
    }
  }

  function pair(start: readonly [number,number], curves: readonly Curve[], layer: number, tint: number, underlay = false) {
    patch('front',start,curves,layer,tint,{ underlay })
    const right = (x: number, y: number): [number, number] => {
      const lower = Math.max(0, Math.min(1, (y - 186) / 65))
      const width = 1 - .09 * lower
      return [257 + (257 - x) * width, y + 2.7 * lower * Math.sin((y - 204) / 42)]
    }
    patch('front', right(...start), curves.map(([a, b, c, d, e, f]) => [...right(a, b), ...right(c, d), ...right(e, f)]), layer, tint, { underlay })
  }

  // A continuous lock follows its centerline around the head. Its lens
  // section rolls with the turn and stays narrow at both edges.
  function sweptCurl(side: number, guide: CurlGuide, facing: number, tint: number,
    { width = 1, drape = true, outline = false, rearRoot = false, regularSections = false, waistTwist = false } = {}) {
    const path = new CatmullRomCurve3(guide.map(([x,y,z]) =>
      new Vector3((x - 257) * UNIT * side * width, (175.4 - y) * UNIT, z)))
    const section = new CatmullRomCurve3(guide.map(([, , , width, depth]) => new Vector3(width,depth,0)))
    const positions: number[] = [], indices: number[] = [], colors: number[] = []
    const rows = 80, columns = 28
    const front = new Vector3(-.65 * side, .06, facing)
    const rootTone = new Color(0x4a5ab4), middle = new Color(tint), highlight = new Color(0x92a0ed), color = new Color()
    for (let row = 0; row <= rows; row++) {
      const t = row / rows
      const center = path.getPoint(t)
      const tangent = path.getTangent(t)
      const across = new Vector3().crossVectors(front, tangent).normalize()
      const outward = new Vector3().crossVectors(tangent, across).normalize()
      const { x: width, y: depth } = section.getPoint(t)
      for (let column = 0; column < columns; column++) {
        const angle = 2 * Math.PI * column / columns
        const edge = Math.cos(angle), face = Math.sin(angle)
        const radius = width * Math.sign(edge) * Math.abs(edge) ** .81
        const position = center.clone().addScaledVector(across, radius).addScaledVector(outward, depth * face)
        position.x = lowerLockWidth(position.x, position.y)
        const point = drape ? gatherHemTips(tuckBehindLowerCurls(drapeAroundDress(position.x, position.y, position.z))) : position
        seatBehindMiddleWave(point)
        positions.push(point.x, point.y, point.z)
        const sheen = Math.exp(-(((edge + .36 - .20 * Math.sin(t * 9)) / .29) ** 2))
        color.copy(rootTone).lerp(middle, .32 + .67 * Math.abs(face) ** .64)
        color.lerp(highlight, sheen * Math.max(0, face) * .29)
        colors.push(color.r, color.g, color.b)
        if (row < rows) {
          const a = row * columns + column, b = row * columns + (column + 1) % columns
          indices.push(a, b, a + columns, b, b + columns, a + columns)
        }
      }
    }
    if(facing>0||regularSections) {
      // Build a smooth lower centreline and parallel-transport one material
      // frame along it. Independently projecting each old axis can reverse
      // at the return; one transported frame keeps the closed tube ordered.
      const centres:Vector3[]=[],firstAxis:Vector3[]=[],secondAxis:Vector3[]=[]
      for(let row=0;row<=rows;row++){
        const centre=new Vector3(),a=new Vector3(),b=new Vector3()
        for(let column=0;column<columns;column++)centre.add(new Vector3().fromArray(positions,3*(row*columns+column)))
        centre.divideScalar(columns)
        for(let column=0;column<columns;column++){
          const angle=2*Math.PI*column/columns,p=new Vector3().fromArray(positions,3*(row*columns+column)).sub(centre)
          a.addScaledVector(p,2*Math.cos(angle)/columns);b.addScaledVector(p,2*Math.sin(angle)/columns)
        }
        centres.push(centre);firstAxis.push(a);secondAxis.push(b)
      }
      for(let pass=0;pass<3;pass++){
        const next=centres.map(p=>p.clone())
        for(let row=42;row<rows;row++){
          const q=Math.max(0,Math.min(1,(row/rows-.52)/.16)),blend=q*q*(3-2*q)
          next[row].lerp(centres[row-1].clone().addScaledVector(centres[row],2).add(centres[row+1]).multiplyScalar(.25),blend)
        }
        centres.forEach((p,i)=>p.copy(next[i]))
      }
      const frameRoot=regularSections?44:0
      let previousTangent=centres[frameRoot+1].clone().sub(centres[Math.max(0,frameRoot-1)]).normalize()
      const u=firstAxis[frameRoot].clone().addScaledVector(previousTangent,-firstAxis[frameRoot].dot(previousTangent)).normalize()
      for(let row=frameRoot+1;row<=rows;row++){
        const t=row/rows,q=Math.max(0,Math.min(1,(t-(regularSections?.58:.30))/(regularSections?.07:.18)))
        const end=Math.max(0,Math.min(1,(t-(regularSections?.73:.80))/(regularSections?.09:.14)))
        const blend=q*q*(3-2*q)*(regularSections?1-end*end*(3-2*end):1)
        const before=centres[Math.max(0,row-1)],centre=centres[row],after=centres[Math.min(rows,row+1)],tangent=after.clone().sub(before).normalize()
        const axis=previousTangent.clone().cross(tangent),sine=axis.length(),cosine=Math.max(-1,Math.min(1,previousTangent.dot(tangent)))
        if(sine>1e-10)u.applyAxisAngle(axis.multiplyScalar(1/sine),Math.atan2(sine,cosine))
        u.addScaledVector(tangent,-u.dot(tangent)).normalize();previousTangent.copy(tangent)
        const v=new Vector3().crossVectors(tangent,u).normalize(),width=firstAxis[row].length(),depth=secondAxis[row].length()
        const ab=centre.clone().sub(before),ac=after.clone().sub(before),bc=after.clone().sub(centre),den=ab.length()*ac.length()*bc.length()
        const curvature=den>1e-15?2*ab.cross(ac).length()/den:0
        let reach=Infinity
        for(let other=0;other<=rows;other++){
          if(Math.abs(other-row)<=1)continue
          const otherTangent=centres[Math.min(rows,other+1)].clone().sub(centres[Math.max(0,other-1)]).normalize()
          const chord=centres[other].clone().sub(centre),distance=chord.length()
          if(tangent.dot(otherTangent)<.85||(Math.abs(chord.dot(tangent))<.5*distance&&Math.abs(chord.dot(otherTangent))<.5*distance))reach=Math.min(reach,.38*distance)
        }
        const scale=Math.min((1+(Math.max(width,depth)*curvature/.60)**6)**(-1/6),reach/Math.max(width,depth))
        if(!blend)continue
        for(let column=0;column<columns;column++){
          const angle=2*Math.PI*column/columns,index=3*(row*columns+column),p=centre.clone().addScaledVector(u,width*scale*Math.cos(angle)).addScaledVector(v,depth*scale*Math.sin(angle))
          const fold=Math.max(0,Math.min(1,(-side*Math.cos(angle)+.10)/.80))
          const localBlend=blend*(regularSections?fold*fold*(3-2*fold):1)
          positions[index]+=(p.x-positions[index])*localBlend;positions[index+1]+=(p.y-positions[index+1])*localBlend;positions[index+2]+=(p.z-positions[index+2])*localBlend
        }
      }
    }
    // The roots and tips are solid even where the ends of a curl peek out.
    const end = rows * columns
    for (let column = 1; column < columns - 1; column++) {
      indices.push(0, column + 1, column, end, end + column, end + column + 1)
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    if(rearRoot) {
      // The upper loop joins the broad rear lock. Keep its rear-facing
      // pigment continuous with that lock instead of shading a dark root
      // onto the middle of the hairstyle. This color stays on the volume.
      const normals=geometry.attributes.normal,paint=geometry.attributes.color
      const rearTone=new Color(0x7182e6)
      for(let i=0;i<geometry.attributes.position.count;i++) {
        const pixel=175.4-geometry.attributes.position.getY(i)/UNIT
        const smooth=(n:number,a:number,b:number)=>{const t=Math.max(0,Math.min(1,(n-a)/(b-a)));return t*t*(3-2*t)}
        const root=smooth(pixel,188,199)*(1-smooth(pixel,224,231))
        const back=smooth(-normals.getZ(i),.05,.55)
        color.fromBufferAttribute(paint,i).lerp(rearTone,.96*root*back)
        paint.setXYZ(i,color.r,color.g,color.b)
      }
    }
    sweptHairFlowChart(geometry,rows,columns)
    if(waistTwist){
      // Preserve the authored procedural strand chart while sculpting the
      // closed inner return in depth. No camera enters this fixed volume.
      const points=geometry.attributes.position
      for(let row=0;row<=rows;row++){
        const t=row/rows,rise=MathUtils.smoothstep(t,.54,.57),fall=1-MathUtils.smoothstep(t,.65,.72)
        for(let column=0;column<columns;column++){
          const angle=2*Math.PI*column/columns,inner=MathUtils.smoothstep(-side*Math.cos(angle),.70,.95)
          const index=row*columns+column
          points.setZ(index,positions[3*index+2]+.30*(t-.60625)*rise*fall*inner)
        }
      }
      points.needsUpdate=true
      geometry.computeVertexNormals()
    }
    const mesh = new Mesh(geometry, hairFlowMaterial(outline ? outlined : material))
    mesh.name = facing < 0 ? 'rear-swept-curl' : 'shoulder-swept-curl'
    parent.add(mesh)
  }

  const shoulder: CurlGuide = [
    [179,194,-.28,.021,.015], [166,226,-.36,.049,.026],
    [157,249,-.47,.061,.032], [151,257,-.505,.067,.034],
    [120,273,-.55,.078,.037],
    [106,298,-.60,.076,.036], [112,321,-.55,.069,.026],
    [114,340,-.48,.051,.019], [98,348,-.45,.027,.010],
    [91,337,-.43,.001,.001],
  ]
  const upperLoop: CurlGuide = [
    [174,198,-.243,.014,.010], [167,211,-.257,.029,.014],
    [148,222,-.281,.038,.018], [133,231,-.293,.043,.021],
    [127,241,-.293,.042,.019], [127,249,-.290,.038,.018],
    [135,256,-.281,.031,.014], [154,261,-.280,.012,.008],
  ]
  const rearLoop: CurlGuide = [
    [214,166,-.436,.009,.010], [220,178,-.580,.019,.013],
    [223,190,-.705,.036,.017], [223,201,-.772,.043,.018],
    [224,212,-.783,.035,.016], [222,220,-.772,.031,.015],
    [219,225,-.740,.024,.014], [218,230,-.690,.009,.010],
  ]
  const middleLoop: CurlGuide = [
    [221,217,-.626,.009,.007], [209,230,-.729,.027,.012],
    [191,242,-.808,.041,.017], [178,252,-.856,.044,.019],
    [173,264,-.886,.037,.017], [167,273,-.883,.032,.015],
    [162,281,-.844,.022,.012], [157,286,-.768,.009,.008],
  ]
  const waistLoop: CurlGuide = [
    [146,262,-.422,.021,.010], [124,278,-.423,.046,.013],
    [109,289,-.438,.065,.014], [104,299,-.437,.076,.013],
    [102,308,-.440,.068,.011], [103,316,-.434,.045,.011],
    [111,322,-.418,.042,.011], [130,328,-.399,.031,.010],
    [145,332,-.405,.009,.006],
  ]
  const lowerHook: CurlGuide = [
    [140,322,-.552,.019,.009], [129,334,-.511,.031,.013],
    [121,344,-.471,.038,.015], [112,351,-.435,.031,.013],
    [104,351,-.419,.028,.012], [97,346,-.411,.022,.010],
    [93,342,-.408,.013,.007], [91,338.5,-.409,.0015,.0015],
  ]

  // Low layers and hooked ends. Their shapes stay behind the sleeves.
  pair([184,181],[
    [170,207,169,224,151,248],[123,271,103,295,115,317],
    [132,323,168,297,187,274],[195,235,197,200,184,181],
  ],-.115,0x5269c4,true)
  pair([183,209],[
    [170,235,143,258,136,281],[133,296,147,307,159,307],
    [174,300,182,279,188,261],[199,235,196,219,183,209],
  ],-.075,0x6077d2,true)
  pair([176,191],[
    [172,214,151,225,136,237],[122,249,127,258,143,260],
    [128,264,117,254,121,242],[122,226,147,215,157,202],
    [165,195,170,191,176,191],
  ],-.050,0x6b7ed9)
  pair([177,219],[
    [164,242,132,253,116,275],[102,292,108,313,127,320],
    [140,326,150,326,155,319],[140,319,128,309,133,295],
    [139,279,160,275,175,259],[188,244,186,231,177,219],
  ],-.010,0x6379d5)
  sweptCurl(-1, shoulder, .76, 0x697dd9, { width: .925 })
  sweptCurl(1, shoulder, .76, 0x697dd9)
  sweptCurl(-1, upperLoop, -.78, 0x687cd9, { width: .987 })
  sweptCurl(1, upperLoop, -.78, 0x687cd9)
  sweptCurl(-1, rearLoop, -.15, 0x6c7fdf, { rearRoot:true })
  sweptCurl(1, rearLoop, -.15, 0x6c7fdf, { rearRoot:true })
  // These arcs already clear the apron and meet the lower side waves.
  sweptCurl(-1, middleLoop, -.22, 0x687ddc, { drape: false })
  sweptCurl(1, middleLoop, -.22, 0x687ddc, { drape: false })
  for (const side of [-1, 1]) {
    sweptCurl(side, waistLoop, -1.9, 0x697dde, { drape: false, waistTwist:true })
    sweptCurl(side, lowerHook, -1.55, 0x667bda, { drape: false })
  }
  pair([168,263],[
    [151,279,127,287,119,309],[113,328,128,339,139,343],
    [132,333,139,320,153,306],[172,295,181,280,168,263],
  ],.016,0x5d74ce)
  // The underlying rear volume joins the visible locks while leaving the
  // apron bow and lower skirt exposed in the middle.
  patch('back',[257,78],[
    [207,76,176,117,181,177],[181,211,149,245,143,279],
    [136,316,146,350,173,406],[194,418,215,411,219,398],
    [214,367,203,335,211,306],[223,288,241,279,257,276],
    [273,279,291,288,303,306],[311,335,300,367,295,398],
    [299,411,320,418,341,406],[368,350,378,316,371,279],
    [365,245,333,211,333,177],[338,117,307,76,257,78],
  ],-.095,0x5b71d5,{ underlay: true, tailPassage: true })

  // Rear design. Broad locks are continuous from the part to their tips.
  for(const side of [-1,1]) {
    const rear=(start: readonly [number,number],curves: readonly Curve[],layer: number,tint?: number,glint?: Stroke,
      { variation = 1, ...surface }: Pick<LockSurface, 'waistFlow' | 'waistTuft'> & { variation?: number } = {})=> {
      const offset = (x: number, y: number): [number, number] => {
        const lower = Math.max(0, Math.min(1, (y - 167) / 120))
        return [257 + (x - 257) * side + 3.6 * variation * lower * Math.sin((y - 167) / 33), y + side * 3.1 * variation * lower]
      }
      patch('back', offset(...start), curves.map(([a,b,c,d,e,f]) =>
        [...offset(a,b), ...offset(c,d), ...offset(e,f)]), layer, tint, {
        glint: glint?.map(([x,y]) => offset(x,y)),
        ...surface,
      })
    }
    rear([257,77],[
      [218,74,190,102,183,143],[178,178,168,193,153,204],
      [165,212,184,202,194,190],[217,166,210,130,233,103],
      [239,91,248,82,257,77],
    ],-.025,0x6d80e7)
    rear([249,80],[
      [224,93,222,122,216,158],[213,194,191,212,170,228],
      [146,247,140,267,151,282],[154,265,170,253,185,248],
      [210,240,225,218,228,191],[233,163,232,132,240,108],
      [243,95,247,86,249,80],
    ],.004,0x6a7fec, [[239,106],[225,145],[216,187],[198,217],[177,237],[154,265]])
    rear([253,216],[
      [253,231,247,243,241,252],[236,260,235,266,239,270],
      [245,268,251,260,253,252],[256,239,255,225,253,216],
    ],-.006,side > 0 ? 0x5a70e6 : 0x5269d9,
    [[251,233],[246,247],[240,260],[239,267]], { waistTuft:true,variation:.25 })
    const crownTipX = side > 0 ? 193 : 195, crownTipY = side > 0 ? 307 : 313
    // The inner edges share one curved part, with a small overlap instead
    // of exposing the scalp as a straight groove between the two locks.
    const seam = (x:number) => 257+side*(x-257)+.8
    rear([257,80],[
      [232,80,217,115,215,153],[216,183,212,207,192,229],
      [177,247,163,267,166,286],[168,302,184,312,crownTipX,crownTipY],
      [side > 0 ? 185 : 192,side > 0 ? 306 : 309,188,300,195,287],[200,272,215,262,228,250],
      [239,249,248,241,seam(251),226],
      [seam(252),209,seam(259),190,seam(261),170],
      [seam(260),134,seam(257),104,257,80],
    ],side>0?.040:.035,0x6d81ed,
    [[247,105],[240,153],[234,193],[218,223],[199,246],[178,271],[177,289],[side > 0 ? 187 : 195,side > 0 ? 304 : 311]],
    { waistFlow:true,variation:.30 })
    // The middle wave continues below the bow, between the crown lock and
    // the outside hem curls. Its returning tip stays clear of the skirt.
    const middleWave = new Mesh(profileLockGeometry(side),outlined)
    middleWave.name = 'middle-wave-curl'
    parent.add(middleWave)
    lowerCurl(side,'hem-main',HEM_MAIN,[180,300],[
      [162,315,137,332,128,353],[112,371,116,391,130,403],
      [141,414,160,421,174,407],[162,413,164,405,164,396],
      [162,379,175,363,182,344],[192,324,190,311,180,300],
    ],0x6f83e8)
    lowerCurl(side,'hem-outer',HEM_OUTER,[128,329],[
      [113,338,102,349,99,363],[94,375,102,391,120,395],
      [111,385,114,373,120,366],[128,356,137,342,128,329],
    ],0x687edc)
    lowerCurl(side,'hem-inner',HEM_INNER,[183,340],[
      [168,360,164,382,170,398],[176,407,189,411,181,418],
      [198,422,208,411,211,401],[202,408,199,401,199,395],
      [199,378,208,363,205,352],[200,342,190,338,183,340],
    ],0x687ddd)
    sweptCurl(side, [
      [185,214,-.626,.020,.012], [172,235,-.668,.047,.024],
      [154,251,-.699,.065,.030], [139,270,-.658,.074,.031],
      [124,292,-.574,.073,.034], [129,306,-.55,.040,.020],
      [141,318,-.53,.002,.002],
    ], -.78, 0x6b7ee5, { regularSections:true })
  }

  // The profile waves have their own sculpted depth, joining the front and
  // back locks. They are not camera-facing cards and rotate with the head.
  for(const view of ['left','right'] as const) {
    const sideLock = (start: readonly [number, number], curves: readonly Curve[], layer: number, tint: number, glint: Stroke,
      surface: Pick<LockSurface, 'root' | 'depth'> = {}) =>
      patch(view, [512 + start[0], start[1]], curves.map(([a,b,c,d,e,f]) =>
        [512 + a,b,512 + c,d,512 + e,f]), layer, tint, { glint: glint.map(([x,y]) => [512 + x,y]), ...surface })
    patch(view,[692,80],[
      [701,83,709,96,710,113],[711,139,714,158,731,168],
      [719,176,706,173,697,163],[686,151,679,130,680,113],
      [680,96,686,87,692,80],
    ],.011,0x6375d1, {
      depth: (x, y) => {
        const root = Math.max(0, Math.min(1, (.53 - y) / .32))
        const temple = .115 + .314 * root * root * (3 - 2 * root)
        return temple - .092 * Math.max(0, -x / .20)
      },
    })
    patch(view,[746,155],[
      [750,180,785,185,811,202],[828,217,823,232,805,238],
      [826,248,853,261,855,281],[858,296,843,303,834,304],
      [818,310,789,302,770,288],
      [763,256,737,223,739,195],[740,180,741,164,746,155],
    ],-.065,0x687be3, {
      underlay: true,
      tailPassage: view === 'left',
      glint: [[754,218],[766,249],[785,277],[786,305],[779,331],[772,352],[776,380]],
      shadow: (x, y) => {
        const underCurl = Math.exp(-(((x - .31) / .19) ** 2))
        const lower = Math.max(0, Math.min(1, (-y - .62) / .43))
        return .68 * underCurl * lower * lower * (3 - 2 * lower)
      },
    })
    patch(view,[748,147],[
      [752,177,784,190,806,205],[830,222,839,238,815,252],
      [850,255,866,232,842,213],[821,190,785,177,777,151],
      [768,145,756,143,748,147],
    ],-.020,0x6b7fe0)
    patch(view,[758,194],[
      [757,224,790,239,814,254],[839,271,833,288,818,291],
      [843,299,862,280,849,260],[835,238,801,226,791,207],
      [783,194,767,189,758,194],
    ],.004,0x6076dc)
    sideLock([229,204],[
      [237,205,245,209,248,222],[256,242,272,249,294,259],
      [311,268,330,280,331,296],[332,313,316,327,292,327],
      [301,323,310,316,307,304],[305,292,288,284,270,276],
      [243,262,233,242,231,225],[228,216,227,209,229,204],
    ],.033,0x6a7beb, [[236,211],[244,231],[261,249],[287,265],[310,283],[321,301],[304,321]],
    { root: { inset: .055, forward: .028, drop: .040, settled: { inset: .104, forward: .055, drop: .105, delay: .19 } } })
    sideLock([231,223],[
      [237,251,265,263,286,275],[305,284,322,298,317,316],
      [309,330,285,347,264,344],[277,338,293,328,293,317],
      [300,301,279,291,260,280],[239,269,225,246,231,223],
    ],.066,0x6e80eb, [[233,235],[243,255],[268,273],[294,289],[307,307],[298,327],[274,340]],
    { root: { inset: .041, forward: .020, settled: { inset: .041, forward: .035, delay: .19 } } })
    sideLock([309,324],[
      [305,331,305,342,314,347],[322,351,330,349,332,341],
      [336,350,329,358,319,360],[309,361,301,353,299,343],
      [298,334,303,327,309,324],
    ],.024,0x697ee2, [[307,328],[305,340],[312,350],[324,351]])

  }
  for(const side of [-1,1]) {
    const meshes=parent.children.filter(o=>o instanceof Mesh) as Mesh[]
    const main=meshes.find(o=>o.name==='hem-main-curl'&&Math.sign(o.geometry.attributes.position.getX(0))===side)!
    const old=meshes.find(o=>o.userData.junctionOld&&Math.sign(o.geometry.attributes.position.getX(0))===side)!
    const upperGeometry=guidedContinuousSGeometry(old.geometry,side,0x6a7beb,'upper')
    const upper=new SkinnedMesh(upperGeometry,hemPaint)
    parent.add(upper);bindTorsoCurl(upper,parent,true)
    upper.name=side<0?'side-main-pointed-left':'side-main-pointed-right'
    // The torso-supported curl tucks its hidden stem under the upper hair
    // when the existing fin-clearance controller activates during a dive.
    const upperTucked=upperGeometry.clone(),upperPoints=upperTucked.attributes.position
    for(let j=0;j<upperPoints.count;j++) {
      const pixel=175.4-upperGeometry.attributes.curlSectionAnchor.getY(j)/UNIT
      const t=Math.max(0,Math.min(1,(pixel-276)/26)),inset=.400*(1-t*t*(3-2*t))
      upperPoints.setX(j,upperPoints.getX(j)-side*inset)
    }
    upperTucked.computeVertexNormals();addSettlement(upper,upperTucked)
    upper.userData.torsoCurlAnchor.headFinClearanceMorph={inboard:.400,heldThrough:276,endsAt:302,noCameraInput:true}
    const finSupports:{mesh:Mesh,corners:Vector3[]}[]=[]
    for(const finRoot of parent.parent!.children.filter(o=>o.name==='head-fin'))for(const finMesh of finRoot.children) {
      if(!(finMesh instanceof Mesh)||finMesh.geometry.type==='TubeGeometry')continue
      finMesh.geometry.computeBoundingBox();const box=finMesh.geometry.boundingBox!,corners:Vector3[]=[]
      for(const x of[box.min.x,box.max.x])for(const y of[box.min.y,box.max.y])for(const z of[box.min.z,box.max.z])corners.push(new Vector3(x,y,z))
      finSupports.push({mesh:finMesh,corners})
    }
    const curlFromWorld=new Matrix4(),boneOffset=new Matrix4(),finPoint=new Vector3()
    upper.userData.updateBluefishHairGeometry=()=>{
      curlFromWorld.elements.fill(0)
      for(let bone=0;bone<2;bone++) {
        boneOffset.multiplyMatrices(upper.skeleton.bones[bone].matrixWorld,upper.skeleton.boneInverses[bone])
        for(let k=0;k<16;k++)curlFromWorld.elements[k]+=.5*boneOffset.elements[k]
      }
      curlFromWorld.multiply(upper.bindMatrix).invert()
      let minimumY=Infinity
      for(const support of finSupports)for(const corner of support.corners) {
        finPoint.copy(corner).applyMatrix4(support.mesh.matrixWorld).applyMatrix4(curlFromWorld)
        minimumY=Math.min(minimumY,finPoint.y)
      }
      const finEnd=175.4-minimumY/UNIT,t=Math.max(0,Math.min(1,(finEnd-208)/16))
      upper.morphTargetInfluences![0]=t*t*(3-2*t)
    }
    upper.userData.torsoCurlAnchor.clearanceDriver={primaryFinMeshes:finSupports.length,posedBoundingBoxes:true,startsAt:208,fullyTuckedAt:224,noCameraInput:true}

    const joined=guidedContinuousSGeometry(old.geometry,side,0x6f83e8,'lower')
    joined.userData.authoringSampler=main.geometry.userData.authoringSampler
    lowerReturnWeights(joined,204,360)
    main.geometry.dispose();main.geometry=joined
    bindTorsoCurl(main,parent)
    const settled=curlSettlementGeometry(joined,old.geometry)
    if(settled){preserveSettlementSections(joined,settled);addSettlement(main,settled)}
    const inner=meshes.find(o=>o.name==='hem-inner-curl'&&Math.sign(o.geometry.attributes.position.getX(0))===side)!
    const previousInner=inner.geometry
    inner.geometry=guidedInnerReturnGeometry(side,0x687ddd,joined)
    bindTorsoCurl(inner,parent)
    previousInner.dispose()
    parent.remove(old);old.geometry.dispose()
    for(const edge of meshes.filter(o=>o.userData.junctionOldEdge&&Math.sign(o.geometry.attributes.position.getX(0))===side)){parent.remove(edge);edge.geometry.dispose();const i=shoulderLocks.indexOf(edge);if(i>=0)shoulderLocks.splice(i,1)}
    const i=shoulderLocks.indexOf(old);if(i>=0)shoulderLocks.splice(i,1)
  }
  const backingCrown=(parent.children.find(o=>o instanceof Mesh&&o.geometry.userData.rearBackingCrop) as Mesh).geometry
  neckBackingMesh(backingCrown,hemPaint,parent)
  for(const side of [-1,1]) {
    const geometry=innerBackingGeometry(backingCrown,side,0x6579d5)
    const mesh=lowerReturnMesh(geometry,hemPaint,parent)
    mesh.name=side<0?'rear-inner-volume-left':'rear-inner-volume-right'
    mesh.userData.innerBackingVolume=true
    if(side<0)middleJunctionMesh(backingCrown,geometry,side,hemPaint,parent)
  }
  for(const object of parent.children) {
    if(!(object instanceof Mesh)||!object.geometry.attributes.curlSectionAnchor)continue
    const geometry=object.geometry
    hairFlowChart(geometry,geometry.attributes.curlSectionAnchor as Float32BufferAttribute)
    object.material=hairFlowMaterial(object.material as MeshPhongMaterial)
  }
  return shoulderLocks
}
