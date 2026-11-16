import { BufferGeometry, Color, Float32BufferAttribute, Vector3 } from 'three'
import { profileFrontDepth, refineProfile } from './profile-geometry.ts'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

type Ring = (angle: number) => Vector3

function loft(rings: readonly Ring[], sides = 80) {
  const positions: number[] = [], indices: number[] = []
  for (let row = 0; row < rings.length; row++) {
    for (let side = 0; side < sides; side++) {
      const point = rings[row](side * Math.PI * 2 / sides)
      positions.push(point.x, point.y, point.z)
      if (row === rings.length - 1) continue
      const a = row * sides + side, b = row * sides + (side + 1) % sides
      indices.push(a, b, a + sides, b, b + sides, a + sides)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

const signedPower = (value: number, power: number) => Math.sign(value) * Math.abs(value) ** power

function shoeRing(width: number, length: number, center: number, height: number, heelRise = 0, toeRise = 0, footSide = 0, medialInset = 1): Ring {
  return angle => {
    const direction = Math.cos(angle)
    const across = Math.sin(angle)
    const z = center + length * signedPower(direction, 1.25)
    const inset = across * footSide < 0 ? .50 * medialInset * Math.abs(direction) ** .71 : 0
    const x = width * signedPower(across, 1.17) * (1 + .07 * direction) * (1 - inset)
    return new Vector3(x, height + heelRise * Math.max(0, -direction) + toeRise * Math.max(0, direction) ** 2, z)
  }
}

/** A rounded toe with a separate outsole and an open instep. */
export function bluefishShoe(side: number) {
  const ring = (width: number, length: number, center: number, height: number, heelRise = 0, toeRise = 0) =>
    shoeRing(width * 1.05, length * 1.04, center, height, heelRise, toeRise, side)
  const neckRing=(width:number,length:number,center:number,height:number,heel:number,toe:number,inset:number)=>
    shoeRing(width*1.05,length*1.04,center,height,heel,toe,side,inset)
  const soleTurn = (x: number, z: number) => {
    const along = (z - .071) / (.171 * 1.04), across = x / (.113 * 1.05)
    return .008 * Math.max(0, -along) ** 2 + .006 * across * across
      - .002 * Math.max(0, along) ** 2
  }
  const sole = loft([
    ...Array.from({ length: 13 }, (_, i) => ring(.099 * i / 12, .154 * i / 12, .071, -.118)),
    ring(.107, .163, .071, -.114),
    ring(.112, .169, .071, -.106),
    ring(.113, .171, .071, -.092),
    ring(.109, .166, .071, -.084),
    ring(0, 0, .071, -.084),
  ])
  const solePoints = sole.attributes.position
  for (let i = 0; i < solePoints.count; i++) {
    const x = solePoints.getX(i), y = solePoints.getY(i), z = solePoints.getZ(i)
    const underside = Math.max(0, (-y - .084) / .034)
    const arch = .017 * Math.exp(-(((z + .018) / .033) ** 2))
    const rim = Math.max(0, Math.min(1, (y + .118) / .034))
    // Fair the underside recess without moving the sewn upper rim.
    const tread=Math.max(0,Math.min(1,(underside-.65)/.35))
    const shallowArch=(.007/.017)*arch*tread*tread*(3-2*tread)
    solePoints.setY(i, y + underside ** 1.35 * arch - shallowArch + rim * soleTurn(x, z))
  }
  sole.computeVertexNormals()
  const upperRings: Ring[] = [
    ring(.109, .162, .071, -.093),
    ring(.111, .167, .071, -.085),
    ring(.111, .168, .071, -.075),
    ring(.113, .167, .071, -.066, .002, .001),
    ring(.112, .164, .070, -.058, .005, .004),
    ring(.112, .160, .069, -.049, .008, .007),
    ring(.108, .154, .067, -.040, .011, .011),
    ring(.107, .145, .061, -.029, .015, .013),
    neckRing(.103, .134, .054, -.018, .020, .013, 0.75),
    neckRing(.098, .122, .045, -.007, .023, .011, 0.45),
    neckRing(.091, .107, .034, .005, .025, .007, 0.2),
    neckRing(.083, .090, .014, .025, .025, -.035, 0),
    neckRing(.071, .075, .009, .037, .019, -.050, 0),
    neckRing(.066, .069, .009, .009, .014, -.023, 0),
  ]
  // Interpolate the real cross sections without adding extrema. The toe
  // turns continuously between its author rings while both open rims stay fixed.
  const sectionSlope = (a:number,b:number) => a*b<=0 ? 0 : 2*a*b/(a+b)
  const upperSource = loft(Array.from({length:(upperRings.length-1)*4+1},(_,i):Ring => angle => {
    const row=Math.min(upperRings.length-2,Math.floor(i/4)),t=i/4-row
    const a=upperRings[row](angle),b=upperRings[row+1](angle)
    const before=upperRings[Math.max(0,row-1)](angle),after=upperRings[Math.min(upperRings.length-1,row+2)](angle)
    const p=new Vector3()
    for(const axis of ['x','y','z'] as const){
      const d=b[axis]-a[axis]
      const m0=row===0?d:sectionSlope(a[axis]-before[axis],d)
      const m1=row===upperRings.length-2?d:sectionSlope(d,after[axis]-b[axis])
      p[axis]=(2*t**3-3*t*t+1)*a[axis]+(t**3-2*t*t+t)*m0+(-2*t**3+3*t*t)*b[axis]+(t**3-t*t)*m1
    }
    return p
  }))
  const upper = refineProfile(upperSource, .008)
  upperSource.dispose()
  const shoeColors: number[] = []
  const upperColor = new Color(0x424e92), seamColor = new Color(0x343e7c)
  const toeColor = new Color(0x5261a1), color = new Color()
  const upperPoints = upper.attributes.position
  for (let i = 0; i < upperPoints.count; i++) {
    const x = upperPoints.getX(i), y = upperPoints.getY(i), z = upperPoints.getZ(i)
    // Give the forefoot room beneath the band while retaining the
    // heel counter and the shoe's horizontal outline.
    const forefoot = Math.max(0, Math.min(1, (z - .090) / .120))
    const vamp = Math.max(0, Math.min(1, (y + .060) / .060))
    const soleBlend = 1 - Math.max(0, Math.min(1, (y + .084) / .039))
    upperPoints.setY(i, y - .012 * forefoot * forefoot * (3 - 2 * forefoot) * vamp
      + soleBlend * soleTurn(x, z))
    const seam = Math.exp(-(((y + .087) / .011) ** 2))
    const shine = Math.exp(-(((x + side * .028) / .026) ** 2)
      - (((y + .022) / .018) ** 2) - (((z - .195) / .036) ** 2))
    color.copy(upperColor).lerp(seamColor, .40 * seam).lerp(toeColor, .27 * shine)
    shoeColors.push(color.r, color.g, color.b)
  }
  upper.setAttribute('color', new Float32BufferAttribute(shoeColors, 3))
  // A rounded longitudinal crown reaches the toe while the sole boundary stays fixed.
  const topSurface = upper.clone()
  const topPoints = topSurface.attributes.position, topIndices = topSurface.index!
  for (let i = 0; i < topPoints.count; i++) {
    const height = topPoints.getY(i)
    topPoints.setY(i, topPoints.getZ(i)); topPoints.setZ(i, height)
  }
  for (let i = 0; i < topIndices.count; i += 3) {
    const b = topIndices.getX(i + 1)
    topIndices.setX(i + 1, topIndices.getX(i + 2)); topIndices.setX(i + 2, b)
  }
  const sampleTop = profileFrontDepth(topSurface)
  for (let i = 0; i < upperPoints.count; i++) {
    const z = upperPoints.getZ(i), y = upperPoints.getY(i)
    if (z <= .120) continue
    const originalTop = sampleTop(0, z)
    if (originalTop === undefined) continue
    const across = (z - .120) / .145
    const crown = -.090 + .105 * Math.sqrt(Math.max(0, 1 - across * across))
    const t = Math.max(0, Math.min(1, (z - .120) / .030))
    const delta = Math.max(0, crown - originalTop) * t * t * (3 - 2 * t)
    const x = upperPoints.getX(i), localTop = sampleTop(x, z)
    if (localTop === undefined) continue
    const floor = -.093 + soleTurn(x, z), thickness = localTop - floor
    if (thickness <= .001) continue
    const localHeight = Math.max(0, Math.min(1, (y - floor) / thickness))
    const solid = Math.max(0, Math.min(1, (thickness - .001) / .008))
    upperPoints.setY(i, y + delta * localHeight * solid * solid * (3 - 2 * solid))
  }
  topSurface.dispose()
  for (let i = 0; i < upperPoints.count; i++) {
    const z = upperPoints.getZ(i), y = upperPoints.getY(i)
    const fore = Math.max(0, Math.min(1, (z - .180) / .060))
    const roll = Math.max(0, Math.min(1, (y + .084) / .045))
    upperPoints.setZ(i, z + .0015 * fore * fore * (3 - 2 * fore) * roll * roll * (3 - 2 * roll))
  }
  upper.computeVertexNormals()
  const upperNormals = upper.attributes.normal, upperIndices = upper.index!
  const neighbors = Array.from({ length: upperPoints.count }, () => new Set<number>())
  for (let i = 0; i < upperIndices.count; i += 3) for (let edge = 0; edge < 3; edge++) {
    const a = upperIndices.getX(i + edge), b = upperIndices.getX(i + (edge + 1) % 3)
    neighbors[a].add(b); neighbors[b].add(a)
  }
  // Fair the actual toe surface while locking its sole and instep boundaries.
  const edgeUse = new Map<string, number>()
  for (let i = 0; i < upperIndices.count; i += 3) for (let e = 0; e < 3; e++) {
    const a = upperIndices.getX(i + e), b = upperIndices.getX(i + (e + 1) % 3)
    const key = Math.min(a, b) + ':' + Math.max(a, b)
    edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1)
  }
  const boundary = new Set<number>()
  for (const [edge, count] of edgeUse) if (count === 1) for (const i of edge.split(':').map(Number)) boundary.add(i)
  const smoothstep = (t: number) => { const s = Math.max(0, Math.min(1, t)); return s * s * (3 - 2 * s) }
  const capWeights = Array.from({ length: upperPoints.count }, (_, i) => boundary.has(i) ? 0
    : smoothstep((upperPoints.getZ(i) - .170) / .050) * smoothstep((upperPoints.getY(i) + .084) / .035))
  for (let i = 0; i < upperPoints.count; i++) {
    upperPoints.setY(i, upperPoints.getY(i) + .010 * capWeights[i])
    upperPoints.setZ(i, upperPoints.getZ(i) + .002 * capWeights[i])
  }
  for (let pass = 0; pass < 12; pass++) for (const rate of [.45, -.47]) {
    const next = new Float32Array(upperPoints.array)
    for (let i = 0; i < upperPoints.count; i++) {
      if (!capWeights[i]) continue
      let sx = 0, sy = 0, sz = 0
      for (const j of neighbors[i]) {
        sx += upperPoints.getX(j); sy += upperPoints.getY(j); sz += upperPoints.getZ(j)
      }
      const inv = 1 / neighbors[i].size, amount = rate * capWeights[i]
      const x = upperPoints.getX(i), y = upperPoints.getY(i), z = upperPoints.getZ(i)
      next[i * 3] = x + (sx * inv - x) * amount
      next[i * 3 + 1] = y + (sy * inv - y) * amount
      next[i * 3 + 2] = z + (sz * inv - z) * amount
    }
    upperPoints.array.set(next)
  }
  const instepDrop=(_x:number,y:number,z:number) => .016*smoothstep((z-.025)/.050)
    *smoothstep((y+.080)/.055)
  for(let i=0;i<upperPoints.count;i++){
    const x=upperPoints.getX(i),y=upperPoints.getY(i),z=upperPoints.getZ(i)
    upperPoints.setY(i,y-instepDrop(x,y,z))
  }
  // Restore the toe crown independently of the open instep. The fixed
  // front support keeps the band, collar and sewn sole boundary in place.
  for(let i=0;i<upperPoints.count;i++){
    const y=upperPoints.getY(i),z=upperPoints.getZ(i)
    const crown=smoothstep((z-.120)/.035)*smoothstep((y+.070)/.030)
    const foreCrown=smoothstep((z-.165)/.025)*smoothstep((y+.070)/.030)
    const height=y+.004*crown+.010*foreCrown
    upperPoints.setY(i,height)
    // Round the physical front wall into the crown. Keep the sewn sole
    // and the complete instep opening outside this fixed author-space field.
    const ellipse=.180+.068*Math.sqrt(Math.max(0,1-((height+.072)/.085)**2))
    const nose=smoothstep((z-.195)/.035)*smoothstep((height+.084)/.018)
    const difference=Math.max(0,z-ellipse)
    upperPoints.setZ(i,z-(difference-.004*Math.tanh(difference/.004))*nose)
  }
  upper.computeVertexNormals()
  for (let pass = 0; pass < 5; pass++) {
    const smoothNormals = new Float32Array(upperNormals.array.length)
    for (let i = 0; i < upperPoints.count; i++) {
      const normal = new Vector3().fromBufferAttribute(upperNormals, i)
      const sum = new Vector3()
      for (const j of neighbors[i]) sum.add(new Vector3().fromBufferAttribute(upperNormals, j))
      normal.add(sum.divideScalar(neighbors[i].size)).normalize().toArray(smoothNormals, i * 3)
    }
    upperNormals.array.set(smoothNormals)
  }
  const rim = neckRing(.074, .081, .011, .034, .020, -.043, 0)
  const piping = Array.from({ length: 64 }, (_, i) => {const p=rim(i*Math.PI*2/64);p.y-=instepDrop(p.x,p.y,p.z);return p})
  const edge = ring(.1135, .172, .071, -.086)
  const soleSeam = Array.from({ length: 64 }, (_, i) => {
    const point = edge(i * Math.PI * 2 / 64)
    point.y += soleTurn(point.x, point.z)
    return point
  })
  const sock = loft([
    shoeRing(0, 0, .022, -.011),
    shoeRing(.066, .088, .027, .003),
    shoeRing(.080, .084, .024, .028),
    shoeRing(.087, .074, .003, .065, .003, -.012),
    shoeRing(.091, .071, -.003, .093),
    shoeRing(.088, .070, -.005, .119),
    shoeRing(.073, .060, -.005, .123),
    shoeRing(0, 0, -.005, .123),
  ])

  // The band arches in front of the sock. Its ends return toward the
  // sides of the vamp so the opening stays visible from either profile.
  // Finish the sock surface before fitting the band to its actual instep.
  const sockPoints = sock.attributes.position
  for (let i = 0; i < sockPoints.count; i++) {
    const y = sockPoints.getY(i), z = sockPoints.getZ(i)
    const lowerFoot = Math.exp(-(((y-.006)/.019)**4))
    const forefoot = Math.max(0,Math.min(1,(z-.020)/.085))
    sockPoints.setZ(i,z+0.025*lowerFoot*forefoot*forefoot*(3-2*forefoot))
    // Settle the cuff onto the upper sock without moving the foot or band.
    const cuffFall=Math.max(0,Math.min(1,(y-.065)/.058))
    const seatedCuff=cuffFall*cuffFall*(3-2*cuffFall)
    sockPoints.setY(i,y-.011*seatedCuff)
    sockPoints.setZ(i,sockPoints.getZ(i)+.006*seatedCuff)
    sockPoints.setX(i,sockPoints.getX(i)+side*.0065*seatedCuff)
  }
  sock.computeVertexNormals()
  const sockFront = profileFrontDepth(sock)
  const strapRings: Ring[] = Array.from({ length: 65 }, (_, i) => {
    const t = i / 32 - 1
    const x = .100 * t * (t * side < 0 ? .92 : 1)
    const y = -.038 + .0740 * (1 - t * t) ** .70
    const z = .050 + .034 * (1 - t * t)
    return angle => {
      const width = signedPower(Math.cos(angle), .55)
      const surfaceY=y+.007-.013*signedPower(Math.sin(angle),.55)-.004*width
      const support=sockFront(x,surfaceY)
      // The rear of the finite band keeps .003 clearance between sample rings.
      const surfaceZ=Math.max(z+.011*width,support===undefined?-Infinity:support+.007+.004*width)
      return new Vector3(x,surfaceY,surfaceZ)
    }
  })
  const strap = loft(strapRings, 32)
  return { sole, upper, piping, soleSeam, sock, strap }
}

export function bluefishRuffle(radius: number, depth: number, height: number, folds: number, scallop = .005) {
  // A sewn hollow cuff: outer neck, waist, flared scalloped hem,
  // rolled cloth edge, and a continuous inner return to the neck.
  const profile=[
    [-.012,0],[-.005,-.002],[.001,.002],[.002,.008],
    [-.003,.025],[.002,.043],[.007,.049],[.006,.052],
    [.002,.054],[-.003,.051],[-.008,.045],[-.013,.023],[-.012,0],
  ],sides=200,rings:Ring[]=[],colors:number[]=[]
  const ivory=new Color(0xfaf5ff),violet=new Color(0xaba3cd),ink=new Color(0x77729d),tint=new Color()
  for(let row=0;row<profile.length;row++){
    const [radial,down]=profile[row],t=down/.054
    rings.push(angle=>{
      const wave=Math.cos(folds*angle+.16*Math.sin(3*angle)),fold=.0018*Math.cos(folds*angle+.16*Math.sin(3*angle))
      const rim=scallop*wave*Math.max(0,t)**2+.0015*wave*Math.max(0,1-t)**2
      const neck=row===0||row===profile.length-1
      const rx=neck?.074:radius+radial+fold,rz=neck?.060:depth+radial+fold,cz=neck?.021:0
      return new Vector3(rx*Math.sin(angle),down*height/.052+rim,cz+rz*Math.cos(angle))
    })
    for(let i=0;i<sides;i++){
      const angle=i*Math.PI*2/sides,valley=(.5-.5*Math.cos(folds*angle+.16*Math.sin(3*angle)))**3
      tint.copy(ivory).lerp(violet,.34*valley*(.55+.45*Math.sin(Math.PI*Math.max(0,Math.min(1,t)))))
      if(row===7||row===8)tint.lerp(ink,.28)
      if(row>8)tint.lerp(violet,.12)
      colors.push(tint.r,tint.g,tint.b)
    }
  }
  const g=loft(rings,sides),n=(profile.length-1)*sides
  g.setAttribute('position',new Float32BufferAttribute(g.attributes.position.array.slice(0,n*3),3))
  g.setAttribute('color',new Float32BufferAttribute(colors.slice(0,n*3),3))
  g.setIndex(Array.from(g.index!.array,i=>i>=n?i-n:i));g.deleteAttribute('normal');g.computeVertexNormals();return g
}

/** A rolled cuff whose rounded scallops close around the wrist. */
export function bluefishWristRuffle() {
  const rows = 32, sides = 216
  const rings: Ring[] = [], colors: number[] = []
  const ivory = new Color(0xfbf6ff), violet = new Color(0xaaa4cf), color = new Color()
  const petal = (angle: number) => (.5 + .5 * Math.cos(9 * angle + .22 * Math.sin(3 * angle))) ** .48
  for (let row = 0; row <= rows; row++) {
    const around = row * Math.PI * 2 / rows
    const c = Math.cos(around), s = Math.sin(around)
    const across = c+.24*c*(1-c*c), down = s+.24*s*(1-s*s)
    rings.push(angle => {
      const lobe = petal(angle)
      const radius = .065 + (.028 + .015 * lobe) * across - .003*(1-lobe)**2*(1+across)
      const y = .024 + (.026 + .015 * lobe) * down + .006 * lobe + .004*lobe*Math.max(0,across) - .010*(1-lobe)**3*Math.max(0,down)
      return new Vector3(radius * Math.sin(angle), y, radius * .95 * Math.cos(angle))
    })
    for (let side = 0; side < sides; side++) {
      const valley = 1 - petal(side * Math.PI * 2 / sides)
      color.copy(ivory).lerp(violet, .55*valley**2 + .14*valley**2*Math.max(0,down) + .10 * Math.max(0, -across))
      colors.push(color.r, color.g, color.b)
    }
  }
  const geometry = loft(rings, sides)
  const positions=geometry.attributes.position
  geometry.setAttribute('position',new Float32BufferAttribute(positions.array.slice(0,rows*sides*3),3))
  geometry.setIndex(Array.from(geometry.index!.array,i=>i>=rows*sides?i-rows*sides:i))
  geometry.setAttribute('color', new Float32BufferAttribute(colors.slice(0,rows*sides*3), 3))
  geometry.deleteAttribute('normal')
  geometry.computeVertexNormals()
  return geometry
}
