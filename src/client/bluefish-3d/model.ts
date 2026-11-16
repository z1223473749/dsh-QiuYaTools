import {
  AlwaysStencilFunc, BackSide, Bone, BufferGeometry, CatmullRomCurve3, Color, Curve as SpatialCurve, DoubleSide, ExtrudeGeometry, Float32BufferAttribute,
  Group, MathUtils, Matrix4, Mesh, MeshBasicMaterial, MeshPhongMaterial, NotEqualStencilFunc, Ray, ReplaceStencilOp, Shape, ShapeGeometry, Skeleton,
  SkinnedMesh, SphereGeometry, TubeGeometry, Uint16BufferAttribute, Vector2, Vector3,
} from 'three'
import { bluefishFaceClearanceDepth, bluefishTempleDepth, createBluefishFace, createBluefishHeadShapes } from './face.ts'
import { bluefishRuffle, bluefishShoe, bluefishWristRuffle } from './costume.ts'
import { bluefishCrownInset, bluefishCrownLift, bluefishCrownRadius, createBluefishHair } from './hair.ts'
import { profileFrontDepth, refineProfile } from './profile-geometry.ts'

export type Vec = readonly [number, number, number]
type Paint = MeshPhongMaterial
type Layer = Group | Bone
type Curve = readonly [number, number, number, number, number, number]
const EAR_TURN = .94
const EAR_SPAN = 1.51

// The forward edge of the fringe is round in profile and recedes near
// the eye. Distances are measured in the same coordinates as the locks.
const FRINGE_PROFILE = [
  [74, 0], [84, 0], [88, .010], [102, .030], [116, .028],
  [132, .009], [142, -.006], [152, -.023], [161, -.067], [166, -.069], [174, 0],
] as const

// Highlight contours measured in the same authoring space as the locks.
// The fields remain attached to the curved mesh as it turns and deforms.
const FRINGE_REFLECTIONS = [
  [[193,111],[196,108],[200,108],[202,105],[203,107],[207,104],[206,109],[211,107],[209,112],[212,110],[208,116],[206,117],[207,112],[203,116],[202,114],[200,118],[198,117],[201,112],[197,116],[195,118],[197,113],[193,117]],
  [[214,110],[215,112],[218,109],[219,112],[223,109],[224,112],[229,109],[227,115],[225,116],[226,112],[222,117],[220,117],[221,113],[218,118],[216,119],[218,114],[214,117]],
  [[236,109],[238,111],[239,108],[241,112],[241,120],[240,116],[238,120],[236,117],[236,121],[234,117],[234,112]],
  [[245,110],[247,113],[249,111],[252,114],[255,113],[259,114],[262,110],[263,112],[267,111],[269,110],[269,114],[268,119],[266,122],[265,119],[265,115],[263,118],[262,124],[260,125],[260,119],[259,117],[257,119],[256,123],[255,120],[256,115],[252,117],[250,117],[247,114],[247,119],[245,116]],
  [[280,108],[282,111],[284,110],[287,113],[290,112],[293,114],[295,112],[297,114],[300,113],[303,111],[305,114],[306,119],[304,116],[302,116],[302,120],[300,117],[298,120],[297,116],[294,118],[292,117],[291,114],[289,117],[288,114],[285,115],[284,112],[281,112]],
  [[311,109],[313,110],[314,108],[317,110],[319,108],[321,110],[324,110],[325,113],[328,113],[326,117],[324,116],[323,119],[322,114],[320,116],[318,113],[317,116],[314,113],[312,114]],
] as const

function fringeProfileDepth(y: number, depth: number, exposed: boolean) {
  const pixel = 175.4 - y / .0056
  const upper = FRINGE_PROFILE.findIndex(([height]) => height > pixel)
  if (upper < 1) return depth
  const [top, above] = FRINGE_PROFILE[upper - 1], [bottom, below] = FRINGE_PROFILE[upper]
  const [previousY, previous] = FRINGE_PROFILE[Math.max(0, upper - 2)]
  const [nextY, next] = FRINGE_PROFILE[Math.min(FRINGE_PROFILE.length - 1, upper + 1)]
  const span = bottom - top
  const t = (pixel - top) / span
  // A shape-preserving tangent keeps the fixed profile from overshooting
  // between authored sections when the viewer turns to a grazing angle.
  const slope = (below - above) / span
  const tangent = (a: number, b: number) => a*b>0 ? 2*a*b/(a+b) : 0
  const startSlope = upper === 1 ? 0 : exposed ? tangent((above-previous)/(top-previousY),slope) : (below-previous)/(bottom-previousY)
  const endSlope = upper === FRINGE_PROFILE.length - 1 ? 0 : exposed ? tangent(slope,(next-below)/(nextY-bottom)) : (next-above)/(nextY-top)
  const eased = t * t * (3 - 2 * t)
  const offset = above + (below - above) * eased + span * t * (1 - t) * (startSlope * (1 - t) - endSlope * t)
  // The two underlying side fans retain their settled temple junction.
  // Only the four exposed forehead locks use the smooth returning profile.
  const underlayRound = exposed ? 0 : .021*MathUtils.smoothstep(pixel,148,154)
    *(1-MathUtils.smoothstep(pixel,158,160))
  return depth + offset + underlayRound
}

type BonnetDepth = (a: number,b: number)=>number|undefined

function bonnetSideDepth(source: BufferGeometry,side: number) {
  const p=source.attributes.position,points:number[]=[],indices=Array.from(source.index!.array)
  for (let i=0;i<p.count;i++) points.push(p.getZ(i),p.getY(i),side*p.getX(i))
  if (side>0) for (let i=0;i<indices.length;i+=3) [indices[i+1],indices[i+2]]=[indices[i+2],indices[i+1]]
  const geometry=new BufferGeometry()
  geometry.setAttribute('position',new Float32BufferAttribute(points,3));geometry.setIndex(indices)
  const sample=profileFrontDepth(geometry);geometry.dispose();return sample
}

function bonnetCrownHeight(source:BufferGeometry) {
  const p=source.attributes.position,points:number[]=[],indices=Array.from(source.index!.array)
  for(let i=0;i<p.count;i++)points.push(p.getX(i),p.getZ(i),p.getY(i))
  for(let i=0;i<indices.length;i+=3)[indices[i+1],indices[i+2]]=[indices[i+2],indices[i+1]]
  const geometry=new BufferGeometry()
  geometry.setAttribute('position',new Float32BufferAttribute(points,3));geometry.setIndex(indices)
  const sample=profileFrontDepth(geometry);geometry.dispose();return sample
}

function bonnetAssembly(frontDepth: BonnetDepth,sideDepth: readonly BonnetDepth[],roof:BonnetDepth,rearDepth:BonnetDepth) {
  const cloth=new Color(0xfdf7fc),shadow=new Color(0x9996c9),pigment=new Color()
  const sideArc: readonly (readonly [number,number])[]=[
    [.36064,-.2116],[.40264,-.1612],[.46144,-.1248],
    [.52584,-.0716],[.57064,-.0072],[.59584,.0600],
  ]
  const sampleSideZ=(y:number)=>{
    const upper=sideArc.findIndex(p=>p[0]>=y),i=upper<0?sideArc.length-1:Math.max(1,upper)
    const a=sideArc[i-1],b=sideArc[i],t=MathUtils.clamp((y-a[0])/(b[0]-a[0]),0,1)
    return MathUtils.lerp(a[1],b[1],t)
  }
  let profileSeats:number[][]=[]
  const lateralAt=(q:number,side:number)=>{
    const values=profileSeats[side],f=MathUtils.clamp(q,0,1)*(values.length-1),i=Math.min(values.length-2,Math.floor(f)),t=f-i
    return MathUtils.lerp(values[i],values[i+1],t)
  }
  const band=(s:number,profile:boolean)=>{
    const angle=.10+(Math.PI-.20)*s,arch=Math.sin(angle),across=Math.cos(angle)
    const taper=MathUtils.clamp(Math.min(s,1-s)/.166,0,1),fade=taper*taper*(3-2*taper)
    const sink=.84+.16*fade
    let x=.411*across*sink,y=.275+.301*arch*sink,z=-.005-.225*(1-arch)**.62
    if (!profile) {
      const support=frontDepth(x,y)
      if (support!==undefined) z+=Math.max(0,support+.007-z)*MathUtils.smoothstep(y,.37,.48)
    } else {
      y+=.0168*arch**3+.056*(1-fade)
      z=sampleSideZ(y)
      const side=x>=0?1:-1,support=sideDepth[side>0?0:1](z,y)
      if (support!==undefined) x=side*Math.max(Math.abs(x),support+.014)
      if(profileSeats.length) x=side*lateralAt(Math.abs(2*s-1),side>0?0:1)
    }
    return new Vector3(x,y,z)
  }
  const rawSeats=[0,1].map(side=>Array.from({length:97},(_,i)=>Math.abs(band(side===0?(1-i/96)/2:(1+i/96)/2,true).x)))
  profileSeats=rawSeats.map(values=>{
    for(let i=1;i<values.length;i++)values[i]=Math.max(values[i],values[i-1]+.0002)
    return values.map((_,i)=>i===0?0:(values[i]+2*values[Math.min(96,i+1)]+values[Math.min(96,i+2)])/4)
  })
  const color=(shade:number)=>{pigment.copy(cloth).lerp(shadow,MathUtils.clamp(shade,0,.85));return pigment.toArray()}
  function grid(columns:number,rows:number,point:(s:number,v:number,profile:boolean)=>Vector3,shade:(s:number,v:number)=>number,profile:boolean) {
    const p:number[]=[],c:number[]=[],index:number[]=[]
    for (let i=0;i<=columns;i++) for (let j=0;j<=rows;j++) {
      const s=i/columns,v=j/rows;p.push(...point(s,v,profile).toArray());c.push(...color(shade(s,v)))
      if(i<columns&&j<rows){const a=i*(rows+1)+j,b=a+rows+1;index.push(a,a+1,b,a+1,b+1,b)}
    }
    const g=new BufferGeometry();g.setAttribute('position',new Float32BufferAttribute(p,3))
    g.setAttribute('color',new Float32BufferAttribute(c,3));g.setIndex(index);g.computeVertexNormals();return g
  }
  function combine(parts:BufferGeometry[]) {
    const p:number[]=[],c:number[]=[],index:number[]=[]
    for(const g of parts){const offset=p.length/3;for(const value of g.attributes.position.array)p.push(value);for(const value of g.attributes.color.array)c.push(value);for(const n of g.index!.array)index.push(offset+n);g.dispose()}
    const g=new BufferGeometry();g.setAttribute('position',new Float32BufferAttribute(p,3));g.setAttribute('color',new Float32BufferAttribute(c,3));g.setIndex(index);g.computeVertexNormals();return g
  }
  function closeLeaf(source:BufferGeometry,rows:number,thickness:number){
    const p=source.attributes.position,n=source.attributes.normal,c=source.attributes.color,count=p.count,stride=rows+1,columns=count/stride-1,positions:number[]=[],colors:number[]=[],faces:number[]=[]
    for(const side of[1,-1])for(let i=0;i<count;i++){
      positions.push(p.getX(i)+side*thickness*n.getX(i),p.getY(i)+side*thickness*n.getY(i),p.getZ(i)+side*thickness*n.getZ(i));colors.push(c.getX(i),c.getY(i),c.getZ(i))
    }
    for(let i=0;i<columns;i++)for(let j=0;j<rows;j++){
      const a=i*stride+j,b=a+stride;faces.push(a,a+1,b,a+1,b+1,b,count+a,count+b,count+a+1,count+a+1,count+b,count+b+1)
    }
    const hem=(a:number,b:number)=>faces.push(a,b,count+a,b,count+b,count+a)
    for(let i=0;i<columns;i++){const a=i*stride,b=a+stride;hem(a,b);hem(b+rows,a+rows)}
    for(let j=0;j<rows;j++){hem(j+1,j);hem(count-stride+j,count-stride+j+1)}
    const g=new BufferGeometry();g.setAttribute('position',new Float32BufferAttribute(positions,3));g.setAttribute('color',new Float32BufferAttribute(colors,3));g.setIndex(faces);g.computeVertexNormals();return g
  }
  const pleatPoint=(s:number,v:number)=>{
    const raw=s*9,part=Math.min(8,Math.floor(raw)),u=raw-part
    const angle=.10+(Math.PI-.20)*s,arch=Math.sin(angle),across=Math.cos(angle)
    const taper=MathUtils.clamp(Math.min(s,1-s)/.145,0,1),fade=taper*taper*(3-2*taper),width=.08+.92*fade
    const cap=.78+.22*MathUtils.smoothstep(u,.045,.205)*(1-MathUtils.smoothstep(u,.795,.955))
    const shoulder=MathUtils.smoothstep(u,.08,.23)*(1-MathUtils.smoothstep(u,.77,.92))
    const returnFlap=MathUtils.smoothstep(u,0,.10)*(1-MathUtils.smoothstep(u,.90,1))
    const rootS=(part+u+(.5-u)*.26*returnFlap*(1-v))/9
    const p=band(rootS,false)
    p.x+=across*.111*width*v
    p.y+=arch*.174*cap*width*v
    p.z-=(.108+.020*(1-arch))*width*v+.016*(1-shoulder)*v+.028*(1-shoulder)*Math.sin(Math.PI*v)
    return p
  }
  const pleatShade=(s:number,v:number)=>{
    const u=(s*9)%1,edge=Math.exp(-((u/.085)**2))+Math.exp(-(((1-u)/.085)**2))
    const tear=Math.exp(-(((u-.53)/.09)**2)-(((v-.20)/.19)**4))
    return .025+.65*edge*(1-.40*v)+.75*tear
  }
  const bandSegments=240,bandRadius=.0125
  const seated=Array.from({length:bandSegments+1},(_,row)=>{
    const s=row/bandSegments,point=band(s,true).add(new Vector3(0,.003,0)),sign=point.x>=0?1:-1
    const sample=sideDepth[sign>0?0:1],h=.002,end=MathUtils.smoothstep(Math.min(s,1-s),0,.13),support=sample(point.z,point.y)
    if(support!==undefined&&Math.abs(point.x)>.06){
      const dy=((sample(point.z,point.y+h)??support)-(sample(point.z,point.y-h)??support))/(2*h)
      const dz=((sample(point.z+h,point.y)??support)-(sample(point.z-h,point.y)??support))/(2*h)
      point.x=sign*Math.max(Math.abs(point.x),support+(bandRadius*(.19+.81*end)+.005)*Math.sqrt(1+dy*dy+dz*dz))
    }
    return point
  })
  let smooth=seated
  for(let pass=0;pass<12;pass++){
    const previous=smooth
    smooth=previous.map((point,row)=>{
      let x=0;const weights=[1,4,6,4,1]
      for(let j=0;j<5;j++)x+=previous[MathUtils.clamp(row+j-2,0,bandSegments)].x*weights[j]/16
      return new Vector3(x,point.y,point.z)
    })
  }
  const sewnBandCurve=new CatmullRomCurve3(smooth,false,'centripetal')
  const sewnBand=(s:number)=>sewnBandCurve.getPoint(s).add(new Vector3(0,-.003,0))
  const outerSideZ=(y:number)=>{
    const py=175.4-y/.0056,knots=[[54,234],[60,228],[70,234],[76,238],[80,237.2],[84,239],[90,244],[96,245],[105,244],[111,241],[122,234]],index=Math.max(1,knots.findIndex(k=>k[0]>=py)),low=knots[index-1],high=knots[index],t=MathUtils.smoothstep(py,low[0],high[0])
    return(198-MathUtils.lerp(low[1],high[1],t))*.0056-.01
  }
  const foldDepth=(p:Vector3)=>.12*MathUtils.smoothstep(p.y,.65,.68)*MathUtils.smoothstep(Math.abs(p.x),.16,.34)
  const standingRoll=(p:Vector3)=>{
    const knots=[[.660,0],[.680,.010],[.702,.032],[.725,.028],[.736,.0219],[.743,.009],[.747,0],[.755,0]],i=Math.max(1,knots.findIndex(k=>k[0]>=p.y)),low=knots[i-1],high=knots[i],t=MathUtils.smoothstep(p.y,low[0],high[0])
    return MathUtils.lerp(low[1],high[1],t)*(1-MathUtils.smoothstep(Math.abs(p.x),.02,.075))
  }
  const sideCreasePixels=Array.from({length:45},(_,i)=>{
    const q=i/44,t=q<.35?1-q/.35:(q-.35)/.65,a=q<.35?[221,70]:[221,70],b=q<.35?[225,55]:[211,82],c=q<.35?[232,55]:[222,100],d=q<.35?[237,70]:[229,105]
    return a.map((value,k)=>value*(1-t)**3+3*b[k]*(1-t)**2*t+3*c[k]*(1-t)*t*t+d[k]*t**3)
  })
  const sideCreaseDistance=(z:number,y:number)=>{
    let result=Infinity
    const px=198-(z+.01)/.0056,py=175.4-y/.0056
    for(let i=0;i<44;i++){const a=sideCreasePixels[i],b=sideCreasePixels[i+1],dx=b[0]-a[0],dy=b[1]-a[1],t=MathUtils.clamp(((px-a[0])*dx+(py-a[1])*dy)/Math.max(1e-12,dx*dx+dy*dy),0,1);result=Math.min(result,Math.hypot(px-a[0]-t*dx,py-a[1]-t*dy)*.0056)}
    return result
  }
  const fixedLeaf=(part:number,u:number,v:number)=>{
    const kind=part<4?part:part>4?8-part:4,a=part>4?1-u:u,s=(part+u)/9,side=part<4?1:-1,free=pleatPoint(s,1),root=sewnBand(s)
    if(kind===0||kind===1){
      const joint=pleatPoint(part<4?2/9:7/9,1),endX=257+Math.abs(joint.x)/.0056,endY=175.4-joint.y/.0056
      const knots=kind===0?[[0,328,110],[.3,336,104],[.6,338,96],[1,336.5,88]]:[[0,336.5,88],[.25,337,81.5],[.55,332.5,75.5],[.8,327,73.2],[1,endX,endY]]
      const i=Math.max(1,knots.findIndex(k=>k[0]>=a)),low=knots[i-1],high=knots[i],t=MathUtils.clamp((a-low[0])/(high[0]-low[0]),0,1),ease=t*t*(3-2*t)
      free.x=side*(MathUtils.lerp(low[1],high[1],ease)-257)*.0056;free.y=(175.4-MathUtils.lerp(low[2],high[2],t))*.0056
    }
    if(kind>=2){
      const knots=kind===2?[[0,324.97,72.925],[.2,325,67],[.4,320,59],[.65,311,54],[.85,305,55],[1,301,58]]:kind===3?[[0,301,58],[.15,301,53],[.4,294,46],[.7,283,44],[.9,274,46],[1,272,48]]:[[0,272,48],[.15,272,44],[.4,264,41.3],[.5,259,40.8],[.6,254,41.3],[.85,244,44],[1,242,48]],q=kind===4?u:a,i=Math.max(1,knots.findIndex(k=>k[0]>=q)),low=knots[i-1],high=knots[i]
      // Interpolate the real outer rail with a shared tangent at each knot.
      // Easing X and Y together still made straight facets between samples.
      const before=knots[Math.max(0,i-2)],after=knots[Math.min(knots.length-1,i+1)]
      const span=high[0]-low[0],fraction=MathUtils.clamp((q-low[0])/span,0,1)
      const rail=(axis:number)=>{
        const d=(high[axis]-low[axis])/span
        const tangent=(left:number,right:number,h0:number,h1:number)=>left*right<=0?0:
          (3*(h0+h1))/((2*h1+h0)/left+(h1+2*h0)/right)
        const m0=i===1?d:tangent((low[axis]-before[axis])/(low[0]-before[0]),d,low[0]-before[0],span)
        const m1=i===knots.length-1?d:tangent(d,(after[axis]-high[axis])/(after[0]-high[0]),span,after[0]-high[0])
        return(2*fraction**3-3*fraction*fraction+1)*low[axis]+(fraction**3-2*fraction*fraction+fraction)*span*m0
          +(-2*fraction**3+3*fraction*fraction)*high[axis]+(fraction**3-fraction*fraction)*span*m1
      }
      const px=rail(1),py=rail(2)
      free.x=kind===4?(px-257)*.0056:side*(px-257)*.0056;free.y=(175.4-py)*.0056
    }
    const p=root.clone().lerp(free,v)
    if(kind<=2){
      const curve=[[0,239],[.2,237.2],[.4,231.8],[.65,225],[.85,221.5],[1,217]],i=Math.max(1,curve.findIndex(k=>k[0]>=a)),lo=curve[i-1],hi=curve[i],q=MathUtils.smoothstep(a,lo[0],hi[0])
      const edge=kind===2?(198-MathUtils.lerp(lo[1],hi[1],q))*.0056-.01:outerSideZ(p.y)
      p.z=MathUtils.lerp(sampleSideZ(p.y),edge,v)+(root.z-sampleSideZ(root.y))*(1-v)**3
    }else{
      const px=kind===3?210-(a-.5)*14:203-3*Math.sin(Math.PI*u)
      p.z=MathUtils.lerp(root.z,(198-px)*.0056-.01,v)
      if(kind===3){
        const folded=MathUtils.lerp(sampleSideZ(p.y),outerSideZ(p.y),v)+(root.z-sampleSideZ(root.y))*(1-v)**3
        p.z=MathUtils.lerp(p.z,folded,1-MathUtils.smoothstep(a,0,.18))
      }
    }
    const shoulder=MathUtils.smoothstep(u,.04,.20)*(1-MathUtils.smoothstep(u,.80,.96))
    const roll=(kind===0?0:kind===1?.010:.024)*(1-shoulder)*Math.sin(Math.PI*v)
    const angle=.10+(Math.PI-.20)*s,normal=new Vector3(Math.cos(angle),.10*Math.sin(angle),Math.sin(angle)).normalize()
    p.addScaledVector(normal,-roll)
    p.x+=.0012*(2*u-1)
    p.z+=standingRoll(p)
    if(kind<=2)p.x+=side*.010*Math.exp(-((sideCreaseDistance(p.z,p.y)/.014)**2))*MathUtils.smoothstep(v,0,.20)
    return p
  }
  const frontParts:BufferGeometry[]=[]
  for(let part=0;part<9;part++){
    const g=grid(44,18,(u,v)=>fixedLeaf(part,u,v),(u,v)=>pleatShade((part+u)/9,v),false)
    frontParts.push(closeLeaf(g,18,.0007));g.dispose()
  }
  const pleats=combine(frontParts)
  const rearRoots=Array.from({length:241},(_,i)=>sewnBand(i/240))
  const rearAuthor=(p:Vector3)=>{
    const x=p.x,y=p.y;let nearest=Infinity,s=0,root=rearRoots[0]
    for(let j=0;j<240;j++){
      const a=rearRoots[j],b=rearRoots[j+1],dx=b.x-a.x,dy=b.y-a.y,t=MathUtils.clamp(((x-a.x)*dx+(y-a.y)*dy)/(dx*dx+dy*dy),0,1)
      const px=MathUtils.lerp(a.x,b.x,t),py=MathUtils.lerp(a.y,b.y,t),distance=(x-px)**2+(y-py)**2
      if(distance<nearest){nearest=distance;s=(j+t)/240;root=new Vector3(px,py,MathUtils.lerp(a.z,b.z,t))}
    }
    const radial=new Vector3(root.x,root.y-.275,0).normalize(),v=((x-root.x)*radial.x+(y-root.y)*radial.y)/.17
    return{s,v}
  }
  const rearRelief=(point:Vector3,u:number,v:number,amount:number)=>{
    const coordinate=rearAuthor(point),phase=coordinate.s*9
    const rootFade=MathUtils.smoothstep(coordinate.v,-.02,.10)*(1-MathUtils.smoothstep(coordinate.v,.45,.9))
    const boundary=Math.sin(Math.PI*u)**2*Math.sin(Math.PI*v)**2
    point.z+=amount*Math.cos(2*Math.PI*phase)*rootFade*boundary
    return point
  }
  const rearPetal=(part:number)=>{
    // Each cloth strip arches across the fixed crown, with both depth edges
    // sewn into the crown. The three round profile crests remain separate.
    const controls=[
      [[215,76],[215,61],[217,49],[224,51],[229,51],[233,60],[233,65],[232,69],[227,73],[226,76]],
      [[227,78],[228,57],[233,46],[240,47],[247,47],[254,56],[254,61],[253,68],[246,74],[244,78]],
      [[249,81],[249,63],[254,53],[260,54],[267,53],[270,60],[270,66],[269,69],[260,75],[258,81]],
    ][part]
    const points=controls.map(([px,py])=>new Vector3(0,(175.4-py)*.0056,(198-px)*.0056-.01))
    const curvePoint=(t:number)=>{
      const segment=Math.min(2,Math.floor(t*3)),q=t*3-segment,k=segment*3
      return points[k].clone().multiplyScalar((1-q)**3).addScaledVector(points[k+1],3*(1-q)**2*q).addScaledVector(points[k+2],3*(1-q)*q*q).addScaledVector(points[k+3],q**3)
    }
    const geometry=grid(64,40,(s,t)=>{
      const curve=curvePoint(t),x=.18*(2*s-1),centerRoof=roof(0,curve.z)??.56,support=roof(x,curve.z)??centerRoof-.10
      const arch=Math.sin(Math.PI*s)**1.5,crest=curve.y-centerRoof
      const rootFade=1
      return rearRelief(new Vector3(x,support-.004+crest*arch*rootFade-.006*(1-arch)*(1+.5*t),curve.z),s,t,.006*(.4+.3*part))
    },(s,t)=>.025+.11*(1-Math.sin(Math.PI*s))+.10*(Math.exp(-((t/.085)**2))+Math.exp(-(((1-t)/.085)**2))),false)
    const closed=closeLeaf(geometry,40,.0007);geometry.dispose();return closed
  }
  const rearUnderlap:BufferGeometry[]=[],peakCache=new Map<string,{y:number,z:number}>()
  const peakAt=(x:number)=>{
    const key=x.toFixed(7),cached=peakCache.get(key);if(cached)return cached
    let peak={y:-Infinity,z:-.139}
    for(let row=0;row<=100;row++){const z=-.64+.74*row/100,y=roof(x,z);if(y!==undefined&&y>peak.y)peak={y,z}}
    peakCache.set(key,peak);return peak
  }
  for(let part=2;part<=6;part++){
    const g=grid(44,18,(u,v)=>{
      const s=(part+u)/9,root=sewnBand(s),peak=peakAt(root.x),shoulder=MathUtils.smoothstep(u,.04,.20)*(1-MathUtils.smoothstep(u,.80,.96))
      const bottom=Math.min(root.y,peak.y-.008),top=Math.max(bottom+.003,Math.min(root.y+.055*(.90+.10*shoulder),peak.y+.002)),y=MathUtils.lerp(bottom,top,v)
      const excess=y-(peak.y-.010),sampleY=y-.5*(excess+Math.sqrt(excess*excess+.000004)),support=rearDepth(root.x,sampleY)
      const z=support===undefined?peak.z-.004:-support-.004
      return new Vector3(root.x,y,z)
    },(u,v)=>pleatShade((part+u)/9,v),false)
    rearUnderlap.push(closeLeaf(g,18,.0007));g.dispose()
  }
  const sideBridges:BufferGeometry[]=[]
  for(const side of[1,-1]){
    const sample=bonnetSideDepth(pleats,side)
    const g=grid(36,24,(u,v)=>{
      const frontY=.40+.24*v,backY=.52+.12*v,y=frontY,targetZ=outerSideZ(frontY)+.002
      let z=targetZ,support=sample(z,y)
      if(support===undefined)for(let step=1;step<=40&&support===undefined;step++)for(const sign of[1,-1]){
        const candidate=targetZ+sign*step*.002,value=sample(candidate,y)
        if(value!==undefined){z=candidate;support=value;break}
      }
      if(support===undefined)throw new Error('Bonnet side bridge has no real C cloth attachment atY'+y)
      const frontX=support-.001,backX=.12+.06*v
      return rearRelief(new Vector3(side*(MathUtils.lerp(frontX,backX,u)+.012*Math.sin(Math.PI*u)*Math.sin(Math.PI*v)-.065*Math.sin(Math.PI*u)*(1-v)**2),MathUtils.lerp(frontY,backY,u),MathUtils.lerp(z,-.38,u)),u,v,.006*.7)
    },(u,v)=>.035+.20*Math.exp(-(((u-.16)/.11)**2))*(1-v),false)
    sideBridges.push(closeLeaf(g,24,.0007));g.dispose()
  }
  // A rounded finite lining follows the real fixed crown underneath the folds.
  // Its returned edge stays at the cap roots, without rectangular free corners.
  const liningGeometry=()=>{
    const rings=24,sides=128,positions:number[]=[],colors:number[]=[],indices:number[]=[]
    const point=(r:number,angle:number)=>{
      const x=.24*r*Math.cos(angle),z=-.215+.145*r*Math.sin(angle),support=roof(x,z)
      if(support===undefined)throw new Error('Missing physical crown under bonnet lining')
      return new Vector3(x,support+.004,z)
    }
    positions.push(...point(0,0).toArray());colors.push(...color(.065))
    for(let ring=1;ring<=rings;ring++)for(let side=0;side<sides;side++){
      const r=ring/rings,angle=side/sides*Math.PI*2
      positions.push(...point(r,angle).toArray());colors.push(...color(.065+.04*r*r*Math.sin(3*angle)**2))
      const a=1+(ring-1)*sides+side,b=1+(ring-1)*sides+(side+1)%sides
      if(ring===1)indices.push(0,b,a)
      else{const c=a-sides,d=b-sides;indices.push(c,b,a,c,d,b)}
    }
    const surface=new BufferGeometry();surface.setAttribute('position',new Float32BufferAttribute(positions,3));surface.setAttribute('color',new Float32BufferAttribute(colors,3));surface.setIndex(indices);surface.computeVertexNormals()
    const normals=surface.attributes.normal,count=positions.length/3,all:number[]=[],pigments:number[]=[]
    for(const side of[1,-1])for(let i=0;i<count;i++){
      all.push(positions[i*3]+side*.0007*normals.getX(i),positions[i*3+1]+side*.0007*normals.getY(i),positions[i*3+2]+side*.0007*normals.getZ(i));pigments.push(colors[i*3],colors[i*3+1],colors[i*3+2])
    }
    const faces=indices.slice();for(let i=0;i<indices.length;i+=3)faces.push(count+indices[i],count+indices[i+2],count+indices[i+1])
    const first=1+(rings-1)*sides
    for(let side=0;side<sides;side++){const a=first+side,b=first+(side+1)%sides;faces.push(a,b,count+a,b,count+b,count+a)}
    const closed=new BufferGeometry();closed.setAttribute('position',new Float32BufferAttribute(all,3));closed.setAttribute('color',new Float32BufferAttribute(pigments,3));closed.setIndex(faces);closed.computeVertexNormals();surface.dispose();return closed
  }
  const lining=liningGeometry()
  const hood=combine([rearPetal(0),rearPetal(1),rearPetal(2),...rearUnderlap,...sideBridges,lining])
  hood.userData.bonnetRearPetals=11
  const rearSewn:number[]=[],rearPositions=hood.attributes.position
  for(let i=0;i<rearPositions.count;i++){
    const coordinate=rearAuthor(new Vector3(rearPositions.getX(i),rearPositions.getY(i),rearPositions.getZ(i)))
    const part=i>=28240?10:i<15990?Math.floor(i/5330):i<24540?3+Math.floor((i-15990)/1710):8+Math.floor((i-24540)/1850)
    const u=part>=10?.5:part<8?1:Math.floor(((i-24540)%1850)%925/25)/36
    const pigment=part<8?1:.18+.82*MathUtils.smoothstep(u,.25,.85)
    rearSewn.push(coordinate.s,coordinate.v,part,pigment)
  }
  hood.setAttribute('bonnetRearCoordinate',new Float32BufferAttribute(rearSewn,4))
  function bindingTube() {
    const segments=240,sides=8,radius=.0125
    const centerAt=(s:number)=>sewnBand(s).add(new Vector3(0,.003,0))
    const positions:number[]=[],faces:number[]=[],centers:Vector3[]=[]
    for(let row=0;row<=segments;row++){
      const s=row/segments,center=centerAt(s)
      const tangent=centerAt(Math.min(1,s+.0002)).sub(centerAt(Math.max(0,s-.0002))).normalize()
      const normal=new Vector3(0,0,1).addScaledVector(tangent,-tangent.z).normalize(),binormal=new Vector3().crossVectors(tangent,normal).normalize()
      const end=MathUtils.smoothstep(Math.min(s,1-s),0,.08),width=.0125*(.40+.60*end)
      centers.push(center)
      for(let j=0;j<sides;j++){
        const angle=j/sides*Math.PI*2
        positions.push(...center.clone().addScaledVector(normal,width*Math.cos(angle)).addScaledVector(binormal,width*Math.sin(angle)).toArray())
        if(row<segments){const a=row*sides+j,b=row*sides+(j+1)%sides,c=a+sides,d=b+sides;faces.push(a,b,c,b,d,c)}
      }
    }
    for(const row of[0,segments]){
      const id=positions.length/3;positions.push(...centers[row].toArray())
      for(let j=0;j<sides;j++){const a=row*sides+j,b=row*sides+(j+1)%sides;if(row===0)faces.push(id,b,a);else faces.push(id,a,b)}
    }
    const g=new BufferGeometry();g.setAttribute('position',new Float32BufferAttribute(positions,3));g.setAttribute('color',new Float32BufferAttribute(Array(positions.length).fill(1),3));g.setIndex(faces);g.computeVertexNormals();return g
  }
  const binding=bindingTube()
  function rim(positions: typeof pleats.attributes.position,part:number) {
    const centers=Array.from({length:45},(_,row)=>{
      const i=part*1710+row*19+18
      return new Vector3().fromBufferAttribute(positions,i).add(new Vector3().fromBufferAttribute(positions,i+855)).multiplyScalar(.5)
    }),p:number[]=[],index:number[]=[]
    for(let row=0;row<45;row++){
      const kind=part<4?part:part>4?8-part:4,a=part>4?1-row/44:row/44,radius=kind<2?.0028:kind===2?MathUtils.lerp(.0028,.0048,MathUtils.smoothstep(a,.50,.62)):.0048
      const tangent=centers[Math.min(44,row+1)].clone().sub(centers[Math.max(0,row-1)]).normalize()
      const normal=new Vector3(0,0,1).addScaledVector(tangent,-tangent.z).normalize(),binormal=new Vector3().crossVectors(tangent,normal).normalize()
      const before=centers[row].clone().sub(centers[Math.max(0,row-1)]),after=centers[Math.min(44,row+1)].clone().sub(centers[row]),span=Math.min(before.length()||Infinity,after.length()||Infinity),turn=Math.acos(MathUtils.clamp(before.clone().normalize().dot(after.clone().normalize()),-1,1)),roll=Math.min(radius,.28*span/Math.max(.001,Math.sin(turn/2)))
      for(let j=0;j<8;j++){
        const angle=j/8*Math.PI*2;p.push(...centers[row].clone().addScaledVector(normal,roll*Math.cos(angle)).addScaledVector(binormal,roll*Math.sin(angle)).toArray())
        if(row<44){const a=row*8+j,b=row*8+(j+1)%8;index.push(a,b,a+8,b,b+8,a+8)}
      }
    }
    for(const row of[0,44]){const i=p.length/3;p.push(...centers[row].toArray());for(let j=0;j<8;j++){const a=row*8+j,b=row*8+(j+1)%8;index.push(...(row===0?[i,b,a]:[i,a,b]))}}
    const g=new BufferGeometry();g.setAttribute('position',new Float32BufferAttribute(p,3));g.setAttribute('color',new Float32BufferAttribute(Array(p.length).fill(1),3));g.setIndex(index);g.computeVertexNormals();return g
  }
  const sideCreaseMissing:number[]=[]
  const physicalCrease=(side:number)=>{
    const sample=bonnetSideDepth(pleats,side),centers=sideCreasePixels.map(([px,py])=>{
      const y=(175.4-py)*.0056,z=(198-px)*.0056-.01,x=sample(z,y)
      return x===undefined?undefined:new Vector3(side*(x+.0005),y,z)
    })
    const missing=centers.filter(p=>!p).length;sideCreaseMissing.push(missing)
    const positions:number[]=[],faces:number[]=[]
    if(!missing)for(let row=0;row<45;row++){
      const center=centers[row]!,tangent=centers[Math.min(44,row+1)]!.clone().sub(centers[Math.max(0,row-1)]!).normalize(),axis=new Vector3(side,0,0),normal=axis.addScaledVector(tangent,-axis.dot(tangent)).normalize(),binormal=new Vector3().crossVectors(tangent,normal).normalize()
      for(let j=0;j<8;j++){
        const angle=j/8*Math.PI*2
        positions.push(...center.clone().addScaledVector(normal,.0002*Math.cos(angle)).addScaledVector(binormal,.0025*Math.sin(angle)).toArray())
        if(row<44){const a=row*8+j,b=row*8+(j+1)%8;faces.push(a,b,a+8,b,b+8,a+8)}
      }
    }
    if(!missing)for(const row of[0,44]){const id=positions.length/3;positions.push(...centers[row]!.toArray());for(let j=0;j<8;j++){const a=row*8+j,b=row*8+(j+1)%8;faces.push(...(row===0?[id,b,a]:[id,a,b]))}}
    const g=new BufferGeometry();g.setAttribute('position',new Float32BufferAttribute(positions,3));g.setAttribute('color',new Float32BufferAttribute(Array(positions.length).fill(1),3));g.setIndex(faces);g.computeVertexNormals();return g
  }
  const hemParts=Array.from({length:9},(_,part)=>rim(pleats.attributes.position,part)),baseHemIndices=hemParts.reduce((sum,g)=>sum+g.index!.count,0)
  hemParts.push(physicalCrease(1),physicalCrease(-1))
  const frontHem=combine(hemParts)
  frontHem.userData.sideCreaseMissingSamples=sideCreaseMissing

  for(let part=0;part<9;part++){
    const kind=part<4?part:part>4?8-part:4,start=part*2160
    if(kind!==2){frontHem.addGroup(start,2160,kind<2?0:1);continue}
    const cut=part<4?18:26,first=part<4?0:1,second=1-first
    frontHem.addGroup(start,cut*48,first);frontHem.addGroup(start+cut*48,(44-cut)*48,second)
    frontHem.addGroup(start+2112,24,first);frontHem.addGroup(start+2136,24,second)
  }
  if(frontHem.index!.count>baseHemIndices)frontHem.addGroup(baseHemIndices,frontHem.index!.count-baseHemIndices,0)
  return {pleats,hood,binding,frontHem}
}


export function createBluefishModel() {
  const root = new Group()
  const hips = joint(root, 'hips', [0, 0, 0])
  const spine = joint(hips, 'spine', [0, .12, 0])
  // One authoring scale for the entire turnaround: 0.0056 world units per
  // reference pixel, floor at y=466 and face origin at y=175.4.
  // Turn the head around its neck attachment rather than its face centre.
  // The child offset retains the original neutral authoring coordinates.
  const headPivot = joint(spine, 'head-pivot', [0, .450, .035])
  const head = joint(headPivot, 'head', [0, .27236, -.025])
  const backHair = joint(head, 'back-hair', [0, 0, 0])
  function drawnPaint(material: Paint, ink = 0x303967, thickness = .0032) {
    material.userData.outlineParameters = { color: new Color(ink).toArray(), thickness }
    material.onBeforeCompile = shader => {
      // Compress highlights into shallow bands, retaining the mesh's
      // material color and the strand/fin colors authored per vertex.
      shader.fragmentShader = shader.fragmentShader.replace('#include <envmap_fragment>', `
        vec3 lightEnergy = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
        vec3 luma = vec3(.2126,.7152,.0722);
        float exposure = dot(lightEnergy,luma) / max(.009, dot(diffuseColor.rgb,luma));
        float paper = .73 + .31 * smoothstep(.27,1.12,exposure);
        outgoingLight = diffuseColor.rgb * paper + reflectedLight.directSpecular * .19 + totalEmissiveRadiance * .30;
        #include <envmap_fragment>
      `)
    }
    return material
  }
  const paint = (color: number, shine = 21) => drawnPaint(new MeshPhongMaterial({
    color, shininess: shine, specular: shine > 28 ? 0x343b68 : 0x1b1c27,
  }))
  const skin = paint(0xffe6dc)
  const skinShading = skin.onBeforeCompile
  skin.onBeforeCompile = (shader, renderer) => {
    skinShading.call(skin, shader, renderer)
    shader.fragmentShader = shader.fragmentShader.replace(
      'float paper = .73 + .31 * smoothstep(.27,1.12,exposure);',
      'float paper = .94 + .07 * smoothstep(.4,.9,exposure);',
    )
  }
  skin.emissive.setHex(0xfabfae)
  skin.emissiveIntensity = .14
  const white = paint(0xfaf5ff), lace = paint(0xe3dff5), edge = paint(0xb7b7e8)
  const dress = paint(0x384487), dressLight = paint(0x414b94), navy = paint(0x263269)
  const hair = paint(0x7484e4, 8), hairShadow = paint(0x4d5fb4, 8), hairLight = paint(0x8596ea, 8)
  const fringeReflections = FRINGE_REFLECTIONS.map((polygon,index) => {
    const vertices = polygon.map(([x,y]) => `vec2(${x}.,${y}.)`).join(',')
    const xs=polygon.map(point=>point[0]), ys=polygon.map(point=>point[1])
    return `float fringeReflection${index}(vec2 p) {
      if (p.x<${Math.min(...xs)-1}. || p.x>${Math.max(...xs)+1}.
        || p.y<${Math.min(...ys)-1}. || p.y>${Math.max(...ys)+1}.) return 0.;
      const vec2 contour[${polygon.length}] = vec2[${polygon.length}](${vertices});
      bool inside = false;
      float nearest = 10000.;
      for (int i=0;i<${polygon.length};i++) {
        vec2 a=contour[i], b=contour[(i+1)%${polygon.length}], edge=b-a, offset=p-a;
        vec2 distance=offset-edge*clamp(dot(offset,edge)/max(dot(edge,edge),.00001),0.,1.);
        nearest=min(nearest,dot(distance,distance));
        float dy=abs(edge.y)<.00001 ? .00001 : edge.y;
        if (((a.y>p.y)!=(b.y>p.y)) && p.x<edge.x*(p.y-a.y)/dy+a.x) inside=!inside;
      }
      return 1.-smoothstep(-.55,.6,(inside ? -1. : 1.)*sqrt(nearest));
    }`
  }).join('\n')+`float fringeReflection(vec2 p) {
    float field=0.;
    ${FRINGE_REFLECTIONS.map((_,index) => `field=max(field,fringeReflection${index}(p));`).join('\n')}
    return field;
  }`
  const hairShading = hair.onBeforeCompile
  hair.onBeforeCompile = (shader, renderer) => {
    hairShading.call(hair, shader, renderer)
    shader.vertexShader = 'attribute float fringeEdge, fringeFace; varying float fringeDistance, fringeSurface; varying vec3 hairPoint;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n hairPoint = position; fringeDistance = fringeEdge; fringeSurface = fringeFace;')
    shader.uniforms.fringeFinish = { value: 0 }
    shader.uniforms.fringeBoundary = { value: new Float32Array(145*2) }
    shader.uniforms.fringeBoundaryCount = { value: 0 }
    shader.uniforms.fringeContourInk = { value: new Color(0x30336e) }
    shader.fragmentShader = `
      varying vec3 hairPoint;
      varying float fringeDistance, fringeSurface;
      uniform float fringeFinish;
      uniform vec3 fringeContourInk;
      uniform vec2 fringeBoundary[145];
      uniform int fringeBoundaryCount;
      float fringeBoundaryDistance(vec2 p) {
        float nearest=10000.;
        for(int i=0;i<144;i++) {
          if(i>=fringeBoundaryCount-1) break;
          vec2 a=fringeBoundary[i], edge=fringeBoundary[i+1]-a;
          vec2 offset=p-a;
          vec2 delta=offset-edge*clamp(dot(offset,edge)/max(dot(edge,edge),.0000000001),0.,1.);
          nearest=min(nearest,dot(delta,delta));
        }
        return sqrt(nearest);
      }
    ` + fringeReflections + '\n' + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      float strand = atan(hairPoint.x, max(.09, .575 - hairPoint.y));
      float tooth = .013 * sin(strand * 31.) + .008 * sin(strand * 53. + .4);
      float rise = .027 * abs(strand) + .009 * sin(strand * 4.);
      float band = smoothstep(.267+rise+tooth,.289+rise+tooth,hairPoint.y) * (1.-smoothstep(.343+rise,.378+rise,hairPoint.y));
      float ribbons = .19 + .81 * pow(abs(sin(strand * 14. + .3 * sin(strand * 5.))),3.);
      vec2 pixel = vec2(257.+hairPoint.x/.0056,175.4-hairPoint.y/.0056);
      float patches = fringeReflection(pixel);
      float shine = mix(band*ribbons*.44,patches*.51,fringeFinish);
      vec3 sheen = mix(vec3(.33,.40,.86),vec3(.34,.37,.97),fringeFinish);
      diffuseColor.rgb = mix(diffuseColor.rgb, sheen, shine);
      // Evaluate the fixed curve in fragment space. Interpolating an unsigned
      // distance through a triangle can turn a thin rim into a polygonal patch.
      float surfaceDistance=fringeFinish>.5 ? fringeBoundaryDistance(hairPoint.xy) : fringeDistance;
      float rimShade = .45*exp(-surfaceDistance/.018)*fringeFinish;
      diffuseColor.rgb = mix(diffuseColor.rgb,vec3(.075,.105,.59),rimShade);
    `)
    // Fine ink is pigment on the curved front shell, not a floating tube.
    // The curve and shell coordinate belong to the lock, independent of the camera.
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      float fringeInkAA=max(.0003,.65*fwidth(surfaceDistance));
      float fringeInk=(1.-smoothstep(.003-fringeInkAA,.003+fringeInkAA,surfaceDistance))
        *smoothstep(.55,.90,fringeSurface);
      outgoingLight=mix(outgoingLight,fringeContourInk,.90*fringeInk);
      #include <opaque_fragment>
    `)
  }
  const tailBlue = 0x7e8fed
  const tailPearl = new Color(0xd0d4fa), tailRim = new Color(0x9ca6e5)
  const tailPaint = drawnPaint(new MeshPhongMaterial({ color: tailBlue, specular: 0x172658, shininess: 27 }), 0x3a4386)
  const shadedPaper = 'float paper = .73 + .31 * smoothstep(.27,1.12,exposure);'
  const tailPaper = 'float paper = .90 + .071 * smoothstep(.27,1.12,exposure);'
  const bellyStripe = `
    float bellyStripe(vec3 radial, float stem) {
      float outer = -.86 * radial.y + stem * (.49 * radial.x - .54 * radial.z);
      float edge = .34 + .25 * stem;
      return smoothstep(edge, edge + .11, outer);
    }
  `
  const tailShading = tailPaint.onBeforeCompile
  tailPaint.onBeforeCompile = (shader, renderer) => {
    tailShading.call(tailPaint, shader, renderer)
    shader.fragmentShader = shader.fragmentShader.replace(shadedPaper, tailPaper)
    shader.vertexShader = 'attribute vec4 tailCoordinate; varying vec4 tailSurface;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n tailSurface = tailCoordinate;')
    shader.uniforms.tailPearl = { value: tailPearl }
    shader.uniforms.tailRim = { value: tailRim }
    shader.fragmentShader = 'varying vec4 tailSurface; uniform vec3 tailPearl, tailRim;\n' + bellyStripe + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      vec3 radial = normalize(tailSurface.yzw);
      float stem = smoothstep(.59,.96,tailSurface.x);
      float stripe = bellyStripe(radial,stem);
      float underside = smoothstep(.65,.89,-.86 * radial.y) * (1. - stem);
      diffuseColor.rgb = mix(diffuseColor.rgb,mix(tailPearl,tailRim,underside),stripe);
      float markings = 0.;
      for (int k = 0; k < 7; k++) {
        float i = float(k);
        float latitude = .22 * (1. - smoothstep(.60,.95,tailSurface.x));
        vec2 spot = vec2((tailSurface.x - (.49 + i * .060)) / (.013 - i * .0006),
          (tailSurface.z - latitude - .12 * sin(i * 2.13)) / .12);
        markings = max(markings, 1. - smoothstep(.65,1.,dot(spot,spot)));
      }
      markings *= smoothstep(.23,.55,abs((radial.x + radial.z) * .707107));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.55,.61,.91), markings);
    `)
  }
  const tailFin = paint(tailBlue, 24), tailMark = paint(0xc0c5fa)
  tailFin.userData.outlineParameters = { visible: false }
  const earFin = paint(0x7d8deb, 12)
  earFin.userData.outlineParameters = { visible: false }
  const earShading = earFin.onBeforeCompile
  earFin.onBeforeCompile = (shader, renderer) => {
    earShading.call(earFin, shader, renderer)
    shader.fragmentShader = shader.fragmentShader.replace(shadedPaper,
      'float paper = .93 + .079 * smoothstep(.31,1.07,exposure);')
    shader.uniforms.earPearl = { value: new Color(0xf0ecfa) }
    shader.uniforms.earSpot = { value: new Color(0xe5e8fb) }
    shader.vertexShader = 'attribute vec3 earCoordinate; varying vec3 earPoint;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n earPoint = earCoordinate;')
    shader.fragmentShader = `varying vec3 earPoint;
      uniform vec3 earPearl;
      uniform vec3 earSpot;
      float earMark(vec2 point, vec2 center, float radius) {
        vec2 q = (point - center) / vec2(.78 * radius, .91 * radius);
        return 1. - smoothstep(.75,1.04,dot(q,q));
      }
    ` + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      float u = clamp((earPoint.x - .018) / .362,0.,1.);
      float root = 1. - smoothstep(.018,.095,earPoint.x);
      float inner = (earPoint.x - .118) / .046;
      float hem = -.041 - .062 * pow(max(0.,sin(3.14159 * u)),1.12) - .009 * (1. - u)
        - .044 * root + .014 * exp(-inner * inner);
      float membrane = 1. - smoothstep(hem - .003,hem + .003,earPoint.y);
      float fold = (earPoint.x - .087 + .080 * (earPoint.y + .14)) / .025;
      float crease = (earPoint.x - .184) / .021;
      float rimFold = (hem - earPoint.y - .014) / .035;
      float valley = (.37 * exp(-fold * fold) + .22 * exp(-crease * crease)) *
        smoothstep(-.205,-.104,earPoint.y) + .20 * exp(-rimFold * rimFold);
      vec3 pearl = mix(earPearl,vec3(.42,.43,.76),valley);
      diffuseColor.rgb = mix(diffuseColor.rgb,pearl,membrane);
      float spots = max(earMark(earPoint.xy,vec2(.202,.019),.016),
        max(earMark(earPoint.xy,vec2(.241,-.023),.013),earMark(earPoint.xy,vec2(.302,-.054),.004)));
      diffuseColor.rgb = mix(diffuseColor.rgb,earSpot,spots * (1. - membrane));
      float rim = (1. - smoothstep(.0020,.0094,earPoint.z)) * smoothstep(.010,.077,earPoint.x);
      diffuseColor.rgb = mix(diffuseColor.rgb,vec3(.049,.060,.19),rim * .90);
    `)
  }
  const finShading = tailFin.onBeforeCompile
  tailFin.onBeforeCompile = (shader, renderer) => {
    finShading.call(tailFin, shader, renderer)
    shader.fragmentShader = shader.fragmentShader.replace(shadedPaper, tailPaper)
    shader.uniforms.tailPearl = { value: tailPearl }
    shader.vertexShader = 'attribute vec3 finCoordinate; varying vec3 finPoint, finSurface;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n finPoint = finCoordinate; finSurface = position;')
    shader.fragmentShader = 'varying vec3 finPoint, finSurface; uniform vec3 tailPearl;\n' + bellyStripe + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      float x = abs(finPoint.x);
      float boundary = .024 + .355 * pow(clamp(x / .44, 0., 1.), .85);
      float lobe = (x - .25) / .12;
      boundary += .055 * smoothstep(.26,.43,x) - .021 * exp(-lobe * lobe);
      float pale = (1. - smoothstep(boundary - .009, boundary + .009, finPoint.y)) *
        smoothstep(.025,.133,finPoint.y + x * .34);
      // The stem rises diagonally into the fork. Continue its radial stripe
      // across the overlap before letting the pale lobes fan out.
      float depth = finSurface.z + .255 * finSurface.y;
      vec3 radial = normalize(vec3(finSurface.x,.255 * depth,depth));
      float throat = bellyStripe(radial,1.);
      pale = mix(throat,pale,smoothstep(-.025,.13,finPoint.y));
      diffuseColor.rgb = mix(diffuseColor.rgb,tailPearl,pale);
      float crease = .349 - finPoint.y;
      float fold = (finPoint.x + .004 + .24 * crease) / .011;
      float fork = exp(-fold * fold) * smoothstep(-.012,.015,crease) * (1. - smoothstep(.034,.107,crease));
      diffuseColor.rgb = mix(diffuseColor.rgb,vec3(.066,.084,.245),fork * .42);
      float ink = (1. - smoothstep(.0006,.0030,finPoint.z)) * smoothstep(.025,.158,finPoint.y);
      diffuseColor.rgb = mix(diffuseColor.rgb,vec3(.050,.058,.150),ink * .73);
    `)
  }
  const seam = paint(0x3c4687)
  skin.userData.outlineParameters = { color: new Color(0x926377).toArray(), thickness: .0027 }
  for (const cloth of [white, lace, edge]) {
    cloth.userData.outlineParameters = { color: new Color(0x8a81b2).toArray(), thickness: .0025 }
  }
  for (const material of [hair,hairLight,hairShadow]) material.userData.outlineParameters.thickness = .0015
  const crownPaint=hair.clone()
  crownPaint.onBeforeCompile=hair.onBeforeCompile
  hair.userData.outlineParameters={visible:false}
  const hairInk=paint(0x30336e)
  hairInk.userData.outlineParameters={visible:false}
  const unit = new SphereGeometry(1, 28, 18)

  function joint(parent: Layer, name: string, at: Vec) {
    const bone = new Bone()
    bone.name = name
    bone.position.set(...at)
    parent.add(bone)
    return bone
  }

  function surface(parent: Layer, geometry: BufferGeometry, material: Paint, at: Vec = [0, 0, 0]) {
    const mesh = new Mesh(geometry, material)
    mesh.position.set(...at)
    parent.add(mesh)
    return mesh
  }

  function ball(parent: Layer, material: Paint, at: Vec, radii: Vec, roll = 0) {
    const mesh = surface(parent, unit, material, at)
    mesh.scale.set(...radii)
    mesh.rotation.z = roll
    return mesh
  }

  function shape(parent: Layer, material: Paint, at: Vec, start: readonly [number, number], curves: readonly Curve[], thickness: number) {
    const profile = new Shape()
    profile.moveTo(...start)
    for (const curve of curves) profile.bezierCurveTo(...curve)
    profile.closePath()
    return surface(parent, new ExtrudeGeometry(profile, {
      depth: thickness, bevelEnabled: true, bevelSegments: 2, bevelSize: .014, bevelThickness: .012, curveSegments: 13,
    }), material, at)
  }

  function line(parent: Layer, material: Paint, points: readonly Vec[], radius: number) {
    const curve = new CatmullRomCurve3(points.map(point => new Vector3(...point)))
    return surface(parent, new TubeGeometry(curve, 16, radius, 6, false), material)
  }

  surface(head,scalpGeometry(),crownPaint).name = 'hair-scalp'
  const face = createBluefishFace(head, skin)
  const finRootPaint = paint(0xf5c8c7, 9)
  finRootPaint.userData.outlineParameters = { visible: false }
  for (const side of [-1, 1] as const) {
    const finRoot = ball(head, finRootPaint, [side * .323, -.107, -.163], [.111,.052,.023])
    finRoot.rotation.x = -.39
    const finEar = joint(head, 'head-fin', [side * .392, .048, -.112])
    finEar.rotation.y = side * EAR_TURN
    finEar.scale.x = EAR_SPAN
    surface(finEar, earGeometry(side), earFin)
  }

  // Each overlapping lock has a sculpted silhouette. Wrap the profiles
  // around the forehead instead of mounting them as a flat plate.
  const fringe = joint(head, 'fringe', [0, 0, 0])
  function foreheadPaint(boundary: readonly Vector2[]) {
    const contour=new Float32Array(145*2)
    boundary.forEach((point,i)=>{contour[2*i]=point.x;contour[2*i+1]=point.y})
    const material = hair.clone()
    material.color.setHex(0x6d7fe0)
    material.onBeforeCompile = (shader, renderer) => {
      hair.onBeforeCompile(shader, renderer)
      shader.uniforms.fringeFinish.value = 1
      shader.uniforms.fringeBoundary.value = contour
      shader.uniforms.fringeBoundaryCount.value = boundary.length
      // The design keeps the forehead's blue broad and luminous. Preserve
      // the modeled fold ink while compressing diffuse illumination only.
      shader.fragmentShader = shader.fragmentShader.replace(
        'float paper = .73 + .31 * smoothstep(.27,1.12,exposure);',
        'float paper = .92 + .10 * smoothstep(.27,1.12,exposure);',
      )
    }
    return material
  }
  const shoulderLocks = createBluefishHair(backHair, fringe)
  function bang(material: Paint, start: readonly [number, number], curves: readonly Curve[], layer: number) {
    const profile = new Shape().moveTo(...start)
    for (const curve of curves) profile.bezierCurveTo(...curve)
    profile.closePath()
    const mesh = surface(fringe, new ExtrudeGeometry(profile, {
      // The narrow fork uses the sculpted front/return thickness directly;
      // offset bevel rings would cross inside its concave root.
      depth: .028, bevelEnabled: layer<=.05, bevelSegments: 3, bevelSize: .003,
      bevelThickness: .004, curveSegments: 24,
    }), material === hair ? foreheadPaint(profile.getPoints(24)) : material)
    const shell = refineProfile(mesh.geometry, .022)
    mesh.geometry.dispose()
    mesh.geometry = shell
    const points = mesh.geometry.attributes.position
    const boundary=profile.getPoints(12)
    function surfaceDepth(x: number, y: number) {
      const sphere = Math.sqrt(Math.max(.18, 1 - (x / .56) ** 2 - ((y - .10) / .58) ** 2))
      const temple = Math.max(0, Math.min(1, (Math.abs(x) - .23) / .12))
      const lower = Math.max(0, Math.min(1, (.19 - y) / .23))
      const crown = Math.max(0, Math.min(1, (y - .10) / .45))
      const sweep = .082 + .070 * crown * crown * (3 - 2 * crown)
      const eyeSide = Math.max(0, Math.min(1, (Math.abs(x) - .19) / .103))
      const eyeClearance = .085 * eyeSide * eyeSide * (3 - 2 * eyeSide)
        * Math.exp(-(((y - .09) / .108) ** 4))
      const pixel = 175.4-y/.0056
      const gather = Math.max(0,Math.min(1,(pixel-75)/2))
      const fall = Math.max(0,Math.min(1,(pixel-80)/6))
      const rootLayer = .4*gather*gather*(3-2*gather)+.6*fall*fall*(3-2*fall)
      const profile = .018 + sphere * .386 + layer*rootLayer - .132 * temple * lower - sweep - eyeClearance
      const sculpted = fringeProfileDepth(y, bluefishTempleDepth(x, y, profile, .042), layer>0)
      const skinDepth = bluefishFaceClearanceDepth(x, y)
      if (skinDepth === undefined) return sculpted
      const clearance = skinDepth+.020, difference = sculpted-clearance
      return clearance+.5*(difference+Math.sqrt(difference*difference+.004*.004))
    }
    const rimDistances: number[] = [], frontShell: number[] = []
    for (let i = 0; i < points.count; i++) {
      const x = points.getX(i), y = points.getY(i)
      const front = surfaceDepth(x, y)
      const depth = Math.min(1, Math.max(0, (points.getZ(i) + .004) / .036))
      let edgeDistance=Infinity
      for(let j=0;j<boundary.length-1;j++) {
        const a=boundary[j],b=boundary[j+1],dx=b.x-a.x,dy=b.y-a.y
        const t=Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/(dx*dx+dy*dy||1)))
        edgeDistance=Math.min(edgeDistance,Math.hypot(x-a.x-dx*t,y-a.y-dy*t))
      }
      rimDistances.push(edgeDistance)
      frontShell.push(depth)
      const rootTurn = layer > .03 ? .032 * Math.exp(-((x / .145) ** 4) - (((y - .146) / .070) ** 4)) : 0
      // A rounded lock has a full front and a thin returning edge. Its
      // cross-section belongs to the mesh and remains fixed at every view.
      const dome = .014 * (1-Math.exp(-edgeDistance/.026))
        * MathUtils.smoothstep(y,.08,.22) * (1-MathUtils.smoothstep(y,.46,.55))
      const length = .014 + .10 * (1 - Math.exp(-edgeDistance / .045)) + Math.max(0, y - .20) * .10 + rootTurn
      points.setZ(i, front + dome * depth - length * (1 - depth))
    }
    mesh.geometry.setAttribute('fringeEdge',new Float32BufferAttribute(rimDistances,1))
    mesh.geometry.setAttribute('fringeFace',new Float32BufferAttribute(frontShell,1))
    points.needsUpdate = true
    mesh.geometry.computeVertexNormals()
    mesh.geometry.computeBoundingSphere()
    const fittedDepth = profileFrontDepth(mesh.geometry)
    return (x: number, y: number) => fittedDepth(x, y) ?? surfaceDepth(x, y)
  }
  // Coordinates are measured against the front-view design sheet. They
  // define geometry; the reference image is never loaded by the renderer.
  function frontLock(material: Paint, start: readonly [number,number], curves: readonly Curve[], layer: number,
    strands: readonly (readonly (readonly [number, number])[])[] = []) {
    const x = (n: number) => (n - 257) * .0056
    const y = (n: number) => (175.4-n)*.0056
    const depth = bang(material, [x(start[0]),y(start[1])], curves.map(([a,b,c,d,e,f]) =>
      [x(a),y(b),x(c),y(d),x(e),y(f)]), layer)
    for (const strand of strands) {
      const guide = new CatmullRomCurve3(strand.map(([a, b]) => new Vector3(x(a), y(b), 0)))
      // Project every sample onto the forehead lock. Interpolating just
      // the control points' depths lets the stroke dip through its surface.
      const stroke = new class extends SpatialCurve<Vector3> {
        constructor() { super() }
        getPoint(t: number, target = new Vector3()) {
          guide.getPoint(t, target)
          target.z = depth(target.x, target.y) + .0018
          return target
        }
      }()
      surface(fringe, new TubeGeometry(stroke, 120, .0015, 6), hairInk).name = 'fringe-strand'
    }
  }
  // The boundary control points follow the exposed hair contours, not
  // the bounding boxes. Bevels are inset enough to retain these silhouettes.
  frontLock(hair,[253,77],[
    [222,74,196,99,182,128],[176,144,169,152,157,158],
    [166,165,179,158,187,151],[202,131,219,93,253,77],
  ],-.014)
  frontLock(hair,[253,77],[
    [224,75,197,94,185,122],[176,144,174,165,183,180],
    [187,186,194,190,199,190],[195,178,196,172,205,163],
    [219,146,230,131,235,115],[240,97,243,84,253,77],
  ],.012, [[[232,90],[218,107],[207,127],[196,146],[188,168]]])
  frontLock(hair,[249,80],[
    [238,86,233,108,235,130],[236,144,241,159,247,161],
    [242,152,242,139,243,127],[247,107,254,94,249,80],
  ],.033)
  frontLock(hair,[252,78],[
    [241,82,237,103,240,129],[240,149,247,164.7,270.5,165.5],
    // The main tip and narrow right tip divide around a real open notch.
    [269,163,267.6,153,267.6,150],[267.6,147,269.2,155,274,160],
    [273.2,150,277.2,139,277,126],[279,103,270,81,252,78],
  ],.056, [[[248,89],[247,103],[250,120],[253,130],[257,137]]])
  frontLock(hair,[260,78],[
    [298,80,323,111,331,139],[335,147,341,154,349,158],
    [339,164,329,158,323,153],[311,133,300,110,288,94],
    [278,84,267,79,260,78],
  ],-.008)
  frontLock(hair,[257,79],[
    [282,82,299,105,312,134],[321,154,328,164,340,163],
    [328,176,315,168,300,155],[285,142,271,106,264,88],
    [260,82,259,80,257,79],
  ],.017, [[[272,90],[282,107],[290,129],[303,149],[321,158]]])

  const curlX = (x: number) => (x - 257) * .0056
  const curlY = (y: number) => (175.4 - y) * .0056
  const curlProfile: readonly Curve[] = [
    [183,65,178,49,190,33],[199,18,218,8,239,9],
    [260,8,280,16,277,32],[277,35,275,38,272,40],
    [279,26,258,13,241,17],[224,20,210,32,205,46],
    [202,57,204,64,210,68],[207,70,200,72,196,74],
  ]
  // The root and tip follow the side profile. Across the wider part of the
  // lock, the section turns outward before it folds back toward the crown.
  const curlDepths = [
    [8,223,204,.54], [13,228,207,.53],
    [19,200,188,.73], [30,191,180,.77],
    [42,184,176,.57], [52,181,177,.42], [62,183,182,.49], [75,196,194,.61],
  ] as const
  const curlTurn = [
    [15,223,208,.65], [21,211,203,.63], [26,205,199,.61],
    [31,200,192,.58], [42,194,188,.57], [52,193,188,.50],
    [62,196,190,.47], [74,201,194,.54],
  ] as const
  function sampleCurl(profile: readonly (readonly [number, number, number, number])[],
    x: number, y: number, direction: number) {
    const upper = profile.findIndex(row => row[0] > y)
    const i = upper < 0 ? profile.length - 1 : Math.max(1, upper)
    const a = profile[i - 1], b = profile[i]
    const before = profile[Math.max(0, i - 2)], after = profile[Math.min(profile.length - 1, i + 1)]
    const height = b[0] - a[0]
    const u = Math.max(0, Math.min(1, (y - a[0]) / height))
    const side = ([, center, depth, slope]: (typeof profile)[number]) => depth + direction * (x - center) * slope
    const start = side(a), end = side(b)
    const middle = (end - start) / height
    const from = (start - side(before)) / (a[0] - before[0] || 1)
    const to = (side(after) - end) / (after[0] - b[0] || 1)
    const tangent = (slope: number) => slope * middle > 0 ? 2 * slope * middle / (slope + middle) : 0
    return start + (end - start) * u * u * (3 - 2 * u)
      + height * u * (1 - u) * (tangent(from) * (1 - u) - tangent(to) * u)
  }
  function curlTwist(x: number, y: number) {
    const enter = Math.max(0, Math.min(1, (y - 22) / 17))
    const exit = Math.max(0, Math.min(1, (75 - y) / 15))
    const width = Math.max(0, Math.min(1, (247 - x) / 22))
    return .45 * enter * enter * (3 - 2 * enter) * exit * exit * (3 - 2 * exit) * width * width * (3 - 2 * width)
  }
  function curlDepth(x: number, y: number) {
    const sourceX = 257 + x / .0056
    const sourceY = 175.4 - y / .0056
    const side = sampleCurl(curlDepths, sourceX, sourceY, 1)
    const tipRise = Math.max(0, Math.min(1, (sourceY - 25) / 15))
    const tip = Math.max(0, Math.min(1, (sourceX - 230) / 41)) * tipRise * tipRise * (3 - 2 * tipRise)
    const tipSide = 251.5 + (sourceX - 276) * .36
    const profileSide = side + (tipSide - side) * tip
    const twist = curlTwist(sourceX, sourceY)
    const turn = sampleCurl(curlTurn, sourceX, sourceY, -1)
    const sweep = 2.1 * Math.max(0, Math.min(1, (sourceY - 15) / 10))
      * Math.max(0, Math.min(1, (75 - sourceY) / 13)) * Math.max(0, Math.min(1, (247 - sourceX) / 22))
      * (1 - .50 * Math.max(0, Math.min(1, (sourceY - 27) / 14)))
    return (198 - (profileSide + (turn - profileSide) * twist + sweep)) * .0056
  }
  const curlOutline = new Shape().moveTo(curlX(196), curlY(74))
  for (const [a,b,c,d,e,f] of curlProfile) {
    curlOutline.bezierCurveTo(curlX(a),curlY(b),curlX(c),curlY(d),curlX(e),curlY(f))
  }
  curlOutline.closePath()
  const curlBlank = new ExtrudeGeometry(curlOutline, {
    depth: .018, bevelEnabled: true, bevelThickness: .003, bevelSize: .0025, bevelSegments: 2, curveSegments: 24,
  })
  const curl = refineProfile(curlBlank, .018)
  curlBlank.dispose()
  const curlPoints = curl.attributes.position
  const curlBoundary = curlOutline.getPoints(16)
  const curlGlint = [[188,49],[197,33],[213,22],[230,15],[245,13]].map(([x,y]) => ({ x: curlX(x), y: curlY(y) }))
  const curlColors: number[] = []
  for (let i = 0; i < curlPoints.count; i++) {
    const x = curlPoints.getX(i), y = curlPoints.getY(i)
    const tip = Math.max(0, Math.min(1, (x - curlX(248)) / .17))
    const twist = curlTwist(257 + x / .0056, 175.4 - y / .0056)
    const edge = distanceToProfile(curlBoundary, x, y)
    const dome = 1 - Math.exp(-edge / .022)
    const thickness = .0118 * (1 - .73 * tip) + .019 * 4 * twist * (1 - twist) * dome
    const face = (curlPoints.getZ(i) - .009) / .012
    curlPoints.setZ(i, curlDepth(x, y) + face * thickness)
    const rim = .49 * Math.exp(-edge / .010)
    const glint = .28 * Math.exp(-((distanceToProfile(curlGlint, x, y) / .008) ** 2))
    curlColors.push(1 - rim + glint, 1 - rim * .91 + glint, 1 - rim * .64 + glint * .68)
  }
  curl.setAttribute('color', new Float32BufferAttribute(curlColors, 3))
  curl.computeVertexNormals()
  const curlRootPaint = paint(0x6879d6, 9)
  curlRootPaint.userData.outlineParameters = { visible: false }
  const curlPaint = curlRootPaint.clone()
  curlPaint.onBeforeCompile = curlRootPaint.onBeforeCompile
  curlPaint.vertexColors = true
  surface(head, curl, curlPaint)
  line(head, curlRootPaint, [[curlX(196),curlY(74),curlDepth(curlX(196),curlY(74))],[-.289,.534,-.012],[-.251,.489,-.061],[-.209,.446,-.103]], .022)

  // Nine closed box pleats join the crown band and the shallow rear cap.
  // Root contact is sampled from the unchanged scalp authoring surface.
  head.updateWorldMatrix(true, true)
  const bonnetHeadFrame = new Matrix4().copy(head.matrixWorld).invert()
  const crownPositions: number[] = [], crownIndices: number[] = []
  head.traverse(object => {
    if (!(object instanceof Mesh)) return
    if (object.name !== 'hair-scalp') return
    const geometry = object.geometry, positions = geometry.attributes.position
    const matrix = new Matrix4().multiplyMatrices(bonnetHeadFrame, object.matrixWorld)
    const offset = crownPositions.length / 3, point = new Vector3()
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(matrix)
      crownPositions.push(point.x, point.y, point.z)
    }
    if (geometry.index) for (let i = 0; i < geometry.index.count; i++) crownIndices.push(offset + geometry.index.getX(i))
    else for (let i = 0; i < positions.count; i++) crownIndices.push(offset + i)
  })
  const crownContact = new BufferGeometry()
  crownContact.setAttribute('position', new Float32BufferAttribute(crownPositions, 3))
  crownContact.setIndex(crownIndices)
  const crownFront = profileFrontDepth(crownContact)
  const crownSides = [bonnetSideDepth(crownContact,1),bonnetSideDepth(crownContact,-1)]
  const crownRoof=bonnetCrownHeight(crownContact)
  const rearPositions:number[]=[],rearIndices:number[]=[]
  head.traverse(object=>{
    if(!(object instanceof Mesh))return
    let back=object.name==='hair-scalp'
    for(let parent=object.parent;parent&&parent!==head;parent=parent.parent)if(parent.name==='back-hair')back=true
    if(!back)return
    const geometry=object.geometry,points=geometry.attributes.position,matrix=new Matrix4().multiplyMatrices(bonnetHeadFrame,object.matrixWorld),offset=rearPositions.length/3,p=new Vector3()
    for(let i=0;i<points.count;i++){p.fromBufferAttribute(points,i).applyMatrix4(matrix);rearPositions.push(p.x,p.y,-p.z)}
    for(let i=0;i<(geometry.index?.count??points.count);i+=3){const ids=[0,1,2].map(j=>geometry.index?geometry.index.getX(i+j):i+j);if(Math.max(...ids.map(id=>rearPositions[(offset+id)*3+1]))>.38)rearIndices.push(offset+ids[0],offset+ids[2],offset+ids[1])}
  })
  const rearContact=new BufferGeometry();rearContact.setAttribute('position',new Float32BufferAttribute(rearPositions,3));rearContact.setIndex(rearIndices)
  const crownBack=profileFrontDepth(rearContact);rearContact.dispose()
  crownContact.dispose()
  const bonnetPaint = paint(0xffffff)
  bonnetPaint.vertexColors = true
  const bonnetShading = bonnetPaint.onBeforeCompile
  bonnetPaint.onBeforeCompile = (shader, renderer) => {
    bonnetShading.call(bonnetPaint, shader, renderer)
    shader.fragmentShader = shader.fragmentShader.replace(shadedPaper,
      'float paper = .98 + .025 * smoothstep(.27,1.12,exposure);')
  }
  bonnetPaint.userData.outlineParameters = {visible:false}
  const bonnetInk = paint(0x41375e)
  bonnetInk.userData.outlineParameters = { visible: false }
  const bonnetFoldInk=bonnetInk.clone();bonnetFoldInk.onBeforeCompile=bonnetInk.onBeforeCompile
  bonnetFoldInk.stencilWrite=true;bonnetFoldInk.stencilRef=8;bonnetFoldInk.stencilFunc=NotEqualStencilFunc;bonnetFoldInk.stencilFuncMask=8;bonnetFoldInk.stencilWriteMask=0
  const bonnetRim = paint(0x706993)
  bonnetRim.userData.outlineParameters = { visible: false }
  const bonnetParts=bonnetAssembly(crownFront,crownSides,crownRoof,crownBack)
  const bonnetFrontPaint=bonnetPaint.clone()
  bonnetFrontPaint.onBeforeCompile=bonnetPaint.onBeforeCompile
  bonnetFrontPaint.userData.outlineParameters={visible:false}
  const bandPaint=paint(0xfdf7fc)
  bandPaint.userData.outlineParameters={color:new Color(0x443a65).toArray(),thickness:.0032}
  const bonnetRearPaint=bonnetPaint.clone(),rearShading=bonnetPaint.onBeforeCompile
  bonnetRearPaint.onBeforeCompile=(shader,renderer)=>{
    rearShading.call(bonnetRearPaint,shader,renderer)
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nattribute vec4 bonnetRearCoordinate;\nvarying vec4 bonnetRearSewn;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nbonnetRearSewn=bonnetRearCoordinate;')
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec4 bonnetRearSewn;')
      .replace('#include <color_fragment>',`#include <color_fragment>
        float rearPhase=fract(bonnetRearSewn.x*9.);
        float rearRise=max(0.,bonnetRearSewn.y);
        float rearEdge=min(rearPhase,1.-rearPhase);
        float rearAcross=(rearPhase-.53)/(.09+.06*sqrt(rearRise));
        float rearHeight=(rearRise-.20)/.23;
        float rearGather=exp(-rearAcross*rearAcross-rearHeight*rearHeight*rearHeight*rearHeight);
        float rearFold=rearEdge/.065;
        rearFold=exp(-rearFold*rearFold)*(1.-smoothstep(.35,.90,rearRise));
        float rearPigment=(.53*rearGather+.32*rearFold)*smoothstep(-.08,.02,bonnetRearSewn.y)*bonnetRearSewn.w;
        diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.319,.305,.584),clamp(rearPigment,0.,.75));`)
  }
  bonnetRearPaint.customProgramCacheKey=()=> 'bluefish-bonnet-rear-sewn-264'
  const bonnetMeshes:Mesh[]=[
    surface(head,bonnetParts.pleats,bonnetFrontPaint),
    surface(head,bonnetParts.hood,bonnetRearPaint),
    surface(head,bonnetParts.binding,bandPaint),
    surface(head,bonnetParts.frontHem,bonnetInk),
  ]
  bonnetMeshes[0].name='bonnet-front-pleats'
  bonnetMeshes[1].name='bonnet-rear-cap'
  bonnetMeshes[2].name='bonnet-binding'
  bonnetMeshes[3].name='bonnet-front-hem'
  bonnetMeshes[3].renderOrder=1
  bonnetMeshes[3].material=[bonnetInk,bonnetFoldInk]
  for(const mesh of bonnetMeshes.slice(0,3)){
    const material=mesh.material as Paint
    material.stencilWrite=true;material.stencilRef=8;material.stencilFunc=AlwaysStencilFunc
    material.stencilWriteMask=8;material.stencilZPass=ReplaceStencilOp
  }
  const capContourPaint=new MeshBasicMaterial({color:0x443a65,side:BackSide,depthWrite:false,stencilWrite:true,stencilRef:8,stencilFunc:NotEqualStencilFunc,stencilFuncMask:8,stencilWriteMask:0})
  capContourPaint.userData.outlineParameters={visible:false}
  capContourPaint.onBeforeCompile=shader=>{
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#if !defined(USE_ENVMAP) && !defined(USE_SKINNING)
      #include <beginnormal_vertex>
      #include <morphnormal_vertex>
      #endif
      #include <begin_vertex>`).replace('#include <morphtarget_vertex>',`#include <morphtarget_vertex>
      transformed+=normalize(objectNormal)*.0030;`)
  }
  const capContour=new Mesh(bonnetParts.hood,capContourPaint)
  capContour.name='bonnet-cap-contour';capContour.renderOrder=1;head.add(capContour);bonnetMeshes.push(capContour)
  const frillContour=new Mesh(bonnetParts.pleats,capContourPaint)
  frillContour.name='bonnet-front-contour';frillContour.renderOrder=1;head.add(frillContour);bonnetMeshes.push(frillContour)


  function ribbonBoundary(geometry: BufferGeometry) {
    const { shapes } = (geometry as ExtrudeGeometry).parameters
    return (Array.isArray(shapes) ? shapes[0] : shapes).getPoints(12)
  }

  function distanceToProfile(edge: readonly { x: number, y: number }[], x: number, y: number) {
    let distance = Infinity
    for (let j = 1; j < edge.length; j++) {
      const a = edge[j - 1], b = edge[j], dx = b.x - a.x, dy = b.y - a.y
      const f = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)))
      distance = Math.min(distance, Math.hypot(x - a.x - dx * f, y - a.y - dy * f))
    }
    return distance
  }

  const apronLoops: Mesh[] = []
  // These marks use the cloth's authoring coordinates. They stay on the
  // same solid surface through skinning, swimming and camera corrections.
  function finishBackRibbon(material: Paint, part: 'loop' | 'tail' | 'knot') {
    const shading = material.onBeforeCompile
    material.onBeforeCompile = (shader, renderer) => {
      shading.call(material,shader,renderer)
      shader.uniforms.ribbonInk = { value: new Color(0x4e4d79) }
      shader.uniforms.ribbonFold = { value: new Color(0xaaa7d4) }
      shader.vertexShader = 'attribute vec3 ribbonCoordinate; varying vec3 ribbonSewn;\n'+shader.vertexShader
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\n ribbonSewn=ribbonCoordinate;')
      shader.fragmentShader = 'uniform vec3 ribbonInk,ribbonFold; varying vec3 ribbonSewn;\n'+shader.fragmentShader
      const crease = part === 'loop' ? `
        vec2 pinched=(vec2(abs(ribbonSewn.x),ribbonSewn.y)-vec2(.325,.025))/vec2(.215,.064);
        float oval=length(pinched);
        float aa=max(.035,fwidth(oval));
        float fold=1.-smoothstep(.92-aa,1.+aa,oval);
        diffuseColor.rgb=mix(diffuseColor.rgb,ribbonFold,.83*fold);
      ` : part === 'tail' ? `
        float fall=max(0.,-ribbonSewn.y-.04);
        float crease=abs(abs(ribbonSewn.x)-.14-.54*fall);
        float width=max(.009,.65*fwidth(crease));
        float fold=(1.-smoothstep(width*.35,width,crease))*(1.-smoothstep(.25,.95,fall));
        diffuseColor.rgb=mix(diffuseColor.rgb,ribbonFold,.88*fold);
      ` : `
        float turns=smoothstep(.095,.145,abs(ribbonSewn.y));
        diffuseColor.rgb=mix(diffuseColor.rgb,ribbonFold,.25*turns);
      `
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>',
        '#include <color_fragment>\n'+crease)
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
        float ribbonHemWidth=max(.010,.65*fwidth(ribbonSewn.z));
        float ribbonHem=1.-smoothstep(ribbonHemWidth*.40,ribbonHemWidth,ribbonSewn.z);
        outgoingLight=mix(outgoingLight,ribbonInk,.91*ribbonHem);
        #include <opaque_fragment>
      `)
    }
    material.customProgramCacheKey = () => 'bluefish-back-ribbon-'+part
  }
  // A triangle's greatest outward coordinate bounds its entire surface.
  // Querying an element-sized neighborhood also covers narrow hair ink tubes.
  function headContactEnvelope(positions:readonly number[],indices:readonly number[],padding:readonly number[]) {
    const cell=.025,records:number[]=[],bins=new Map<string,number[]>()
    for(let t=0;t<indices.length;t+=3){
      const ids=[indices[t],indices[t+1],indices[t+2]],i=records.length/5
      const a=Math.min(...ids.map(v=>positions[3*v]-padding[2*v])),b=Math.min(...ids.map(v=>positions[3*v+1]))
      const c=Math.max(...ids.map(v=>positions[3*v]+padding[2*v])),d=Math.max(...ids.map(v=>positions[3*v+1]))
      const top=Math.max(...ids.map(v=>positions[3*v+2]+padding[2*v+1]))
      records.push(a,b,c,d,top)
      for(let x=Math.floor(a/cell);x<=Math.floor(c/cell);x++)for(let y=Math.floor(b/cell);y<=Math.floor(d/cell);y++){
        const key=x+':'+y,list=bins.get(key);if(list)list.push(i);else bins.set(key,[i])
      }
    }
    return (x:number,y:number,radius:number)=>{
      let top=-Infinity;const seen=new Set<number>()
      for(let a=Math.floor((x-radius)/cell);a<=Math.floor((x+radius)/cell);a++)for(let b=Math.floor((y-radius)/cell);b<=Math.floor((y+radius)/cell);b++)for(const i of bins.get(a+':'+b)??[]){
        if(seen.has(i))continue;seen.add(i);const k=i*5
        if(records[k]<=x+radius&&records[k+2]>=x-radius&&records[k+1]<=y+radius&&records[k+3]>=y-radius)top=Math.max(top,records[k+4])
      }
      return Number.isFinite(top)?top:undefined
    }
  }

  function headTailRestPoint(x:number,y:number,z:number,outside:boolean,outward:number,target=new Vector3()) {
    const t=MathUtils.clamp((-y-.15)/.90,0,1)
    const bend=Math.min(1,t/(outside?1:.86)),eased=bend*bend*(3-2*bend)
    const flare=.115*Math.exp(-(((t-.54)/.19)**2)),settle=MathUtils.clamp((t-.34)/.51,0,1)
    const drape=outside?.23*eased:.23+.62*eased+flare-.26*settle*settle*(3-2*settle)
    const turnIn=outside?0:.240*eased
    return outside?target.set(x+outward*(.57*drape-turnIn),y,z+.76*drape+.32*turnIn+.024*t*Math.sin(11*x))
      :target.set(x,y,z+.08*Math.sin(Math.PI*t)+.08*t)
  }

  // Triangulate in physical head Y/Z, then duplicate that same chart for
  // both skins. The authored drape is inverted only for pigment/rest depth.
  function fittedHeadTail(object:Mesh,toHead:Matrix4,side:number,contact:BonnetDepth & {envelope?:(x:number,y:number,radius:number)=>number|undefined}) {
    const author=object.geometry.userData.headTailAuthor as {
      start:readonly[number,number];curves:readonly Curve[];outside:boolean;outward:number
    }
    const profile=new Shape().moveTo(...author.start)
    for(const curve of author.curves)profile.bezierCurveTo(...curve)
    profile.closePath()
    const sourceEdge=profile.getPoints(24)
    if(sourceEdge[0].distanceTo(sourceEdge[sourceEdge.length-1])<1e-10)sourceEdge.pop()
    const chart=new Shape(),point=new Vector3(),origin=headTailRestPoint(0,0,.0315,author.outside,author.outward).applyMatrix4(toHead)
    for(let i=0;i<sourceEdge.length;i++){
      const p=headTailRestPoint(sourceEdge[i].x,sourceEdge[i].y,.0315,author.outside,author.outward,point).applyMatrix4(toHead)
      if(i===0)chart.moveTo(p.y,p.z);else chart.lineTo(p.y,p.z)
    }
    chart.closePath()
    const flat=new ShapeGeometry(chart,1),cap=refineProfile(flat,.007);flat.dispose()
    const source=cap.attributes.position,sourceIndex=cap.index!,n=source.count
    const positions:number[]=[],colors:number[]=[],coordinates:number[]=[],indices:number[]=[],edge=profile.getPoints(12)
    const half=.0024,clearance=.012,e=toHead.elements,det=e[1]*e[6]-e[5]*e[2]
    const middles:{x:number;y:number;z:number;authorX:number;authorY:number}[]=[]
    let maxInverseResidual=0
    for(let i=0;i<n;i++){
      const y=source.getX(i),z=source.getY(i),dy=y-origin.y,dz=z-origin.z
      let x=(dy*e[6]-dz*e[5])/det,v=(e[1]*dz-e[2]*dy)/det,residual=Infinity
      for(let step=0;step<12;step++){
        headTailRestPoint(x,v,.0315,author.outside,author.outward,point).applyMatrix4(toHead)
        const ry=y-point.y,rz=z-point.z;residual=Math.max(Math.abs(ry),Math.abs(rz));if(residual<1e-11)break
        const h=.00001,px=headTailRestPoint(x+h,v,.0315,author.outside,author.outward).applyMatrix4(toHead),py=headTailRestPoint(x,v+h,.0315,author.outside,author.outward).applyMatrix4(toHead)
        const a=(px.y-point.y)/h,b=(py.y-point.y)/h,c=(px.z-point.z)/h,d=(py.z-point.z)/h,j=a*d-b*c
        x+=(ry*d-b*rz)/j;v+=(a*rz-c*ry)/j
      }
      if(residual>1e-7)throw new Error('Head-tail authoring inverse did not converge')
      maxInverseResidual=Math.max(maxInverseResidual,residual)
      headTailRestPoint(x,v,.0315,author.outside,author.outward,point).applyMatrix4(toHead)
      let support=-10
      // Include half an element around the sample so a hair edge cannot
      // disappear between cap vertices at the edge of its support chart.
      support=contact.envelope?.(y,side*z,.0071)??contact(y,side*z)??-10
      const authored=side*point.x+half,required=support+clearance+2*half,d=authored-required
      const outer=.5*(authored+required+Math.sqrt(d*d+.002*.002))
      middles.push({x:outer,y,z,authorX:x,authorY:v})
    }
    for(let face=0;face<2;face++)for(const p of middles){
      const t=MathUtils.clamp((-p.authorY-.15)/.90,0,1)
      positions.push(side*(p.x-face*2*half),p.y,p.z);colors.push(1,1,1)
      coordinates.push(Math.abs(p.authorX)-(author.outside?.11+.45*t:.09+.024*t),p.authorY,distanceToProfile(edge,p.authorX,p.authorY))
    }
    const edges=new Map<string,{a:number;b:number;count:number}>()
    for(let i=0;i<sourceIndex.count;i+=3){
      const a=sourceIndex.getX(i),b=sourceIndex.getX(i+1),c=sourceIndex.getX(i+2);indices.push(a,b,c,n+c,n+b,n+a)
      for(const[u,v]of[[a,b],[b,c],[c,a]]){const key=Math.min(u,v)+':'+Math.max(u,v),e=edges.get(key);if(e)e.count++;else edges.set(key,{a:u,b:v,count:1})}
    }
    for(const e of edges.values())if(e.count===1)indices.push(e.a,n+e.a,e.b,e.b,n+e.a,n+e.b)
    let volume=0
    for(let i=0;i<indices.length;i+=3){const a=indices[i]*3,b=indices[i+1]*3,c=indices[i+2]*3;volume+=positions[a]*(positions[b+1]*positions[c+2]-positions[b+2]*positions[c+1])+positions[a+1]*(positions[b+2]*positions[c]-positions[b]*positions[c+2])+positions[a+2]*(positions[b]*positions[c+1]-positions[b+1]*positions[c])}
    if(volume<0)for(let i=0;i<indices.length;i+=3)[indices[i+1],indices[i+2]]=[indices[i+2],indices[i+1]]
    const geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute(positions,3));geometry.setAttribute('color',new Float32BufferAttribute(colors,3));geometry.setAttribute('headTailCoordinate',new Float32BufferAttribute(coordinates,3));geometry.setIndex(indices);geometry.computeVertexNormals();geometry.computeBoundingSphere()
    geometry.userData.headTailGraph={pairedVertices:n,physicalHeadYZChart:true,headSpace:true,fullThickness:2*half,clearance,supportNeighborhood:.0071,author,maxInverseResidual,sourceCapTriangles:sourceIndex.count/3,closedBoundaryEdges:[...edges.values()].filter(e=>e.count===1).length,noCameraInput:true}
    cap.dispose();return geometry
  }

  function bow(parent: Layer, color: Paint, at: Vec, size: number, roll: number,
    style: 'collar' | 'head' | 'back' = 'collar', outward = 1) {
    const behind = style === 'back'
    const headRibbon = style === 'head'
    const knot = joint(parent, headRibbon ? `head-bow-${outward}` : 'bow', at)
    knot.scale.setScalar(size)
    knot.rotation.set(0, behind ? Math.PI : 0, roll)
    const loopPaint = color.clone()
    loopPaint.onBeforeCompile = color.onBeforeCompile
    loopPaint.vertexColors = true
    const clothPaint = headRibbon || behind ? color.clone() : color
    if (headRibbon || behind) {
      loopPaint.userData.outlineParameters = { visible: false }
      clothPaint.onBeforeCompile = color.onBeforeCompile
      clothPaint.vertexColors = true
      clothPaint.userData.outlineParameters = { visible: false }
    }
    if (behind) {
      for (const material of [loopPaint,clothPaint]) {
        material.onBeforeCompile = (shader,renderer) => {
          color.onBeforeCompile.call(material,shader,renderer)
          shader.fragmentShader = shader.fragmentShader.replace(shadedPaper,
            'float paper = .96 + .04 * smoothstep(.27,1.12,exposure);')
        }
      }
      finishBackRibbon(loopPaint,'loop')
      finishBackRibbon(clothPaint,'tail')
    }
    if (headRibbon) {
      const clothShading=loopPaint.onBeforeCompile
      loopPaint.onBeforeCompile=(shader,renderer)=>{
        clothShading.call(loopPaint,shader,renderer)
        shader.uniforms.headFoldInk={value:new Color(0x202c61)}
        shader.uniforms.headEdgeInk={value:new Color(0x202852)}
        shader.vertexShader='attribute vec3 headRibbonCoordinate; varying vec3 headRibbonPoint;\n'+shader.vertexShader
        shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',
          '#include <begin_vertex>\n headRibbonPoint=headRibbonCoordinate;')
        shader.fragmentShader='uniform vec3 headFoldInk,headEdgeInk; varying vec3 headRibbonPoint;\n'+shader.fragmentShader
        shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>', `
          #include <color_fragment>
          float u=(headRibbonPoint.x-.33)/.22;
          float center=.025+.12*(headRibbonPoint.x-.30);
          float halfWidth=.061*(.65+.35*smoothstep(-1.,1.,u));
          float v=(headRibbonPoint.y-center)/halfWidth;
          float distance=sqrt(u*u+v*v);
          float blur=max(.10,fwidth(distance)*.9);
          float crease=1.-smoothstep(1.-blur,1.+blur,distance);
          diffuseColor.rgb=mix(diffuseColor.rgb,headFoldInk,.90*crease);
          float hemBlur=max(.002,fwidth(headRibbonPoint.z)*.8);
          float hem=1.-smoothstep(.012-hemBlur,.012+hemBlur,headRibbonPoint.z);
          diffuseColor.rgb=mix(diffuseColor.rgb,headEdgeInk,.88*hem);
        `)
      }
      loopPaint.customProgramCacheKey=()=> 'bluefish-head-bow-finish-2'
      const tailShading=clothPaint.onBeforeCompile
      clothPaint.onBeforeCompile=(shader,renderer)=>{
        tailShading.call(clothPaint,shader,renderer)
        shader.uniforms.headTailInk={value:new Color(0x202852)}
        shader.uniforms.headTailFold={value:new Color(0x2b356f)}
        shader.vertexShader='attribute vec3 headTailCoordinate; varying vec3 headTailPoint;\n'+shader.vertexShader
        shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',
          '#include <begin_vertex>\n headTailPoint=headTailCoordinate;')
        shader.fragmentShader='uniform vec3 headTailInk,headTailFold; varying vec3 headTailPoint;\n'+shader.fragmentShader
        shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>', `
          #include <color_fragment>
          float hemBlur=max(.002,fwidth(headTailPoint.z)*.8);
          float hem=1.-smoothstep(.012-hemBlur,.012+hemBlur,headTailPoint.z);
          float t=clamp((-headTailPoint.y-.15)/.90,0.,1.);
          float foldDistance=abs(headTailPoint.x);
          float foldBlur=max(.006,fwidth(foldDistance)*.80);
          float fold=1.-smoothstep(.025-foldBlur,.025+foldBlur,foldDistance);
          fold*=sin(3.14159265*t);
          diffuseColor.rgb=mix(diffuseColor.rgb,headTailFold,.58*fold);
          diffuseColor.rgb=mix(diffuseColor.rgb,headTailInk,.90*hem);
        `)
      }
      clothPaint.customProgramCacheKey=()=> 'bluefish-head-tail-finish-8'

    }
    for (const side of [-1, 1]) {
      const outside = side === outward
      const length = headRibbon ? (outside ? .96 : .89) : 1
      const petal = (curves: readonly Curve[]) => curves.map(([a,b,c,d,e,f]) =>
        [a * side * length,b,c * side * length,d,e * side * length,f] as const)
      const loops: readonly Curve[] = headRibbon ? [
        [.26,.174,.582,.410,.805,.408],[.936,.416,.971,.338,.953,.218],
        [.940,.119,.912,.067,.917,.006],[.918,-.085,.969,-.227,.922,-.306],
        [.868,-.398,.688,-.345,.527,-.293],[.350,-.225,.180,-.120,.08,.02],
      ] : behind ? [
        [.28,.23,.64,.395,.87,.37],[.985,.375,.999,.255,.978,.145],
        [.963,.04,.935,-.025,.946,-.100],[.970,-.205,.985,-.39,.90,-.44],
        [.76,-.54,.24,-.24,.08,.02],
      ] : [
        [.26,.26,.64,.42,.86,.38],[.99,.33,.97,-.23,.84,-.31],
        [.68,-.40,.25,-.19,.08,.02],
      ]
      const loopDepth = headRibbon ? .117 : .16
      const loop = shape(knot, loopPaint, [0,0,0], [side * length * .08,.02], petal(loops), loopDepth)
      if (headRibbon) loop.name = `head-bow-loop-${outside ? 'outer' : 'inner'}`
      const edge = headRibbon || behind ? ribbonBoundary(loop.geometry) : undefined
      const curved = refineProfile(loop.geometry, headRibbon ? .052 : behind ? .068 : .078)
      loop.geometry.dispose()
      loop.geometry = curved
      const vertices = loop.geometry.attributes.position
      const pigment = [], sewn: number[] = [], headSewn: number[] = []
      for (let i = 0; i < vertices.count; i++) {
        const across = vertices.getX(i), x = Math.abs(across) / length
        const y = vertices.getY(i), z = vertices.getZ(i)
        if (headRibbon) headSewn.push(x,y,distanceToProfile(edge!,across,y))
        if (behind) sewn.push(across,y,distanceToProfile(edge!,across,y))
        const arch = Math.sin(Math.PI * Math.min(1, Math.max(0, (x - .07) / .90)))
        const fold = headRibbon ? .025 + .12 * (x - .30) : .025
        const foldDistance = ((x - .33) / .19) ** 2 + ((y - fold) / (headRibbon ? .061 : .104)) ** 2
        const pinch = Math.exp(headRibbon ? -.78 * foldDistance ** 2 : -foldDistance)
        const billow = .147 * arch * (.55 + .45 * Math.cos(y * 4.8)) - (headRibbon ? .086 : .058) * pinch
        const thickness = Math.max(0, Math.min(1, (z + .012) / (loopDepth + .024)))
        // The apron loops wrap around the waist so their rounded ends
        // sit in front of the side locks.
        const sweep = headRibbon ? .066 * x * x - .028 * y : behind ? -.04 * x * x : 0
        // The near-temple loop turns with the crown, keeping its cloth on
        // the outside of the hair even though its end points forward.
        const wrap = headRibbon && !outside ? (.94 - .60 * y) * x : 0
        vertices.setX(i, across + outward * .57 * wrap)
        // Round the loop's depth toward its upper and lower hems. A broad
        // profile at the middle reads as cloth folded over at the waist.
        const roundedDepth = behind ? .068 + (z - .068) * (.38 + .62 * Math.exp(-(((y - .028) / .24) ** 2))) : z
        vertices.setZ(i, roundedDepth + sweep + .76 * wrap + billow * (-.26 + 1.26 * thickness))
        const hem = edge ? (behind ? .05 : headRibbon ? 0 : .30) * Math.exp(-distanceToProfile(edge, across, y) / (headRibbon ? .018 : .028)) : 0
        const shade = (behind ? .10 : headRibbon ? 0 : .33) * pinch + hem
        const sheen = headRibbon ? .090 * arch * Math.max(0, y) / .42 : 0
        pigment.push(1 - shade + sheen, 1 - shade * .93 + sheen, 1 - shade * .67 + sheen)
      }
      loop.geometry.setAttribute('color', new Float32BufferAttribute(pigment, 3))
      if (headRibbon) loop.geometry.setAttribute('headRibbonCoordinate',new Float32BufferAttribute(headSewn,3))
      if (behind) loop.geometry.setAttribute('ribbonCoordinate',new Float32BufferAttribute(sewn,3))
      loop.geometry.computeVertexNormals()
      if (behind) {
        // Let the ends flex away from the apron straps as the torso
        // leans into a stroke. The knot and ribbon roots stay at the waist.
        const swim = new BufferGeometry()
        const fold = vertices.clone()
        for (let i = 0; i < fold.count; i++) fold.setZ(i, fold.getZ(i) + .32 * fold.getX(i) ** 2)
        swim.setIndex(loop.geometry.index)
        swim.setAttribute('position', fold)
        swim.computeVertexNormals()
        loop.geometry.morphAttributes.position = [fold]
        loop.geometry.morphAttributes.normal = [swim.attributes.normal]
        loop.updateMorphTargets()
        swim.dispose()
        apronLoops.push(loop)
      }
      const ribbon: readonly Curve[] = behind && side > 0 ? [
        [.34,-.23,.61,-.70,1.105,-.925],[1.175,-.956,1.186,-.975,1.126,-.996],
        [.970,-1.050,.758,-1.202,.668,-1.287],
        [.626,-1.329,.616,-1.331,.590,-1.277],
        [.458,-1.058,.230,-.530,.100,-.170],[.12,-.12,.14,-.09,.17,-.04],
      ] : behind ? [
        [.34,-.23,.61,-.70,1.18,-.96],[.97,-1.03,.75,-1.21,.62,-1.33],
        [.46,-1.06,.23,-.53,.10,-.17],[.12,-.12,.14,-.09,.17,-.04],
      ] : headRibbon && outside ? [
        [.31,-.16,.56,-.33,.93,-.65],[.80,-.74,.66,-.84,.54,-.91],
        [.41,-.78,.24,-.46,.11,-.16],[.12,-.11,.15,-.072,.17,-.04],
      ] : headRibbon ? [
        [.36,-.255,.59,-.700,.67,-1.015],[.53,-1.006,.38,-.954,.27,-1.028],
        [.17,-1.108,.025,-1.100,-.035,-1.055],[.002,-.741,.054,-.353,.074,-.19],
        [.098,-.15,.14,-.12,.17,-.116],
      ] : [
        [.36,-.16,.46,-.38,.73,-.69],[.59,-.79,.43,-.94,.35,-1.01],
        [.26,-.71,.18,-.46,.10,-.17],[.12,-.12,.14,-.09,.17,-.04],
      ]
      const tail = shape(knot, clothPaint, [0,0,behind || headRibbon ? .04 : -.12],
        [side * length * .17,headRibbon && !outside ? -.116 : -.04], petal(ribbon), headRibbon ? .063 : .080)
      if (behind) {
        const edge = ribbonBoundary(tail.geometry)
        const cloth = refineProfile(tail.geometry, .062)
        tail.geometry.dispose()
        tail.geometry = cloth
        const points = cloth.attributes.position
        const colors: number[] = [], sewn: number[] = []
        const joints: number[] = [], weights: number[] = []
        for (let i = 0; i < points.count; i++) {
          const x = points.getX(i), y = points.getY(i)
          sewn.push(x,y,distanceToProfile(edge,x,y))
          const fall = Math.max(0, -y - .04)
          const flare = Math.abs(x)
          const skirtDrape = fall * (.49 + .19 * fall - .095 * flare ** 2)
          // One ribbon rests on the upper surface of the tail before the
          // tail sweeps out from the hip. The other follows the skirt.
          const arc = Math.max(0, Math.min(1, (fall - .185) / .65))
          const contact = arc * arc * (3 - 2 * arc)
          const easeAway = Math.max(0, Math.min(1, (fall - .16) / .26))
          const swingRoom = .049 * easeAway * easeAway * (3 - 2 * easeAway)
          const lift = .036 * Math.exp(-(((fall - .31) / .125) ** 2))
            * Math.max(0, Math.min(1, (fall - .11) / .16))
          const tailDepth = .220 + .205 * contact + size * flare * (1.13 + .30 * contact)
            + .028 * Math.exp(-(((fall - .43) / .27) ** 2)) + swingRoom + lift
          const clearance = (tailDepth + at[2]) / size - .080 - skirtDrape
          const reach = Math.max(0, Math.min(1, (fall - .10) / .26))
          const drape = side < 0 ? Math.max(0, clearance) * reach * reach * (3 - 2 * reach) : 0
          const hang = Math.max(0, Math.min(1, (fall - .15) / 1.18))
          const acrossFold = (flare - .14 - .54 * fall) / .18
          const hemTurn = Math.max(0, Math.min(1, (fall - .65) / .30))
          const bodyArc = Math.sin(Math.PI * hang) ** 2
            * (1 - hemTurn * hemTurn * (3 - 2 * hemTurn))
          const innerFold = 1 / (1 + Math.exp(3 * acrossFold))
          const cup = side > 0 ? .045 * bodyArc
            + .14 * Math.sin(Math.PI * hang) ** 2 * innerFold : 0
          const hemLift = side > 0 ? .018 * Math.exp(-(((fall - .90) / .18) ** 2))
            * (1 - innerFold) : 0
          const rootEase = Math.max(0, Math.min(1, (fall - .08) / .12))
          const upperFold = side > 0 ? .030 * Math.exp(-(((fall - .28) / .18) ** 2))
            * rootEase * rootEase * (3 - 2 * rootEase) : 0
          if (side > 0) points.setX(i, x + .10 * bodyArc)
          points.setZ(i, points.getZ(i) + skirtDrape + drape + cup + upperFold + hemLift)
          const hem = .08 * Math.exp(-distanceToProfile(edge, x, y) / .024)
          const fold = (flare - .14 - .54 * fall) / .17
          const shade = hem + .24 * Math.exp(-fold * fold) * Math.sin(Math.PI * Math.min(1, fall / 1.34))
          colors.push(1 - shade, 1 - shade * .92, 1 - shade * .63)
          if (side < 0) {
            const follow = Math.max(0, Math.min(1, (fall - .090) / .46))
            const outer = Math.max(0, Math.min(1, (flare - .16) / .94))
            const loose = follow * follow * (3 - 2 * follow)
            const forward = outer * outer * (3 - 2 * outer) * .86
            joints.push(0, 1, 2, 0)
            weights.push(1 - loose, loose * (1 - forward), loose * forward, 0)
          }
        }
        cloth.setAttribute('color', new Float32BufferAttribute(colors, 3))
        cloth.setAttribute('ribbonCoordinate',new Float32BufferAttribute(sewn,3))
        cloth.computeVertexNormals()
        if (side < 0) {
          // Keep the sewn end on the waist and let the hanging cloth
          // follow the first two tail bones as it rests over the tail.
          cloth.setAttribute('skinIndex', new Uint16BufferAttribute(joints, 4))
          cloth.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4))
          const drape = new SkinnedMesh(cloth, clothPaint)
          drape.name = 'apron-tail-drape'
          drape.position.copy(tail.position)
          drape.frustumCulled = false
          knot.remove(tail)
          knot.add(drape)
        }
      }
      if (headRibbon) {
        tail.name = `head-bow-tail-${outside ? 'outer' : 'inner'}`
        const edge = ribbonBoundary(tail.geometry)
        const cloth = refineProfile(tail.geometry, .043)
        tail.geometry.dispose()
        tail.geometry = cloth
        const points = cloth.attributes.position
        const colors: number[] = [], tailSewn: number[] = []
        for (let i = 0; i < points.count; i++) {
          const y = points.getY(i), x = points.getX(i)
          const distance = distanceToProfile(edge, x, y)
          const t = Math.max(0, Math.min(1, (-y - .15) / .90))
          const rest=headTailRestPoint(x,y,points.getZ(i),outside,outward)
          points.setXYZ(i,rest.x,rest.y,rest.z)
          colors.push(1, 1, 1)
          tailSewn.push(Math.abs(x)-(outside ? .11+.45*t : .09+.024*t),y,distance)
        }
        cloth.setAttribute('color', new Float32BufferAttribute(colors, 3))
        cloth.setAttribute('headTailCoordinate',new Float32BufferAttribute(tailSewn,3))
        cloth.userData.headTailAuthor={start:[side*length*.17,outside?-.04:-.116],curves:petal(ribbon),outside,outward}
        cloth.computeVertexNormals()
      }
    }
    if (headRibbon) {
      const knotPaint = color.clone()
      knotPaint.onBeforeCompile = color.onBeforeCompile
      knotPaint.color.setHex(0x435493)
      const binding = shape(knot, knotPaint, [outward * .065,0,.243], [-.112,.164], [
        [-.048,.179,.044,.173,.110,.154],[.135,.111,.128,-.092,.106,-.141],
        [.057,-.160,-.045,-.164,-.102,-.147],[-.140,-.093,-.141,.098,-.112,.164],
      ], .120)
      binding.scale.x = .87
      binding.name = 'head-bow-knot'
    } else if (behind) {
      shape(knot, color, [0,0,.141], [-.112,.164], [
        [-.047,.182,.053,.177,.111,.149],[.131,.092,.123,-.085,.110,-.144],
        [.046,-.169,-.060,-.164,-.113,-.143],[-.135,-.090,-.135,.095,-.112,.164],
      ], .116)
    } else ball(knot, color, [0, 0, .158], [.126,.171,.096])
    return knot
  }

  const ribbonBlue = drawnPaint(new MeshPhongMaterial({
    color: 0x3c4a87, specular: 0x1b1c27, shininess: 17,
  }), 0x273464, .0042)
  const ribbonShading = ribbonBlue.onBeforeCompile
  ribbonBlue.onBeforeCompile = (shader, renderer) => {
    ribbonShading.call(ribbonBlue, shader, renderer)
    shader.fragmentShader = shader.fragmentShader.replace(shadedPaper,
      'float paper = .97 + .045 * smoothstep(.27,1.12,exposure);')
  }
  // Contact samples come from the actual curved hair and head-fin
  // triangles. Each side uses a cyclic axis projection, retaining face
  // orientation while profileFrontDepth indexes its nearest surface.
  head.updateWorldMatrix(true,true)
  const contactFrame = new Matrix4().copy(head.matrixWorld).invert()
  const contactSurfaces = [-1,1].map(side => {
    const positions: number[] = [], indices: number[] = [], envelopePadding:number[]=[]
    head.traverse(object => {
      if (!(object instanceof Mesh)) return
      let clothSupport = object.name==='hair-scalp',fringeSupport=false
      for (let parent=object.parent;parent && parent!==head;parent=parent.parent) {
        if (['fringe','back-hair','head-fin'].includes(parent.name)) clothSupport=true
        if(parent.name==='fringe')fringeSupport=true
      }
      if (!clothSupport) return
      const geometry = object.geometry, points = geometry.attributes.position
      const matrix = new Matrix4().multiplyMatrices(contactFrame,object.matrixWorld)
      const offset = positions.length/3, point = new Vector3()
      for (let i=0;i<points.count;i++) {
        point.fromBufferAttribute(points,i).applyMatrix4(matrix)
        positions.push(point.y,side*point.z,side*point.x)
        // Bound the existing +/- .019 fringe roll without moving its roots.
        envelopePadding.push(fringeSupport?.020*Math.abs(point.x)+.00021*Math.abs(point.y):0,fringeSupport?.020*Math.abs(point.y)+.00021*Math.abs(point.x):0)
      }
      if (geometry.index) for (let i=0;i<geometry.index.count;i++) indices.push(offset+geometry.index.getX(i))
      else for (let i=0;i<points.count;i++) indices.push(offset+i)
    })
    const projection = new BufferGeometry()
    projection.setAttribute('position',new Float32BufferAttribute(positions,3))
    projection.setIndex(indices)
    const sample = profileFrontDepth(projection)
    projection.dispose()
    return Object.assign(sample,{envelope:headContactEnvelope(positions,indices,envelopePadding)})
  })
  for (const side of [-1, 1]) {
    const ribbon = bow(head, ribbonBlue, [side * .382, .324, -.242], .268, side * .040, 'head', side)
    ribbon.rotation.y = side * .825
    ribbon.scale.z = .210
    ribbon.updateMatrix()
    const contact = contactSurfaces[side<0?0:1]
    ribbon.traverse(object => {
      if (!(object instanceof Mesh)) return
      object.updateMatrix()
      const toHead = new Matrix4().multiplyMatrices(ribbon.matrix,object.matrix)
      const fromHead = toHead.clone().invert()
      if(object.name.startsWith('head-bow-tail-')){
        const previous=object.geometry;object.geometry=fittedHeadTail(object,toHead,side,contact);object.matrixAutoUpdate=false;object.matrix.copy(ribbon.matrix).invert();previous.dispose();return
      }
      const points = object.geometry.attributes.position, p = new Vector3()
      for (let i=0;i<points.count;i++) {
        p.fromBufferAttribute(points,i).applyMatrix4(toHead)
        const support = contact(p.y,side*p.z)
        if (object.name==='head-bow-knot' && support!==undefined) {
          // Let the knot's back follow the crown instead of translating
          // its entire volume by the deepest corner's clearance.
          const contact = support+.060-side*p.x
          p.x += side*.90*.5*(contact+Math.sqrt(contact*contact+.000016))
        }
        else if (support!==undefined && support>.12 && object.name!=='head-bow-loop-outer') {
          const difference = Math.min(support+.035,.545)-side*p.x
          // Retain a positive cloth thickness when the inside of a loop
          // rests against the head instead of flattening both faces.
          p.x += side*.95*.5*(difference+Math.sqrt(difference*difference+.000016))
        }
        p.applyMatrix4(fromHead)
        points.setXYZ(i,p.x,p.y,p.z)
      }
      object.geometry.computeVertexNormals()
      object.geometry.computeBoundingSphere()
    })
  }
  const shoulderCloth = paint(0xffffff)
  shoulderCloth.side = DoubleSide
  shoulderCloth.vertexColors = true
  shoulderCloth.userData.outlineParameters = { visible: false }
  const shoulderSeam = paint(0x8e86ad)
  shoulderSeam.userData.outlineParameters = { visible: false }
  for (const side of [-1, 1]) {
    const shoulder = apronShoulder(side)
    surface(spine, shoulder.geometry, shoulderCloth).name = 'apron-shoulder'
    surface(spine, new TubeGeometry(new CatmullRomCurve3(shoulder.rim), 192, .0021, 5), shoulderSeam).name = 'apron-shoulder-seam'
  }
  const collarGeometries = [-1,1].map(shirtCollar)
  const collarContacts = collarGeometries.map(collarBodiceDepth)
  const bodice = ball(spine, dress, [0, .232, 0], [.270, .259, .197])
  bodice.name = 'bodice'
  // Scoop the shirt behind the collar. A solid ellipsoid at the neckline
  // hid the neck unless its skin was pushed in front of the chin.
  bodice.geometry = new SphereGeometry(1,96,72)
  const bodicePoints = bodice.geometry.attributes.position
  for (let i=0;i<bodicePoints.count;i++) {
    const x=.270*bodicePoints.getX(i), y=.232+.259*bodicePoints.getY(i), z=.197*bodicePoints.getZ(i)
    const rise=Math.max(0,Math.min(1,(y-.392)/.040))
    const center=Math.exp(-((x/.091)**4))
    const front=Math.max(0,Math.min(1,z/.075))
    const tuck=.082*rise*rise*(3-2*rise)*center*front*front*(3-2*front)
    let frontZ=z-tuck
    if (z>0) for (const sample of collarContacts) {
      const contact=sample(x,y,frontZ)
      if (contact!==undefined) frontZ=Math.min(frontZ,contact-.030)
    }
    bodicePoints.setZ(i,frontZ/.197)
  }
  bodice.geometry.computeVertexNormals()
  const neckPaint = skin.clone()
  neckPaint.emissiveIntensity = 0
  neckPaint.onBeforeCompile = (shader, renderer) => {
    skin.onBeforeCompile(shader, renderer)
    shader.uniforms.neckShade = { value: new Color(0xe6ac9f) }
    shader.vertexShader = 'varying float neckHeight;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n neckHeight = position.y;')
    shader.fragmentShader = 'varying float neckHeight; uniform vec3 neckShade;\n' + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      float underChin = .48 + .46 * smoothstep(-.48,-.13,neckHeight);
      diffuseColor.rgb = mix(diffuseColor.rgb,neckShade,underChin);
    `)
  }
  const neckSkin = ball(spine, neckPaint, [0, .445, .035], [.065, .070, .070])
  neckSkin.name = 'neck-skin'
  const bibScallops = Array.from({ length: 7 }, (_, i): Curve => {
    const start = -.130 + i * .260 / 7, step = .260 / 7
    return [start + step * .20,.331,start + step * .80,.331,start + step,.319]
  })
  const bibGeometry = frontBibGeometry(bibScallops)
  surface(spine,bibGeometry,shoulderCloth,[0,0,.165])
  const bibPoints = bibGeometry.attributes.position
  const bibIvory = new Color(0xf5effa), bibShadow = new Color(0xb5afd5), bibPigment = new Color()
  const bibColors: number[] = []
  const bibRise = (x: number) => .020 * Math.max(0, 1 - (x / .141) ** 2)
  for (let i = 0; i < bibPoints.count; i++) {
    const x = bibPoints.getX(i), y = bibPoints.getY(i)
    bibPoints.setZ(i, bibPoints.getZ(i) + bibRise(x))
    const gather = Math.exp(-(((x + .050 - .23 * (y - .157)) / .054) ** 2) - (((y - .149) / .043) ** 2))
    bibPigment.copy(bibIvory).lerp(bibShadow, .054 + .33 * gather + .14 * (Math.abs(x) / .145) ** 4)
    bibColors.push(bibPigment.r, bibPigment.g, bibPigment.b)
  }
  bibGeometry.setAttribute('color', new Float32BufferAttribute(bibColors, 3))
  bibGeometry.computeVertexNormals()
  const bibRim = Array.from({ length: 37 }, (_, i): Vec => {
    const t = i / 36
    const x = -.128 + .256 * t
    return [x, .308 + .0042 * Math.sin(Math.PI * (t * 7 % 1)), .211 + bibRise(x)]
  })
  surface(spine, new TubeGeometry(new CatmullRomCurve3(bibRim.map(p => new Vector3(...p))), 108, .0024, 5), shoulderSeam)
  for (const side of [-1, 1]) {
    const binding = [[.118,.310],[.122,.265],[.121,.198],[.117,.148]].map(([x, y]): Vec =>
      [side * x, y, .211 + bibRise(x)])
    line(spine, shoulderSeam, binding, .0020)
  }
  const frontTie = paint(0xffffff, 13)
  frontTie.vertexColors = true
  frontTie.userData.outlineParameters = { visible: false }
  surface(spine, frontApronTie(), frontTie).name = 'front-apron-tie'
  const collarFabric = paint(0xffffff, 12)
  collarFabric.vertexColors = true
  collarFabric.userData.outlineParameters = { color: new Color(0x77739e).toArray(), thickness: .0012 }
  for (const geometry of collarGeometries) surface(spine, geometry, collarFabric).name = 'shirt-collar'
  const bell = collarBellGeometry()
  const bellPaint = paint(0xf7f2f1)
  bellPaint.specular.setHex(0x000000)
  const bellShading = bellPaint.onBeforeCompile
  bellPaint.onBeforeCompile = (shader,renderer) => {
    bellShading.call(bellPaint,shader,renderer)
    shader.fragmentShader = shader.fragmentShader.replace(
      'float paper = .73 + .31 * smoothstep(.27,1.12,exposure);',
      'float paper = .98 + .01 * smoothstep(.27,1.12,exposure);',
    )
  }
  const bellPaper = bellPaint.onBeforeCompile
  bellPaint.onBeforeCompile = (shader,renderer) => {
    bellPaper.call(bellPaint,shader,renderer)
    shader.vertexShader = 'varying vec2 bellPoint;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n bellPoint = position.xy;')
    shader.fragmentShader = 'varying vec2 bellPoint;\n' + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      vec2 center = (bellPoint-vec2(0.,.3530))/vec2(.0035,.0028);
      float inset = .72*exp(-dot(center,center));
      diffuseColor.rgb = mix(diffuseColor.rgb,vec3(.62,.49,.56),inset);
    `)
  }
  bellPaint.userData.outlineParameters = { color: new Color(0x5a526f).toArray(), thickness: .0014 }
  surface(spine, bell, bellPaint, [.0028,0,.186]).name = 'collar-bell'
  ball(spine, lace, [.0028,.328,.190], [.0045,.004,.0035]).name = 'collar-bell-clapper'

  const skirt = joint(hips, 'skirt', [0, 0, 0])
  const skirtCloth: Mesh[] = []
  const groundedSkirtCloth: Mesh[] = []
  function clothSurface(geometry: BufferGeometry, fabric: Paint, petticoat = false) {
    addSkirtDrapeShapes(geometry, petticoat)
    const mesh = surface(skirt, geometry, fabric)
    skirtCloth.push(mesh)
    if (petticoat) groundedSkirtCloth.push(mesh)
    return mesh
  }
  dress.side = dressLight.side = lace.side = white.side = edge.side = DoubleSide
  const petticoatSeam = paint(0xa99dc7)
  petticoatSeam.userData.outlineParameters = { visible: false }
  const skirtSeam = paint(0x303969,12)
  skirtSeam.userData.outlineParameters = { visible: false }
  let navyCloth: BufferGeometry | undefined
  // Sampled from the waist seam, navy tier, and both fluted petticoat hems.
  function skirtLayer(profile: readonly (readonly [number, number])[], amplitude: number, phase: number,
    fabric: Paint, trim: Paint, tier?: 'upper' | 'lower') {
    let { geometry, hem, pointAt } = foldedSkirt(profile, amplitude, phase, tier)
    const foldedFabric = fabric.clone()
    foldedFabric.color.setHex(fabric === dress ? 0x415094 : 0xf8f0f7)
    foldedFabric.onBeforeCompile = (shader, renderer) => {
      fabric.onBeforeCompile.call(foldedFabric, shader, renderer)
      shader.fragmentShader = shader.fragmentShader.replace(shadedPaper,
        'float paper = .90 + .137 * smoothstep(.27,1.12,exposure);')
      if (!tier) {
        shader.uniforms.navyCreaseInk = { value: new Color(0x2e335d) }
        shader.vertexShader = 'attribute vec3 skirtFold; varying vec3 sewnSkirtFold;\n'+shader.vertexShader
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
          '#include <begin_vertex>\n sewnSkirtFold = skirtFold;')
        shader.fragmentShader = 'uniform vec3 navyCreaseInk; varying vec3 sewnSkirtFold;\n'+shader.fragmentShader
        shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
          vec2 fold = normalize(sewnSkirtFold.xy);
          vec2 creaseDirection = vec2(.637424,-.770513);
          float acrossCrease = fold.x*creaseDirection.y-fold.y*creaseDirection.x;
          float creasePixels = abs(acrossCrease)/max(fwidth(acrossCrease),.00001);
          float crease = (1.-smoothstep(.15,.90,creasePixels))*step(0.,dot(fold,creaseDirection))
            *smoothstep(.34,.76,sewnSkirtFold.z);
          outgoingLight = mix(outgoingLight,navyCreaseInk,.72*crease);
          #include <opaque_fragment>
        `)
      }
    }
    // The navy program has an extra crease attribute. Keep it separate
    // from the white tiers even though their compile callbacks share code.
    foldedFabric.customProgramCacheKey = () => 'bluefish-skirt-'+(tier ?? 'navy')+'|'+fabric.customProgramCacheKey()
    foldedFabric.vertexColors = true
    foldedFabric.userData.outlineParameters = { visible: false }
    const name = tier ? 'petticoat-'+tier : 'navy-skirt'
    if(!tier)navyCloth=geometry
    const leaves=tier?petticoatLeaves(profile,phase,tier==='lower',geometry,tier==='upper'?navyCloth:undefined):undefined
    if(leaves){geometry.dispose();geometry=leaves.foundation}
    clothSurface(geometry, foldedFabric, tier !== undefined).name = name
    if (tier && leaves) {
      const pleatFabric = foldedFabric.clone()
      pleatFabric.onBeforeCompile = (shader,renderer) => {
        foldedFabric.onBeforeCompile(shader,renderer)
        shader.uniforms.hemInk = { value: new Color(0x6b627f) }
        shader.uniforms.clothLining = { value: new Color(0x5a5374) }
        shader.vertexShader = 'attribute float clothHem; varying float hemCoordinate;\n'+shader.vertexShader
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
          '#include <begin_vertex>\n hemCoordinate = clothHem;')
        shader.fragmentShader = 'uniform vec3 hemInk, clothLining; varying float hemCoordinate;\n'+shader.fragmentShader
        shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
          float returnedHem = clamp(hemCoordinate/.05,0.,1.);
          if (!gl_FrontFacing) outgoingLight = mix(outgoingLight,clothLining,.67*sin(3.14159265*returnedHem));
          float hemPixels = abs(hemCoordinate)/max(fwidth(hemCoordinate),.00001);
          float hemCoverage = 1.-smoothstep(.25,1.05,hemPixels);
          outgoingLight = mix(outgoingLight,hemInk,.86*hemCoverage);
          #include <opaque_fragment>
        `)
      }
      clothSurface(leaves.geometry,pleatFabric,true).name = name+'-pleats'
    } else {
      clothSurface(new TubeGeometry(new CatmullRomCurve3(hem, true), 216, .0035, 5, true), trim)
    }
    return pointAt
  }
  const skirtPoint = skirtLayer([[.230,.249],[.293,.147],[.383,.034],[.472,-.081],[.530,-.175],[.549,-.247]],
    .047, .94, dress, skirtSeam)
  skirtLayer([[.425,-.121],[.489,-.177],[.540,-.216],[.581,-.263],[.605,-.291],[.596,-.308]], .036, .20, white, bonnetRim, 'upper')
  skirtLayer([[.467,-.234],[.504,-.281],[.547,-.337],[.586,-.368],[.626,-.389],[.614,-.407]], .034, .65, white, bonnetRim, 'lower')
  const apronFabric = paint(0xffffff, 12)
  apronFabric.side = DoubleSide
  apronFabric.vertexColors = true
  apronFabric.userData.outlineParameters = { visible: false }
  const navySupport = profileFrontDepth((skirt.getObjectByName('navy-skirt') as Mesh).geometry)
  const apron = apronPanel(navySupport)
  const frontApronFabric = apronFabric.clone()
  frontApronFabric.onBeforeCompile = (shader, renderer) => {
    apronFabric.onBeforeCompile.call(frontApronFabric, shader, renderer)
    shader.uniforms.apronGatherInk = { value: new Color(0x8b86be) }
    shader.uniforms.apronFrillInk = { value: new Color(0x948bb5) }
    shader.uniforms.apronLiningInk = { value: new Color(0x514b70) }
    shader.vertexShader = 'attribute vec4 apronCoordinate; varying vec4 sewnApron;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n sewnApron = apronCoordinate;')
    shader.fragmentShader = `uniform vec3 apronGatherInk, apronFrillInk, apronLiningInk;
      varying vec4 sewnApron;
      ${apronGatherField()}
    ` + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      float panelCoverage = 1.-smoothstep(0.,.012,sewnApron.z);
      float gatherPaint = apronGathers(sewnApron.xy)*panelCoverage;
      diffuseColor.rgb = mix(diffuseColor.rgb,apronGatherInk,gatherPaint);
      float frill = min(1.,sewnApron.z);
      float creasePaint = 0.;
      for (int i=-1;i<=1;i++) {
        float crease = mod(sewnApron.w-float(i)*(1.3-.40*frill)+3.14159265,6.2831853)-3.14159265;
        float taper = max(0.,1.-frill/(i==0?.40:.29));
        float width = (i==0?.36:.24)*sqrt(taper);
        float antialias = max(.035,.65*fwidth(sewnApron.w));
        float gather = 1.-smoothstep(-antialias,antialias,abs(crease)-width);
        creasePaint = max(creasePaint,gather*pow(taper,.42)*(i==0?1.:.65));
      }
      diffuseColor.rgb = mix(diffuseColor.rgb,apronFrillInk,.76*creasePaint*(1.-panelCoverage));
      if (!gl_FrontFacing) diffuseColor.rgb = mix(diffuseColor.rgb,apronLiningInk,.72*(1.-panelCoverage));
    `)
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      float apronReturn = smoothstep(1.,1.012,sewnApron.z);
      float apronGrazing = abs(dot(normalize(normal),normalize(vViewPosition)));
      float apronEdgeWidth = max(.012,1.15*fwidth(apronGrazing));
      float apronRim = .78*(1.-smoothstep(0.,apronEdgeWidth,apronGrazing))*apronReturn;
      outgoingLight = mix(outgoingLight,apronLiningInk,apronRim);
      #include <opaque_fragment>
    `)
  }
  clothSurface(apron.geometry, frontApronFabric).name = 'front-apron'
  clothSurface(new TubeGeometry(new CatmullRomCurve3(apron.seam), 144, .0024, 5), petticoatSeam).name = 'front-apron-seam'
  clothSurface(new TubeGeometry(new CatmullRomCurve3(apron.edge), 144, .0022, 5), bonnetRim).name = 'front-apron-hem'
  // The rear skirt is navy beneath the bow; the tail exits through its centre.
  surface(skirt, apronWaistband(skirtPoint), lace)
  const waist = skirtPoint(Math.PI, .080)
  const waistBow = bow(skirt, white, [0,waist.y,waist.z - .013], .278, .03, 'back')

  // The tail mesh uses four weighted bones. Its entire chain belongs to the
  // pelvis, including the fork and markings. The head rig has no tail children.
  const tail = joint(hips, 'tail-root', [0,.110,-.270])
  const stemShift = new Vector3(.028,0,-.014)
  const tailCurve = new CatmullRomCurve3([
    // Emerge below the centre of the back bow before bending to the side.
    // The outer guide knots and fork endpoint retain their original rest positions.
    new Vector3(0,0,0), new Vector3(0,-.060,-.180),
    new Vector3(.070,-.160,-.320),
    new Vector3(.322,-.232,-.367), new Vector3(.630,-.269,-.578),
    new Vector3(.836,-.205,-.687),
    new Vector3(.956,-.066,-.812).addScaledVector(stemShift,.36),
    new Vector3(.964,.184,-.865).add(stemShift),
  ])
  // Keep the established outside sweep while rebuilding only the waist connection.
  const outerTailCurve = new CatmullRomCurve3([
    new Vector3(0,0,0), new Vector3(.250,-.076,-.417),
    new Vector3(.558,-.113,-.628), new Vector3(.764,-.049,-.737),
    new Vector3(.884,.090,-.862).addScaledVector(stemShift,.36),
    new Vector3(.892,.340,-.915).add(stemShift),
  ])
  const outerTailOffset = new Vector3(.072,-.156,.050)
  const tailPoint = (t: number) => {
    const outer = outerTailCurve.getPointAt(t).add(outerTailOffset)
    return t >= .32 ? outer : tailCurve.getPointAt(t).lerp(outer, MathUtils.smoothstep(t,.18,.32))
  }
  const centerline = Array.from({ length: 4 }, (_, i) => tailPoint(i / 3))
  const tailBones = [tail]
  for (let i = 1; i < centerline.length; i++) {
    const delta = centerline[i].clone().sub(centerline[i - 1])
    tailBones.push(joint(tailBones[i - 1], `tail-${i}`, [delta.x, delta.y, delta.z]))
  }
  const tailMesh = new SkinnedMesh(tailGeometry(tailPoint, outerTailCurve), tailPaint)
  tail.add(tailMesh)
  root.updateMatrixWorld(true)
  tailMesh.bind(new Skeleton(tailBones))
  const waistDrape = waistBow.getObjectByName('apron-tail-drape')
  if (waistDrape instanceof SkinnedMesh) {
    // Lay the hanging ribbon over the actual tail surface in its own cloth
    // coordinates. The same displacement moves both skins, retaining thickness.
    root.updateMatrixWorld(true)
    const tailInCloth = new BufferGeometry()
    const projected: number[] = [], probe = new Vector3()
    const intoCloth = waistDrape.matrixWorld.clone().invert().multiply(tailMesh.matrixWorld)
    const tailPoints = tailMesh.geometry.attributes.position
    for (let i = 0; i < tailPoints.count; i++) {
      probe.fromBufferAttribute(tailPoints,i).applyMatrix4(intoCloth)
      projected.push(probe.x,probe.y,probe.z)
    }
    tailInCloth.setAttribute('position',new Float32BufferAttribute(projected,3))
    tailInCloth.setIndex(tailMesh.geometry.index!.clone())
    const tailFront = profileFrontDepth(tailInCloth)
    const cloth = waistDrape.geometry, points = cloth.attributes.position
    const underside = new BufferGeometry(), inverted: number[] = []
    const backIndex = Array.from(cloth.index!.array, Number)
    for (let i = 0; i < points.count; i++) inverted.push(points.getX(i),points.getY(i),-points.getZ(i))
    for (let i = 0; i < backIndex.length; i += 3) [backIndex[i+1],backIndex[i+2]] = [backIndex[i+2],backIndex[i+1]]
    underside.setAttribute('position',new Float32BufferAttribute(inverted,3))
    underside.setIndex(backIndex)
    const clothBack = profileFrontDepth(underside)
    const supports: { x: number; y: number; lift: number }[] = []
    for (let i = 0; i < points.count; i++) {
      const x = points.getX(i), y = points.getY(i)
      const tailZ = tailFront(x,y), backZ = clothBack(x,y)
      if (tailZ !== undefined && backZ !== undefined && tailZ+0.125+backZ > 0)
        supports.push({x,y,lift:tailZ+0.125+backZ})
    }
    for (let i = 0; i < points.count; i++) {
      const x = points.getX(i), y = points.getY(i)
      let lift = 0
      for (const support of supports) {
        const distance = ((x-support.x)/0.24)**2+((y-support.y)/0.24)**2
        lift = Math.max(lift,support.lift*Math.exp(-distance))
      }
      const sewn = MathUtils.smoothstep(-y,0.055,0.12)
      points.setZ(i,points.getZ(i)+lift*sewn)
    }
    points.needsUpdate = true
    cloth.computeVertexNormals()
    // Keep the ribbon sewn to the waist while the tail flexes beneath it.
    // Its raised rest surface provides clearance without folding the cloth
    // between the bow and a rotating tail bone.
    const ribbonWeights = cloth.attributes.skinWeight
    for (let i = 0; i < ribbonWeights.count; i++) {
      ribbonWeights.setXYZW(i,1,0,0,0)
    }
    ribbonWeights.needsUpdate = true
    underside.dispose(); tailInCloth.dispose()
    waistDrape.bind(new Skeleton([waistBow, tailBones[0], tailBones[1]]))
  }
  // Bind in the same coordinate system as the root so translations never
  // accumulate in the skin when the full character moves around the scene.
  tailMesh.frustumCulled = false
  const fin = joint(tailBones[3], 'tail-flukes', [0,0,0])
  surface(fin, flukeGeometry(stemShift), tailFin)

  const sleevePaint = drawnPaint(new MeshPhongMaterial({ vertexColors: true, specular: 0x202c51, shininess: 20 }))
  const cuffPaint = paint(0xffffff)
  cuffPaint.vertexColors = true
  cuffPaint.side = DoubleSide
  cuffPaint.userData.outlineParameters = white.userData.outlineParameters
  const wristCuffPaint=cuffPaint.clone()
  wristCuffPaint.onBeforeCompile=(shader,renderer)=>{
    cuffPaint.onBeforeCompile(shader,renderer)
    shader.fragmentShader=shader.fragmentShader.replace(shadedPaper,
      'float paper = .90 + .14 * smoothstep(.27,1.12,exposure);')
  }
  wristCuffPaint.customProgramCacheKey=()=> 'bluefish-wrist-cloth-2|'+String(cuffPaint.onBeforeCompile)
  wristCuffPaint.userData.outlineParameters={visible:false}
  wristCuffPaint.stencilWrite=true;wristCuffPaint.stencilRef=64;wristCuffPaint.stencilFunc=AlwaysStencilFunc
  wristCuffPaint.stencilWriteMask=64;wristCuffPaint.stencilZPass=ReplaceStencilOp
  const wristContourPaint=new MeshBasicMaterial({color:0x5b5883,side:BackSide,depthWrite:false,
    stencilWrite:true,stencilRef:64,stencilFunc:NotEqualStencilFunc,stencilFuncMask:64,stencilWriteMask:0})
  wristContourPaint.userData.outlineParameters={visible:false}
  wristContourPaint.onBeforeCompile=shader=>{
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#if !defined(USE_ENVMAP) && !defined(USE_SKINNING)
      #include <beginnormal_vertex>
      #include <morphnormal_vertex>
      #endif
      #include <begin_vertex>`).replace('#include <morphtarget_vertex>',`#include <morphtarget_vertex>
      transformed+=normalize(objectNormal)*.0045;`)
  }
  const wristRuffle = bluefishWristRuffle()
  const sockRuffle = bluefishRuffle(.106, .105, .052, 10, .005)
  const soleBlue = paint(0x43518a)
  soleBlue.userData.outlineParameters.thickness = .0035
  soleBlue.userData.outlineParameters.color = new Color(0x272952).toArray()
  const shoeBlue = paint(0xffffff, 21)
  shoeBlue.vertexColors = true
  shoeBlue.userData.outlineParameters.thickness = .0038
  shoeBlue.userData.outlineParameters.color = new Color(0x272952).toArray()
  const shadeShoe = shoeBlue.onBeforeCompile
  shoeBlue.onBeforeCompile = (shader,renderer) => {
    shadeShoe.call(shoeBlue,shader,renderer)
    shader.fragmentShader = shader.fragmentShader.replace(shadedPaper,
      'float paper = .85 + .19 * smoothstep(.27,1.12,exposure);')
  }
  shoeBlue.customProgramCacheKey = () => 'bluefish-shoe-paper|'+String(shadeShoe)
  const soleInk = paint(0x2b305f)
  soleInk.userData.outlineParameters = { visible: false }
  const handSkin = skin.clone()
  handSkin.userData.outlineParameters = { visible: false }
  handSkin.onBeforeCompile = (shader, renderer) => {
    skin.onBeforeCompile(shader, renderer)
    shader.vertexShader = 'attribute vec4 palmCoordinate; varying vec4 palmPoint; varying vec3 palmLocalPoint;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n palmPoint = palmCoordinate; palmLocalPoint = position;')
    shader.fragmentShader = 'varying vec4 palmPoint; varying vec3 palmLocalPoint; uniform vec3 palmCreaseUp; uniform float palmCreaseCenter;\n' + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      float inner = smoothstep(.27,.83,palmPoint.w);
      vec2 pad = (palmPoint.xy - vec2(-.023,-.084)) / vec2(.046,.036);
      diffuseColor.rgb = mix(diffuseColor.rgb,vec3(.97,.57,.48),.25 * exp(-1.35 * dot(pad,pad)) * inner);
      float u = (palmPoint.x + .014) / .039;
      float arc = palmCreaseCenter + .0324 * u * u;
      float dist = (dot(palmLocalPoint,palmCreaseUp) - arc) / (.0026 + .0012 * max(0.,1. - u * u));
      float fingerMask=1.-smoothstep(-.124,-.101,palmPoint.y);
      float fingerEdge=1.-smoothstep(.45,.94,abs(palmPoint.w));
      diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.25,.116,.154),.80*fingerMask*fingerEdge);
      float crease = exp(-dist * dist) * (1. - smoothstep(.72,1.,abs(u))) * inner;
      diffuseColor.rgb = mix(diffuseColor.rgb,vec3(.64,.31,.249),.75 * crease);

    `)
  }
  const handOutline = new MeshBasicMaterial({ color: 0x795766, side: BackSide, depthWrite: false })
  handOutline.userData.outlineParameters = { visible: false }
  handOutline.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n transformed += normalize(normal) * .0025;')
  }
  const calfSkin=skin.clone()
  calfSkin.onBeforeCompile=skin.onBeforeCompile
  calfSkin.vertexColors=true
  calfSkin.customProgramCacheKey=()=>skin.customProgramCacheKey()+'|calf-pigment'
  function limb(parent: Layer, name: string, at: Vec, lengths: readonly [number, number], arm: boolean, side: number) {
    const upper = joint(parent, name, at)
    const lower = joint(upper, 'hinge', [0, -lengths[0], 0])
    const end = joint(lower, arm ? 'wrist' : 'ankle', [0, -lengths[1], 0])
    if (!arm) {
      ball(upper, skin, [0,-lengths[0]*.50,0], [.103,lengths[0]*.66,.100])
      const calf = ball(lower, calfSkin, [0,-lengths[1]*.47,0], [.087,lengths[1]*.64,.090])
      // Shape the calf while keeping the rig and its hidden ankle fit fixed.
      calf.geometry = unit.clone()
      const calfPoints = calf.geometry.attributes.position
      const calfColors:number[]=[], calfShadow=new Color(0xf4cec6), calfPigment=new Color()
      for (let i = 0; i < calfPoints.count; i++) {
        const y = calfPoints.getY(i)
        calfPigment.setRGB(1,1,1).lerp(calfShadow,.82*MathUtils.smoothstep(y,.05,.38))
        calfColors.push(calfPigment.r,calfPigment.g,calfPigment.b)
        const fall = Math.max(0, Math.min(1, (y + .58) / .50))
        const fullness = fall * fall * (3 - 2 * fall)
        const envelope = Math.max(0, 1 - y * y) * fullness
        calfPoints.setX(i, calfPoints.getX(i) * (1 + (.103 / .087 - 1) * fullness) + side * (.008 / .087) * envelope)
        calfPoints.setZ(i, calfPoints.getZ(i) * (1 + (.104 / .090 - 1) * fullness) - (.014 / .090) * envelope)
      }
      calf.geometry.setAttribute('color',new Float32BufferAttribute(calfColors,3))
      calf.geometry.computeVertexNormals()
    }
    if (arm) {
      const sleeve = new SkinnedMesh(sleeveGeometry(lengths), sleevePaint)
      upper.add(sleeve)
      root.updateMatrixWorld(true)
      sleeve.bind(new Skeleton([upper, lower]))
      sleeve.frustumCulled = false
      const cuff = surface(lower, wristRuffle, wristCuffPaint, [0, -lengths[1] + .034, 0])
      cuff.rotation.x = Math.PI
      cuff.name='wrist-cuff'
      const cuffContour=new Mesh(wristRuffle,wristContourPaint)
      cuffContour.name='wrist-cuff-contour'
      cuffContour.renderOrder=1;cuff.add(cuffContour)
      const hand = joint(end, 'palm', [0,0,0])
      hand.scale.set(1.37, 1.41, 1.37)
      ball(end, skin, [0,.005,0], [.041,.034,.034])
      // With the palms turned forward the thumbs follow the outer edge.
      const thumbSide = -side
      const handGeometry=palmGeometry(thumbSide)
      const stencilBit=side<0?2:4
      const palmSkin=handSkin.clone()
      // Fixed bind-space pigment directions authored with the neutral hand.
      // They remain attached to the palm through every pose and camera turn.
      const creaseUp=side<0 ? new Vector3(-.8619171179,.9190006077,.5802374419)
        : new Vector3(.7622695413,1.0042117210,.5863522020)
      const creaseCenter=side<0 ? -.0414091618 : -.0498091618
      palmSkin.onBeforeCompile=(shader,renderer)=>{
        handSkin.onBeforeCompile(shader,renderer)
        shader.uniforms.palmCreaseUp={value:creaseUp}
        shader.uniforms.palmCreaseCenter={value:creaseCenter}
      }
      palmSkin.customProgramCacheKey=()=> 'bluefish-palm-crease3d-1|'+String(handSkin.onBeforeCompile)
      palmSkin.stencilWrite=true
      palmSkin.stencilRef=stencilBit
      palmSkin.stencilFunc=AlwaysStencilFunc
      palmSkin.stencilWriteMask=stencilBit
      palmSkin.stencilZPass=ReplaceStencilOp
      surface(hand, handGeometry, palmSkin).name = 'hand-surface'
      const contourPaint=handOutline.clone()
      contourPaint.onBeforeCompile=handOutline.onBeforeCompile
      contourPaint.stencilWrite=true
      contourPaint.stencilRef=stencilBit
      contourPaint.stencilFunc=NotEqualStencilFunc
      contourPaint.stencilFuncMask=stencilBit
      contourPaint.stencilWriteMask=0
      const contour=new Mesh(handGeometry,contourPaint)
      contour.name='hand-contour'
      contour.renderOrder=1
      hand.add(contour)
    } else {
      const shoe = bluefishShoe(side)
      const piping = new TubeGeometry(new CatmullRomCurve3(shoe.piping, true), 96, .0038, 6, true)
      const soleSeam = new TubeGeometry(new CatmullRomCurve3(shoe.soleSeam, true), 96, .0018, 5, true)
      const sockPaint=white.clone(),sockCuffPaint=cuffPaint.clone()
      for(const material of[sockPaint,sockCuffPaint]){
        material.userData={...material.userData,outlineParameters:{visible:false}}
        material.stencilWrite=true;material.stencilRef=32;material.stencilFunc=AlwaysStencilFunc
        material.stencilWriteMask=32;material.stencilZPass=ReplaceStencilOp
      }
      // Material.clone does not carry the procedural paper callback.
      sockPaint.onBeforeCompile=white.onBeforeCompile;sockPaint.customProgramCacheKey=()=>white.customProgramCacheKey()+'|sock'
      sockCuffPaint.onBeforeCompile=cuffPaint.onBeforeCompile;sockCuffPaint.customProgramCacheKey=()=>cuffPaint.customProgramCacheKey()+'|sock-cuff'
      const sockMesh=surface(end,shoe.sock,sockPaint)
      const cuffMesh=surface(end,sockRuffle,sockCuffPaint,[side*.0065,.112,.022]);cuffMesh.rotation.x=Math.PI
      const contourPaint=new MeshBasicMaterial({color:0x5b5883,side:BackSide,depthWrite:false,
        stencilWrite:true,stencilRef:32,stencilFunc:NotEqualStencilFunc,stencilFuncMask:32,stencilWriteMask:0})
      contourPaint.userData.outlineParameters={visible:false}
      contourPaint.onBeforeCompile=shader=>{
        shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#if !defined(USE_ENVMAP) && !defined(USE_SKINNING)
          #include <beginnormal_vertex>
          #include <morphnormal_vertex>
          #endif
          #include <begin_vertex>`).replace('#include <morphtarget_vertex>',`#include <morphtarget_vertex>
          transformed+=normalize(objectNormal)*.0040;`)
      }
      for(const [mesh,name]of[[sockMesh,'sock-contour'],[cuffMesh,'sock-cuff-contour']] as const){
        const contour=new Mesh(mesh.geometry,contourPaint);contour.name=name;contour.position.copy(mesh.position);contour.quaternion.copy(mesh.quaternion)
        contour.renderOrder=1;contour.frustumCulled=false;end.add(contour)
      }
      surface(end, shoe.sole, soleBlue)
      surface(end, shoe.upper, shoeBlue)
      surface(end, piping, navy)
      surface(end, soleSeam, soleInk)
      surface(end, shoe.strap, dress)
    }
    return { upper, lower, end, lengths }
  }

  const arms = [-1, 1].map(side => limb(spine, side < 0 ? 'left-arm' : 'right-arm',
    [side * .227, .352, -.004], [.259, .248], true, side))
  const legs = [-1, 1].map(side => limb(hips, side < 0 ? 'left-leg' : 'right-leg',
    [side * .152, -.046, .010], [.337, .352], false, side))
  addSkirtGroundShapes(groundedSkirtCloth)
  const headShapes = createBluefishHeadShapes(head, contactSurfaces)
  const torsoShapes = createTorsoViewShapes(spine, skirt, neckSkin, [...arms.map(arm => arm.upper), waistBow])
  return { root, hips, spine, headPivot, head, backHair, fringe, tailBones, tailFlukes: fin, tailMesh, face, headShapes, torsoShapes, arms, legs, skirtCloth, groundedSkirtCloth, apronLoops, shoulderLocks }
}

/** Keep garment seams and shoulder anchors in one physical model space.
 * The camera changes projection; skeletal pose and cloth controls remain
 * responsible for all changes to the character's shape. */
function createTorsoViewShapes(spine: Bone, _skirt: Bone, _neck: Mesh, _anchorBones: readonly Bone[]) {
  spine.updateWorldMatrix(true, true)
  const local = new Vector3(), inverseSpine = new Matrix4()
  return {
    draw(viewDirection: Vector3) {
      inverseSpine.copy(spine.matrixWorld).invert()
      local.copy(viewDirection).transformDirection(inverseSpine)
      const angle = Math.atan2(local.x, local.z)
      const pitch = Math.atan2(local.y, Math.hypot(local.x, local.z))
      return { angle, pitch, weight: 0, rearWeight: 0 }
    },
  }
}

// Extend only the collar's support into the neighboring shirt triangles.
// The falloff prevents a coarse shirt edge from cutting the rolled white hem.
function collarBodiceDepth(geometry: BufferGeometry) {
  const sample = profileFrontDepth(geometry)
  geometry.computeBoundingBox()
  const bounds = geometry.boundingBox!, margin = .032
  const directions = Array.from({length:16},(_,i) => {
    const angle = i * Math.PI / 8
    return [Math.cos(angle),Math.sin(angle)] as const
  })
  return (x: number,y: number,bodyFront: number) => {
    if (x<bounds.min.x-margin || x>bounds.max.x+margin
      || y<bounds.min.y-margin || y>bounds.max.y+margin) return undefined
    const exact = sample(x,y)
    if (exact!==undefined) return exact
    for (let distance=.004;distance<=margin+.00001;distance+=.004) {
      let contact=-Infinity
      for (const [dx,dy] of directions) {
        const depth=sample(x+distance*dx,y+distance*dy)
        if (depth!==undefined) contact=Math.max(contact,depth)
      }
      if (Number.isFinite(contact)) {
        const weight=1-MathUtils.smoothstep(distance,.008,margin)
        return MathUtils.lerp(bodyFront+.030,contact,weight)
      }
    }
    return undefined
  }
}

// The oblique collar opens along the same viewing plane as the torso.
// Its inner fold stays at the neck while the outer cloth lifts and rounds.
function drapeShirtCollar(target: Vector3, source: Vector3, side: number) {
  const outer = MathUtils.smoothstep(Math.abs(source.x), .015, .080)
  const upper = MathUtils.smoothstep(source.y, .371, .449)
  const near = MathUtils.smoothstep(side * source.x, -.015, .040)
  const farFold = .012 * (1 - upper) * (1 - near) * Math.sign(source.x)
  const nearRound = .006 * near * 4 * upper * (1 - upper)
  const spread = outer * (farFold + nearRound) / Math.SQRT2
  target.x += spread
  target.z -= side * spread
  target.y += .017 * outer * near * (.50 + .50 * upper)
}

// Reconnect only flat cap diagonals before the collar is curved. Very thin
// cap slivers can invert under an otherwise smooth oblique cloth deformation.
function improveCollarCaps(geometry: BufferGeometry) {
  const points=geometry.attributes.position, indices=Array.from(geometry.index!.array)
  const cap=(face: number) => {
    const a=indices[face*3], b=indices[face*3+1], c=indices[face*3+2]
    return Math.abs(points.getZ(a)-points.getZ(b))<1e-8
      && Math.abs(points.getZ(a)-points.getZ(c))<1e-8
  }
  const orient=(a: number,b: number,c: number) =>
    (points.getX(b)-points.getX(a))*(points.getY(c)-points.getY(a))
      -(points.getY(b)-points.getY(a))*(points.getX(c)-points.getX(a))
  const key=(a: number,b: number) => Math.min(a,b)+':'+Math.max(a,b)
  for (let pass=0;pass<32;pass++) {
    const edges=new Map<string,{face:number;other:number}[]>()
    for (let face=0;face<indices.length/3;face++) if (cap(face)) {
      const ids=indices.slice(face*3,face*3+3)
      for (let j=0;j<3;j++) {
        const edge=key(ids[j],ids[(j+1)%3]), list=edges.get(edge)??[]
        list.push({face,other:ids[(j+2)%3]});edges.set(edge,list)
      }
    }
    const changed=new Set<number>()
    for (const [edge,pair] of edges) {
      if (pair.length!==2 || pair.some(p=>changed.has(p.face))) continue
      const [u,v]=edge.split(':').map(Number), [{face:f,other:r},{face:g,other:t}]=pair
      if (r===t || edges.has(key(r,t)) || orient(r,t,u)*orient(r,t,v)>=-1e-20) continue
      const ax=points.getX(u)-points.getX(t), ay=points.getY(u)-points.getY(t)
      const bx=points.getX(v)-points.getX(t), by=points.getY(v)-points.getY(t)
      const cx=points.getX(r)-points.getX(t), cy=points.getY(r)-points.getY(t)
      const circle=(ax*ax+ay*ay)*(bx*cy-by*cx)
        -(bx*bx+by*by)*(ax*cy-ay*cx)+(cx*cx+cy*cy)*(ax*by-ay*bx)
      if (circle*orient(u,v,r)<=1e-24) continue
      const sign=orient(indices[f*3],indices[f*3+1],indices[f*3+2])
      const first=orient(r,t,u)*sign>0?[r,t,u]:[r,u,t]
      const second=orient(t,r,v)*sign>0?[t,r,v]:[t,v,r]
      indices.splice(f*3,3,...first);indices.splice(g*3,3,...second)
      changed.add(f);changed.add(g)
    }
    if (changed.size===0) break
  }
  geometry.setIndex(indices)
}

// A simple outer contour with two disjoint height graphs. The lower outline
// retains the original wall; narrow upper folds have no overlapping XY bevel.
function frontBibGeometry(scallops: readonly Curve[]) {
  const lower: readonly (readonly [number,number])[] = [
    [0.145142187,0.290000000],
    [0.145196646,0.279811203],
    [0.145002663,0.264431387],
    [0.144580111,0.248557776],
    [0.143971115,0.232484996],
    [0.143217161,0.216512486],
    [0.142359436,0.200942427],
    [0.141438976,0.186078638],
    [0.140496701,0.172225699],
    [0.139573425,0.159688130],
    [0.138709724,0.148769096],
    [0.137038320,0.129076168],
    [0.109172322,0.124180667],
    [0.090242043,0.121627383],
    [0.070228785,0.119595878],
    [0.049394690,0.118077293],
    [0.028009668,0.117066868],
    [0.006347882,0.116562128],
    [-0.015314579,0.116562128],
    [-0.036701493,0.117067188],
    [-0.057538278,0.118079029],
    [-0.077554248,0.119601384],
    [-0.096486099,0.121641457],
    [-0.114083953,0.124213234],
    [-0.139862359,0.129247367],
    [-0.142236695,0.152273461],
    [-0.143376425,0.166088551],
    [-0.144331500,0.180631354],
    [-0.145104527,0.195698276],
    [-0.145696968,0.211081281],
    [-0.146109596,0.226569995],
    [-0.146342814,0.241953075],
    [-0.146396667,0.257019162],
    [-0.146270841,0.271558166],
    [-0.145964518,0.285362691],
    [-0.145788423,0.290000000],
  ]
  const right=lower[0],left=lower[lower.length-1]
  const valley=.3246,step=.260/scallops.length
  const profile=new Shape().moveTo(...left)
    .bezierCurveTo(left[0],.311,-.137,valley,-.130,valley)
  for (let i=0;i<scallops.length;i++) {
    const x=-.130+i*step,center=x+step*.5
    const peak=.3344+.004*Math.exp(-((center/.026)**2))
    profile.bezierCurveTo(x+step*.18,valley,x+step*.26,peak,center,peak)
      .bezierCurveTo(x+step*.74,peak,x+step*.82,valley,x+step,valley)
  }
  profile.bezierCurveTo(.137,valley,right[0],.311,...right)
  for (const point of lower.slice(1)) profile.lineTo(...point)
  profile.closePath()
  const blank=new ExtrudeGeometry(profile,{depth:.032,bevelEnabled:false,curveSegments:10})
  const geometry=refineProfile(blank,.014)
  blank.dispose()
  const boundary=profile.getPoints(10),p=geometry.attributes.position
  for (let n=0;n<p.count;n++) {
    const x=p.getX(n),y=p.getY(n),z=p.getZ(n)
    if (Math.abs(z)>1e-7 && Math.abs(z-.032)>1e-7) continue
    let squared=Infinity
    for (let j=1;j<boundary.length;j++) {
      const a=boundary[j-1],b=boundary[j],dx=b.x-a.x,dy=b.y-a.y
      const t=MathUtils.clamp(((x-a.x)*dx+(y-a.y)*dy)/(dx*dx+dy*dy||1),0,1)
      squared=Math.min(squared,(x-a.x-t*dx)**2+(y-a.y-t*dy)**2)
    }
    const radius=MathUtils.lerp(.014,.004,MathUtils.smoothstep(y,.290,.315))
    const distance=MathUtils.clamp((Math.sqrt(squared)-1e-7)/radius,0,1)
    const round=Math.sqrt(Math.max(0,1-(1-distance)**2))
    p.setZ(n,z<.016?-.012*round:.032+.012*round)
  }
  return geometry
}

function collarBellGeometry() {
  const profile = new Shape().moveTo(0,.3645)
    .bezierCurveTo(-.002,.3615,-.006,.3555,-.0135,.3485)
    .bezierCurveTo(-.0145,.346,-.010,.346,0,.346)
    .bezierCurveTo(.010,.346,.0145,.346,.0135,.3485)
    .bezierCurveTo(.006,.3555,.002,.3615,0,.3645)
  return new ExtrudeGeometry(profile, { depth: .005, bevelEnabled: true,
    bevelSize: .0009, bevelThickness: .0009, bevelSegments: 2, curveSegments: 12 })
}

function shirtCollar(side: number) {
  const profile = new Shape().moveTo(side * .0075,.419)
  const curves: readonly Curve[] = [
    [.030,.430,.058,.439,.073,.449], [.095,.443,.112,.428,.107,.412],
    [.107,.396,.086,.379,.073,.373], [.067,.370,.062,.373,.056,.379],
    [.040,.395,.022,.411,.0075,.419],
  ]
  for (const [a,b,c,d,e,f] of curves) profile.bezierCurveTo(side*a,b,side*c,d,side*e,f)
  profile.closePath()
  const blank = new ExtrudeGeometry(profile, { depth: .010, bevelEnabled: true,
    bevelSize: .0028, bevelThickness: .0024, bevelSegments: 3, curveSegments: 24 })
  const geometry = refineProfile(blank,.012)
  improveCollarCaps(geometry)
  blank.dispose()
  const boundary = profile.getPoints(18), points = geometry.attributes.position
  const colors: number[] = [], fabric = new Color(0xc4bfdf), rim = new Color(0xfff8ff), pigment = new Color()
  const neckline=profile.curves[0]
  for (let i=0;i<points.count;i++) {
    const x=points.getX(i), y=points.getY(i), depth=points.getZ(i), across=Math.abs(x)
    const rise=MathUtils.smoothstep(y,.363,.466)
    const wrap=.075*(across/.130)**1.4
    const restFront=.130-.055*rise-wrap
    let lo=0,hi=1
    for(let pass=0;pass<12;pass++) {
      const t=(lo+hi)/2
      if(Math.abs(neckline.getPoint(t).x)<across)lo=t
      else hi=t
    }
    const neckHeight=neckline.getPoint((lo+hi)/2).y
    const skinFront=.035+.070*Math.sqrt(Math.max(0,1-(x/.065)**2-((y-.445)/.070)**2))
    // The inner seam rests against the neck, while the rounded free
    // cloth rolls forward over the chest without a view-specific warp.
    const seamFront=MathUtils.lerp(skinFront,restFront,MathUtils.smoothstep(across,.040,.070))
    const free=Math.max(MathUtils.smoothstep(neckHeight-y,.001,.028),MathUtils.smoothstep(across,.070,.105))
    points.setZ(i,MathUtils.lerp(seamFront,restFront+.028,free)+depth)
    let distance=Infinity
    for (let n=1;n<boundary.length;n++) {
      const a=boundary[n-1], b=boundary[n], dx=b.x-a.x, dy=b.y-a.y
      const t=MathUtils.clamp(((x-a.x)*dx+(y-a.y)*dy)/(dx*dx+dy*dy||1),0,1)
      distance=Math.min(distance,Math.hypot(x-a.x-t*dx,y-a.y-t*dy))
    }
    const seam=Math.exp(-((distance/.0035)**2))
    pigment.copy(fabric).lerp(rim,.48*seam)
    colors.push(pigment.r,pigment.g,pigment.b)
  }
  geometry.setAttribute('color',new Float32BufferAttribute(colors,3))
  geometry.computeVertexNormals()
  return geometry
}

function palmGeometry(side: number) {
  const shape = new Shape().moveTo(-.036 * side, .006)
  const contour: readonly Curve[] = [
    [-.053,-.010,-.057,-.030,-.066,-.041],[-.074,-.050,-.086,-.053,-.097,-.062],
    [-.107,-.070,-.100,-.082,-.089,-.082],[-.076,-.080,-.064,-.073,-.053,-.078],
    [-.056,-.095,-.063,-.123,-.063,-.142],[-.064,-.157,-.049,-.162,-.044,-.148],
    [-.041,-.134,-.043,-.120,-.036,-.113],[-.030,-.126,-.036,-.146,-.032,-.165],
    [-.027,-.178,-.012,-.180,-.009,-.164],[-.005,-.147,-.013,-.128,-.006,-.116],
    [-.000,-.132,-.004,-.153,.003,-.166],[.011,-.177,.026,-.169,.024,-.153],
    [.022,-.134,.017,-.123,.023,-.112],[.029,-.124,.032,-.134,.038,-.143],
    [.046,-.152,.058,-.142,.053,-.128],[.048,-.110,.052,-.086,.056,-.067],
    [.061,-.043,.052,-.019,.039,-.007],[.025,.007,-.018,.010,-.036,.006],
  ]
  for (const [a, b, c, d, e, f] of contour) shape.bezierCurveTo(a * side, b, c * side, d, e * side, f)
  shape.closePath()
  const authorBoundary=shape.getPoints(32)
  const smooth=(t:number)=>{const v=MathUtils.clamp(t,0,1);return v*v*(3-2*v)}
  const map=(x:number,y:number)=>{
    const across=side*x,depth=-y,thumb=Math.max(0,-.052-across)
    const opposition=smooth(thumb/.053)*Math.exp(-(((y+.062)/.043)**4))
    const root=MathUtils.smoothstep(depth,.002,.035)
    const fullness=.04*MathUtils.smoothstep(depth,.010,.035)*(1-MathUtils.smoothstep(depth,.095,.135))
    const width=(1+.04*MathUtils.smoothstep(depth,.003,.045)+fullness)*(1+.20*root)
    const finger=MathUtils.clamp((-y-.070)/.102,0,1)
    return {x:(x+side*.50*thumb*opposition)*width,
      y:(y+.001*finger*finger-.0045*opposition)*(1-.058526777*root)}
  }
  const finishedContour=authorBoundary.slice(0,-1).map(p=>map(p.x,p.y))
  const surfaceShape=new Shape().moveTo(finishedContour[0].x,finishedContour[0].y)
  for(const p of finishedContour.slice(1))surfaceShape.lineTo(p.x,p.y)
  surfaceShape.closePath()
  // Triangulate the finished XY silhouette before lifting its two skin sheets.
  // This keeps narrow finger valleys from inverting after a later XY warp.
  const blank=new ExtrudeGeometry(surfaceShape,{depth:.034,bevelEnabled:true,bevelSize:.0005,bevelThickness:.0007,bevelSegments:3,curveSegments:1})
  const geometry=refineProfile(blank,.006)
  blank.dispose()
  function authorAt(px:number,py:number){
    let x=px/1.25,y=py/.96
    for(let i=0;i<10;i++){
      const p=map(x,y),dx=px-p.x,dy=py-p.y
      if(Math.hypot(dx,dy)<1e-9)break
      const h=.00002,a=map(x+h,y),b=map(x,y+h)
      const j00=(a.x-p.x)/h,j10=(a.y-p.y)/h,j01=(b.x-p.x)/h,j11=(b.y-p.y)/h,det=j00*j11-j01*j10
      if(Math.abs(det)<.05)throw new Error('Non-injective authored palm domain')
      x+=MathUtils.clamp((dx*j11-dy*j01)/det,-.02,.02)
      y+=MathUtils.clamp((dy*j00-dx*j10)/det,-.02,.02)
    }
    const p=map(x,y)
    if(Math.hypot(p.x-px,p.y-py)>1e-6)throw new Error('Palm author coordinate did not converge')
    return {x,y}
  }
  function edgeDistance(x:number,y:number){
    let nearest=Infinity
    for(let j=1;j<authorBoundary.length;j++){
      const a=authorBoundary[j-1],b=authorBoundary[j],dx=b.x-a.x,dy=b.y-a.y
      const t=MathUtils.clamp(((x-a.x)*dx+(y-a.y)*dy)/(dx*dx+dy*dy||1),0,1)
      nearest=Math.min(nearest,Math.hypot(x-a.x-dx*t,y-a.y-dy*t))
    }
    return nearest
  }
  const points=geometry.attributes.position,coordinates:number[]=[]
  for(let i=0;i<points.count;i++){
    const p=authorAt(points.getX(i),points.getY(i)),x=p.x,y=p.y,z=points.getZ(i)
    const across=side*x,edge=edgeDistance(x,y),face=(z-.017)/.0177
    const finger=MathUtils.clamp((-y-.070)/.102,0,1)
    const pad=Math.exp(-(((across+.025)/.055)**2)-(((y+.038)/.045)**2))
    const knuckle=.004*Math.exp(-(((y+.110)/.016)**2))+.003*Math.exp(-(((y+.143)/.014)**2))
    const palmThickness=.0043+(.027+.016*pad+knuckle-.008*finger)*(1-Math.exp(-edge/.010))
    const fingerRadius=across<-.036?.0115:across<.023?.0143:.010
    const e=Math.min(fingerRadius,edge),fingerThickness=.0008+.85*Math.sqrt(Math.max(0,e*(2*fingerRadius-e)))
    const thickness=MathUtils.lerp(palmThickness,fingerThickness,MathUtils.smoothstep(-y,.098,.126))
    const thumb=Math.max(0,-.052-across),opposition=smooth(thumb/.053)*Math.exp(-(((y+.062)/.043)**4))
    const centre=.006*pad+finger*finger*(-.012+.184*across)+thumb*(1-.07*opposition)*Math.sin(.66*opposition)
    const round=1+.24*MathUtils.smoothstep(-y,.003,.045)
    points.setZ(i,(centre+face*thickness)*round)
    coordinates.push(across,y,edge,face)
  }
  geometry.setAttribute('palmCoordinate',new Float32BufferAttribute(coordinates,4))
  geometry.computeVertexNormals()
  return geometry
}

function scalpGeometry() {
  const rings = 88, sides = 112
  const positions: number[] = [], indices: number[] = [], offsets: number[] = []
  const openings = [[-.269,1.26],[-.20,1.18],[-.13,.95],[-.045,1.02],[.05,1.05],[.15,.80],[.24,.55],[.32,.30],[.43,0],[.569,0]]
  for (let ring=0;ring<=rings;ring++) {
    const y = -.269+.838*ring/rings
    let index = openings.findIndex((point,i)=>i>0&&point[0]>=y)-1
    if (index<0) index = openings.length-2
    const a = openings[index], b = openings[index+1]
    const t = Math.max(0,Math.min(1,(y-a[0])/(b[0]-a[0])))
    const opening = a[1]+(b[1]-a[1])*t*t*(3-2*t)
    const pole = ring===0 || ring===rings
    // Each pole is a single vertex. An almost-zero final ring produced
    // hairline triangles that collapsed when a view target was blended.
    const radius = pole ? 0 : bluefishCrownRadius(y)
    const cheekCover = .068*Math.exp(-(((y+.110)/.071)**4))
    const offset = positions.length/3
    offsets.push(offset)
    for (let side=0;side<(pole?1:sides+1);side++) {
      const angle = opening+(Math.PI*2-opening*2)*side/sides
      const across = Math.sin(angle), depth = Math.cos(angle)
      const crownLift = bluefishCrownLift(y,radius,-depth)
      // The temple turns inward below the crown. A spherical cross
      // section hid the bow's gathered end behind a broad blue shelf.
      const templeTaper = .058 * Math.exp(-(((y-.335)/.145)**4)
        - (((depth+.19)/.49)**4)) * across**4
      const px=(.465+cheekCover*across**4-templeTaper)*radius*across,py=y+crownLift,pz=-.139+(.437+.065*Math.max(0,-depth))*radius*depth
      positions.push(px,py,pz+bluefishCrownInset(px,py,pz))
    }
    if (ring===0) continue
    const previous = offsets[ring-1]
    for (let side=0;side<sides;side++) {
      if (ring===1) indices.push(0,offset+side+1,offset+side)
      else if (pole) indices.push(previous+side,previous+side+1,offset)
      else indices.push(previous+side,previous+side+1,offset+side,
        previous+side+1,offset+side+1,offset+side)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position',new Float32BufferAttribute(positions,3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

function sleeveGeometry([upper, lower]: readonly [number, number]) {
  const rows = 56, sides = 36
  const positions: number[] = [], indices: number[] = [], colors: number[] = []
  const joints: number[] = [], weights: number[] = []
  const base = new Color(0x434f92), crease = new Color(0x303a77), color = new Color()
  for (let row = 0; row <= rows; row++) {
    const t = row / rows
    const y = .067 - (.067 + upper + lower - .018) * t
    const shoulder = .044 * Math.exp(-(((t - .245) / .155) ** 2))
    const forearm = .018 * Math.exp(-(((t - .765) / .184) ** 2))
    const start = Math.min(1, t / .095)
    const radius = .010 + (.065 + shoulder + forearm) * Math.sin(Math.PI * start / 2)
    const elbow = Math.max(0, Math.min(1, (-y - upper + .067) / .134))
    const weight = elbow * elbow * (3 - 2 * elbow)
    for (let i = 0; i < sides; i++) {
      const angle = i * 2 * Math.PI / sides
      const inside = .50 + .50 * Math.cos(angle - .52)
      const seam = t + .049 * Math.sin(angle + .40) + .015 * Math.cos(angle * 2)
      const trough = .012 * Math.exp(-(((seam - .469) / .024) ** 2))
        + .013 * Math.exp(-(((seam - .645) / .024) ** 2))
      const elbowFold = (.012 * Math.exp(-(((seam - .512) / .039) ** 2))
        + .009 * Math.exp(-(((seam - .693) / .038) ** 2)) - trough) * (.30 + .70 * inside)
      const fold = elbowFold + .005 * Math.cos(angle * 5 + 4 * t) * Math.sin(Math.PI * t) ** 2
      positions.push(Math.sin(angle)*(radius+fold),y,Math.cos(angle)*(radius+fold)*.92)
      color.copy(base).lerp(crease, Math.min(.56, trough * (16 + 28 * inside) + Math.max(0, -fold) * 11))
      colors.push(color.r,color.g,color.b)
      joints.push(0,1,0,0)
      weights.push(1-weight,weight,0,0)
      if (row < rows) {
        const a = row * sides + i, b = row * sides + (i + 1) % sides
        indices.push(a,a+sides,b,b,a+sides,b+sides)
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position',new Float32BufferAttribute(positions,3))
  geometry.setAttribute('color',new Float32BufferAttribute(colors,3))
  geometry.setAttribute('skinIndex',new Uint16BufferAttribute(joints,4))
  geometry.setAttribute('skinWeight',new Float32BufferAttribute(weights,4))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

function apronShoulder(side: number) {
  const sections = [
    // Stitched edge and the edge that falls over the sleeve.
    [.163,.139,.231, .176,.141,.231], [.166,.226,.225, .209,.221,.232],
    [.172,.327,.208, .234,.313,.228], [.174,.399,.173, .250,.382,.192],
    [.170,.452,.110, .260,.431,.105], [.165,.472,.043, .332,.401,-.018],
    [.164,.461,-.038, .354,.394,-.059], [.160,.423,-.111, .347,.332,-.102],
    [.155,.343,-.167, .323,.270,-.108], [.156,.238,-.183, .198,.218,-.183],
    [.163,.145,-.176, .176,.144,-.176],
  ]
  const path = new CatmullRomCurve3(sections.map(([x, y, z]) => new Vector3(side * x, y, z)))
  const outer = new CatmullRomCurve3(sections.map(([, , , x, y, z]) => new Vector3(side * x, y, z)))
  const rows = 144, faceColumns = 16, rollColumns = 5, columns = faceColumns + rollColumns
  const positions: number[] = [], colors: number[] = [], indices: number[] = [], rim: Vector3[] = []
  const cloth = new Color(0xf8f1fa), shadow = new Color(0xa9a5d1), pigment = new Color()
  const length = path.getLength()
  for (let row = 0; row <= rows; row++) {
    const t = row / rows, sample = path.getUtoTmapping(t, t * length)
    const at = path.getPoint(sample), overSleeve = outer.getPoint(sample), tangent = path.getTangent(sample)
    const normal = new Vector3(0, -tangent.z, tangent.y).normalize()
    const cell = (t * 15) % 1
    const scallop = Math.sin(Math.PI * cell) ** .55
    const trough = Math.exp(-(((cell - .18) / .115) ** 2))
    const taper = Math.sin(Math.PI * t) ** .54
    const spread = .84 + .18 * scallop
    for (let column = 0; column <= columns; column++) {
      const u = Math.min(1, column / faceColumns)
      const roll = Math.max(0, (column - faceColumns) / rollColumns)
      const turn = (1 - Math.cos(Math.PI * roll)) / 2
      const gathered = Math.sin(Math.PI * u) * taper
      const lift = .010 + (.013 + .018 * scallop - .019 * trough) * gathered
        + .012 * Math.sin(Math.PI * roll) - .010 * turn
      const point = at.clone().lerp(overSleeve, spread * u - .21 * turn * taper)
        .addScaledVector(normal, lift)
      point.x -= side * .016
      // Let the cheek curls finish above the shoulder frill. The lower
      // sewn edge stays at the bib while the arch settles over the sleeve.
      const arch = Math.max(0,Math.min(1,(point.y-.27)/.18))
      point.y -= .045*arch*arch*(3-2*arch)
      positions.push(point.x, point.y, point.z)
      const shade = .046 + .34 * trough * gathered + .11 * (1 - scallop) * u + .21 * turn
      pigment.copy(cloth).lerp(shadow, shade)
      colors.push(pigment.r, pigment.g, pigment.b)
      if (column === faceColumns) rim.push(point)
      if (row < rows && column < columns) {
        const a = row * (columns + 1) + column, b = a + columns + 1
        if (side > 0) indices.push(a, a + 1, b, a + 1, b + 1, b)
        else indices.push(a, b, a + 1, a + 1, b, b + 1)
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return { geometry, rim }
}

const NAVY_PLEATS = 12
const PETTICOAT_PLEATS = 16
const PETTICOAT_FRONT_TURN = { upper: .043, lower: .103 } as const

function petticoatTaper(angle: number, depth: number) {
  return 1 - .073 * Math.sin(angle) ** 2 * depth ** 2
}

function skirtPleat(angle: number, height: number, hem: number, phase: number, petticoat: boolean) {
  const turn = petticoat ? 1.4*(height-hem)*Math.sin(angle) : height*4
  const spacing = petticoat ? .32*Math.sin(angle*3)+.21*Math.sin(angle*5)-Math.PI*Math.sin(angle)**3
    : 2.4*Math.sin(2*angle)-.70*Math.sin(4*angle)
  return angle*(petticoat?PETTICOAT_PLEATS:NAVY_PLEATS)+(petticoat?0:phase)+turn+spacing
}

function addSkirtDrapeShapes(geometry: BufferGeometry, petticoat: boolean) {
  const position = geometry.attributes.position
  const seated = position.clone()
  const leftFold = position.clone()
  const kneeDrape = position.clone()
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i)
    const front = Math.max(0, Math.min(1, (z - .16) / .11))
    const hem = Math.max(0, Math.min(1, (-y - .12) / .044))
    // Drape around the bent right leg. The waist and rear tie stay put.
    const knee = Math.exp(-(((x - .254) / .188) ** 4))
    const lift = knee * front * front * (3 - 2 * front) * hem * hem * (3 - 2 * hem)
    const clearance = .91 * Math.max(0, .444 - z) * lift
    seated.setXYZ(i, x, y + .012 * lift, z + clearance)
    // The left foot stays farther forward through the rise. Let the
    // cloth fold behind it, with the trim following the same surface.
    const ankle = Math.exp(-(((x + .067) / .20) ** 4))
    const inner = Math.max(0, Math.min(1, (.111 - x) / .046))
    const fall = Math.max(0, Math.min(1, (-y - (petticoat ? .102 : .194)) / .087))
    const forward = Math.max(0, z - .086)
    const gather = .72 * (forward - .027 * Math.tanh(forward / .027))
    const tuck = ankle * inner * inner * (3 - 2 * inner) * fall * fall * (3 - 2 * fall)
    const bridge = Math.max(0, Math.min(1, (x + .025) / .105))
    const drawLeft = .036 * bridge ** 1.4 * Math.min(1, gather / .13) * tuck
    leftFold.setXYZ(i, x - drawLeft, y + .061 * gather * tuck, z - gather * tuck)
    // A pose corrective opens the front cloth over both bent knees. The
    // waist stays pinned; the standing turnaround remains unchanged.
    // The same field is evaluated on the fabric, seams and rolled rims.
    const bothKnees = Math.max(Math.exp(-(((x + .16) / .25) ** 4)), Math.exp(-(((x - .16) / .25) ** 4)))
    const kneeHeight = Math.exp(-(((y + .09) / .31) ** 4)) * (1 - MathUtils.smoothstep(y, .11, .22))
    const inFront = MathUtils.smoothstep(z, .10, .27)
    kneeDrape.setXYZ(i, x, y, z + .23 * bothKnees * kneeHeight * inFront)
  }
  const target = new BufferGeometry()
  target.setIndex(geometry.index)
  geometry.morphAttributes.position = [seated, leftFold, kneeDrape]
  geometry.morphAttributes.normal = geometry.morphAttributes.position.map(shape => {
    target.setAttribute('position', shape)
    target.computeVertexNormals()
    return target.attributes.normal.clone()
  })
  target.dispose()
}

/** Lift whole folded sections instead of flattening every point against
 * the floor. Each tier shares one periodic field across fabric and returns. */
function addSkirtGroundShapes(meshes: readonly Mesh[]) {
  const bins=256, step=2*Math.PI/bins
  for (const tier of ['upper','lower']) {
    const members=meshes.filter(mesh=>mesh.name.startsWith('petticoat-'+tier))
    const records=members.map(mesh=>{
      const geometry=mesh.geometry,position=geometry.attributes.position
      const seated=geometry.morphAttributes.position![0]
      const angles=Array.from({length:position.count},(_,i)=>{
        const angle=Math.atan2(position.getX(i),position.getZ(i))
        return ((angle+2*Math.PI)%(2*Math.PI))/step
      })
      return {mesh,geometry,position,seated,angles}
    })
    const field=(floor: number)=>{
      const demand=Array<number>(bins).fill(0)
      for(const {position,seated,angles} of records) for(let i=0;i<position.count;i++) {
        const weight=MathUtils.smoothstep(-position.getY(i),.25,.34)
        if(weight<.9999)continue
        const index=Math.floor(angles[i])%bins
        demand[index]=Math.max(demand[index],floor-seated.getY(i))
      }
      const lift=demand.map((value,i)=>Math.max(value,demand[(i+bins-1)%bins],demand[(i+1)%bins]))
      // A periodic upper envelope bounds changes between adjacent folds
      // without ever reducing a displacement needed for floor clearance.
      const slope=.10*step
      for(let i=0;i<2*bins;i++){const j=i%bins;lift[j]=Math.max(lift[j],lift[(j+bins-1)%bins]-slope)}
      for(let i=2*bins-1;i>=0;i--){const j=i%bins;lift[j]=Math.max(lift[j],lift[(j+1)%bins]-slope)}
      return lift
    }
    const high=field(-.371),low=field(-.389)
    for(const {mesh,geometry,position,seated,angles} of records) {
      const ground=position.clone()
      for(let i=0;i<position.count;i++) {
        const at=angles[i],column=Math.floor(at)%bins,blend=at-Math.floor(at),next=(column+1)%bins
        const weight=MathUtils.smoothstep(-position.getY(i),.25,.34)
        const highLift=MathUtils.lerp(high[column],high[next],blend)*weight
        const lowLift=MathUtils.lerp(low[column],low[next],blend)*weight
        seated.setY(i,seated.getY(i)+.5*(highLift+lowLift))
        ground.setY(i,position.getY(i)+.5*(highLift-lowLift))
      }
      ground.name='ground-contact'
      geometry.morphAttributes.position!.push(ground)
      const target=new BufferGeometry()
      target.setIndex(geometry.index)
      for(const index of [0,3]) {
        target.setAttribute('position',geometry.morphAttributes.position![index])
        target.computeVertexNormals()
        geometry.morphAttributes.normal![index]=target.attributes.normal.clone()
      }
      target.dispose()
      // The mesh was created before the shared tier field was available.
      // Register its new target before the torso view shapes append theirs.
      mesh.updateMorphTargets()
    }
    finalizeSewnClothShapes(members)
  }
}

/** The continuous fabric and its gathered root share normals through every
 * pose blend. The same physical sheet supplies the two visible cloth sides. */
function finalizeSewnClothShapes(meshes: readonly Mesh[]) {
  if (!meshes.length || meshes.some(mesh=>!mesh.geometry.userData.sewnRoot)) return
  const columns=meshes[0].geometry.userData.sewnRoot.columns as number
  const records=meshes.map(mesh=>{
    const g=mesh.geometry,root=g.userData.sewnRoot as {front:number[];back:number[];columns:number}
    const ids=new Map<number,number>()
    for(const [side,offset]of[['front',0],['back',columns]] as const)
      root[side].forEach((id,c)=>ids.set(id,offset+c))
    return{g,ids}
  })
  const a=new Vector3(),b=new Vector3(),c=new Vector3(),ab=new Vector3(),ac=new Vector3(),area=new Vector3()
  for(let t=0;t<meshes[0].geometry.morphAttributes.position!.length;t++) {
    const normals=new Float64Array(columns*2*3)
    for(const {g,ids}of records) {
      const p=g.morphAttributes.position![t],index=g.index!.array
      for(let i=0;i<index.length;i+=3) {
        const ia=index[i],ib=index[i+1],ic=index[i+2],sa=ids.get(ia),sb=ids.get(ib),sc=ids.get(ic)
        if(sa===undefined&&sb===undefined&&sc===undefined)continue
        a.fromBufferAttribute(p,ia);b.fromBufferAttribute(p,ib);c.fromBufferAttribute(p,ic)
        ab.subVectors(b,a);ac.subVectors(c,a);area.crossVectors(ab,ac)
        for(const s of[sa,sb,sc])if(s!==undefined){normals[s*3]+=area.x;normals[s*3+1]+=area.y;normals[s*3+2]+=area.z}
      }
    }
    for(const {g,ids}of records) {
      const normal=g.morphAttributes.normal![t]
      for(const[id,s]of ids){area.fromArray(normals,s*3).normalize();normal.setXYZ(id,area.x,area.y,area.z)}
      normal.needsUpdate=true
    }
  }
}

function foldedSkirt(profile: readonly (readonly [number, number])[], amplitude: number, phase: number, tier?: 'upper' | 'lower') {
  const petticoat = tier !== undefined
  const pleats = petticoat?PETTICOAT_PLEATS:NAVY_PLEATS
  const columns = pleats*24, fabricRows = 36
  // The gathered inner foundation ends under the visible pleat panels.
  const rows = petticoat ? 1 : fabricRows
  const section = new CatmullRomCurve3(profile.map(([radius,height]) => new Vector3(radius,height,0)),false,'catmullrom',.35)
  const positions: number[] = [], indices: number[] = [], colors: number[] = []
  const hem: Vector3[] = []
  const foldCoordinates: number[] = []
  for (let row = 0; row <= rows; row++) {
    const depth = Math.min(1, row / fabricRows)
    const { x: radius, y: height } = section.getPoint(depth)
    for (let column = 0; column < columns; column++) {
      const angle = column * 2 * Math.PI / columns
      const pleat = skirtPleat(angle,height,profile[profile.length-1][1],phase,petticoat)
      const crest = Math.cos(pleat)
      const panelAngle = Math.atan2(Math.sin(pleat), crest) / Math.PI
      const panelEdge = Math.abs(panelAngle)
      const face = Math.max(0, Math.min(1, (.88 - panelEdge) / .36))
      const inset = Math.max(0, Math.min(1, (panelEdge - .68) / .32))
      const panel = face * face * (3 - 2 * face)
      const backfold = inset * inset * (3 - 2 * inset)
      const raised = petticoat ? (.5 + .5 * crest) ** .62 : .72 * (.5 + .5 * crest) ** .62 + .28 * panel
      const groove = petticoat ? (.5 - .5 * crest) ** 3 : .42 * (.5 - .5 * crest) ** 3 + .58 * backfold
      const corner = Math.exp(-(((panelEdge - .57) / .145) ** 2))
      const fold = (petticoat ? .75 * raised - .92 * groove : .68 * raised - 1.03 * groove) * (.15 + .85 * depth)
      // The navy cloth ends at its sewn edge with a fine physical binding.
      // A second returned sheet here crossed the seated folds.
      const facePlane = petticoat ? 1 / Math.cos(panelAngle * Math.PI / pleats) : 1
      const radiusVariation = petticoat ? Math.sin(phase)*Math.cos(angle*4) : Math.sin(angle*4+phase)
      const skirtRadius = radius * facePlane + fold * amplitude * (1 + .17 * radiusVariation)
        * (petticoat ? 1 : 1 - .46 * depth ** 4)
        - (petticoat ? .028 * depth ** 1.45 : 0)
        - (petticoat ? .020 + .025 * (1 - depth) + .020*MathUtils.smoothstep(depth,.20,.50) : 0)
      const foldAngle = angle + (petticoat ? .017 : MathUtils.lerp(.017,-.025,MathUtils.smoothstep(depth,.82,.90)*MathUtils.smoothstep(Math.cos(angle),.05,.35))) * Math.sin(pleat) * depth ** 1.8
      const x = Math.sin(foldAngle) * skirtRadius * (petticoat ? petticoatTaper(angle, depth) : 1)

      const front = Math.max(0, Math.cos(angle))
      // Box pleats hang lower across their broad faces. The folded returns
      // gather upward into the narrower valleys at each join.
      const foldHeight = petticoat ? (-.012 * panel + .028 * backfold + .007 * panelAngle * Math.sin(angle)) * depth ** 1.5
        : (.003 - .010 * raised - .003 * corner + .009 * groove - .003 * front ** 2
          + .011 * groove * MathUtils.smoothstep(depth,.12,.95)) * depth ** 1.7
      const y = height + foldHeight + (petticoat ? tier==='upper' ? .050 : .106 : .103) * Math.sin(angle) ** 2
        + .016 * depth ** 2 * (petticoat ? Math.sin(phase)*Math.cos(angle*3) : Math.sin(angle*3+phase))
        - (petticoat ? .005 * depth ** 3 : 0)

      const rear = Math.max(0, -Math.cos(angle))
      const bustle = rear ** 1.6 * (petticoat ? .21 : .15) * (.28 + .72 * depth)
      const frontTurn = tier ? PETTICOAT_FRONT_TURN[tier] * front ** 4 * (.65 + .35 * depth) : 0
      const z = Math.cos(foldAngle) * skirtRadius * (petticoat ? .80 - .041 * front ** 2 - frontTurn : .80) - bustle
      positions.push(x, y, z)
      if (!petticoat) foldCoordinates.push(Math.sin(pleat),Math.cos(pleat),depth)
      const valley = Math.max(0, -.08 - crest)
      const underside = petticoat ? (.14 * Math.exp(-(((depth - .22) / .24) ** 2)) + .064 * depth ** 7) * (.52 + .48 * valley) : 0
      const edgeFold = Math.exp(-(((panelEdge - .79) / .109) ** 2)) * depth ** 1.4
      const returnCrease = Math.exp(-(((panelAngle - .71) / .087) ** 2)) * depth ** 1.65
      const foldShadow = petticoat ? valley ** 1.3 * (.07 + .20 * depth) + .24 * edgeFold + .10 * returnCrease
        : groove * (.075 + .58 * depth) + .08 * returnCrease + .08 * edgeFold
      const shadow = foldShadow + underside
      colors.push(1-.99*shadow,1-1.04*shadow,1-.53*shadow)
      if (row === fabricRows) hem.push(new Vector3(x, y, z))
      if (row < rows) {
        const a = row * columns + column, b = row * columns + (column + 1) % columns
        indices.push(a, a + columns, b, b, a + columns, b + columns)
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
  if (!petticoat) geometry.setAttribute('skirtFold',new Float32BufferAttribute(foldCoordinates,3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  function pointAt(angle: number, depth: number) {
    const u = (angle / (Math.PI * 2) % 1 + 1) % 1 * columns
    const v = Math.min(rows, Math.max(0, Math.min(1, depth)) * fabricRows)
    const col = Math.floor(u), row = Math.min(Math.min(rows,fabricRows) - 1, Math.floor(v)), next = (col + 1) % columns
    const point = (r: number, c: number) => {
      const i = (r * columns + c) * 3
      return new Vector3(positions[i], positions[i + 1], positions[i + 2])
    }
    const across = u - col
    return point(row, col).lerp(point(row, next), across).lerp(
      point(row + 1, col).lerp(point(row + 1, next), across), v - row)
  }
  return { geometry, hem, pointAt }
}

function petticoatLeaves(profile: readonly (readonly [number, number])[], phase: number, lower: boolean, foundationSource:BufferGeometry, navy?:BufferGeometry) {
  const section = new CatmullRomCurve3(profile.map(([r, y]) => new Vector3(r, y, 0)), false, 'catmullrom', .35)
  const count = PETTICOAT_PLEATS, columns = 24, faceRows = 24, rollRows = 8
  const rows = faceRows
  const positions: number[] = [], colors: number[] = [], indices: number[] = [], hemCoordinates: number[] = []
  const lining = new Color(0x5a5374)
  for (let panel = 0; panel < count; panel++) {
    const offset = positions.length / 3
    const sector = panel * Math.PI * 2 / count
    const foldHand = Math.abs(Math.sin(sector)) < 1e-6 ? 0 : Math.sign(Math.sin(sector))
    for (let row = 0; row <= rows; row++) {
      const t = 1-(1-Math.min(1,row/faceRows))**1.5
      const roll = Math.max(0, (row - faceRows) / rollRows)
      const depth = .32 + .68 * t
      const { x: radius, y: height } = section.getPoint(depth)
      const turn = (1 - Math.cos(Math.PI * roll)) / 2
      const round = Math.sin(Math.PI * roll)
      const hemHeight = profile[profile.length-1][1]
      let center = sector
      for (let pass = 0; pass < 4; pass++) {
        center -= (skirtPleat(center,height,hemHeight,phase,true)-sector*count)
          / (count+1.4*(height-hemHeight)*Math.cos(center)+.96*Math.cos(center*3)+1.05*Math.cos(center*5)-3*Math.PI*Math.sin(center)**2*Math.cos(center))
      }
      const flare = Math.sin(center) ** 2
      const hang = lower ? .005 - .043 * flare : .012 * flare - .012 * Math.max(0, Math.cos(center)) ** 4
      for (let column = 0; column <= columns; column++) {
        const u = column / columns, across = 2 * u - 1
        const sewnU = foldHand < 0 ? 1-u : u
        const belly = Math.sin(Math.PI * u)
        const corner = Math.abs(across) ** 6
        const leftFold = Math.exp(-(((sewnU - .055 - (foldHand === 0 ? .036 : .072) * (1 - t)) / .15) ** 2))
        const rightFold = Math.exp(-(((sewnU - .945 + (foldHand === 0 ? .036 * (1 - t) : 0)) / .15) ** 2))
        const opening = Math.max(leftFold, rightFold)
        const sideDrop = .004 * Math.sin(phase) * Math.cos(sector * 2)
        const phaseAt=sector*count+.90*count*(across*(.1575+.0512*t)+.012*Math.sin(Math.PI*across)*t**2
          +.008*(rightFold-leftFold)*turn*foldHand)
        let angle=center+across*(.1575+.0512*t)
        for(let pass=0;pass<5;pass++) angle-=(skirtPleat(angle,height,hemHeight,phase,true)-phaseAt)
          /(count+1.4*(height-hemHeight)*Math.cos(angle)+.96*Math.cos(angle*3)+1.05*Math.cos(angle*5)
            -3*Math.PI*Math.sin(angle)**2*Math.cos(angle))
        if(!lower&&panel===3) angle+=.05*Math.sin(Math.PI*t)**2
        const innerFold = foldHand === 0 ? .5*(leftFold+rightFold) : leftFold
        const fold = .012 * belly ** .80 * t + (.021 * corner - .021 * innerFold) * t ** 1.65
        const rear = Math.max(0, -Math.cos(angle))
        const underHair = Math.max(0, Math.min(1, (.12 - Math.cos(angle)) / .54))
        // A raised edge laps over the returning edge of the next pleat.
        const overlap = (foldHand === 0 ? .0015*((1-u)**4+u**4)
          : .025*(1-sewnU)**4-.022*sewnU**4) * t ** 1.6
        const r = radius - .014 - .031 * (1 - t) ** 2 + .034 * t ** 1.6 + fold + overlap
          + .022 * turn + .008 * opening * round
          + .008*Math.exp(-(((t-.65)/.24)**2))*belly*Math.max(0,Math.cos(center))**2
        const bustle = rear ** 1.6 * .21 * (.28 + .72 * depth) - rear * (lower ? .079 : .034) * t ** 1.65
        const frontFace=Math.max(0,Math.cos(center))**2
        const y = height + (lower?.106:.050) * Math.sin(angle) ** 2 + .011 * depth ** 2 * Math.sin(phase) * Math.cos(angle * 3)
          + (-.015 - .002 * belly + .036 * corner + (.007+.010*flare) * across * foldHand + hang + sideDrop) * t ** 1.65
          + (.006 + .015 * opening) * turn - .0015 * opening * round
          -(lower?.008:.009)*belly**.7*frontFace*t**1.65
          +(!lower&&panel===3 ? (.020*Math.sin(Math.PI*u)**2-.032*MathUtils.smoothstep(u,.72,1))*t**1.65 : 0)
        const front = Math.max(0, Math.cos(angle))
        const taper = petticoatTaper(angle, depth) * (1 - flare * t ** 1.8 *
          (lower ? .041 + .110 * underHair : .040 * underHair))
        const frontTurn = PETTICOAT_FRONT_TURN[lower ? 'lower' : 'upper'] * front ** 4 * (.65 + .35 * t)
        const x = Math.sin(angle) * r * taper, z = Math.cos(angle) * r * (.80 - .028 * front ** 2 - frontTurn) - bustle
        positions.push(x, y, z)
        const pleat = .46 * leftFold * Math.sin(Math.PI * t * .84)
        const tuck = .22 * rightFold * Math.exp(-(((t - .55) / .34) ** 2))
        const rim = .08 * Math.exp(-(((t - 1) / .067) ** 2)) * (1 - turn)
        const underside = (.09 + .10 * opening) * round ** .5
        const shadow = Math.min(.82, .035 + pleat + tuck + .08 * corner * t ** 1.7 + rim + underside)
        // Shade the cavity while the returning tip stays white. Coloring
        // the whole return navy made the curled hems read as cut teeth.
        const inside = .88*opening**.9*round**.65
        colors.push((1-.86*shadow)*(1-inside)+lining.r*inside,
          (1-.96*shadow)*(1-inside)+lining.g*inside,(1-.55*shadow)*(1-inside)+lining.b*inside)
        // The rim stays on the same fabric through the pose morphs. Its
        // shader gives the fine line a steady width as the model rotates.
        hemCoordinates.push(row <= faceRows ? t-1 : roll*.05)
        if (column < columns && row < rows) {
          const a = offset + row * (columns + 1) + column, b = a + columns + 1
          indices.push(a, b, a + 1, a + 1, b, b + 1)
        }
      }
    }
  }
  // Recessed cloth joins the broad faces into one sewn, periodic sheet.
  // Shared edge indices retain a continuous surface through each fold.
  const sideColumns=8,stride=columns+1,panelStride=(rows+1)*stride
  for(let panel=0;panel<count;panel++) {
    const next=(panel+1)%count,grid:number[][]=[]
    for(let row=0;row<=rows;row++) {
      const left=panel*panelStride+row*stride+columns,right=next*panelStride+row*stride
      const a=new Vector3().fromArray(positions,left*3),b=new Vector3().fromArray(positions,right*3)
      const t=1-(1-Math.min(1,row/faceRows))**1.5,ids=[left]
      for(let column=1;column<sideColumns;column++) {
        const u=column/sideColumns,fold=Math.sin(Math.PI*u),point=a.clone().lerp(b,u)
        const radial=new Vector3(point.x,0,point.z).normalize()
        point.addScaledVector(radial,-.018*fold*MathUtils.smoothstep(t,.05,.45))
        const id=positions.length/3;point.toArray(positions,id*3);ids.push(id)
        const shade=.30*fold*MathUtils.smoothstep(t,.10,.65)
        for(let k=0;k<3;k++) {
          const color=MathUtils.lerp(colors[left*3+k],colors[right*3+k],u)
          colors.push(MathUtils.lerp(color,k===0?lining.r:k===1?lining.g:lining.b,shade))
        }
        hemCoordinates.push(MathUtils.lerp(hemCoordinates[left],hemCoordinates[right],u))
      }
      ids.push(right);grid.push(ids)
    }
    for(let row=0;row<rows;row++)for(let column=0;column<sideColumns;column++) {
      const a=grid[row][column],b=grid[row+1][column],c=grid[row][column+1],d=grid[row+1][column+1]
      indices.push(a,b,c,c,b,d)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
  geometry.setAttribute('clothHem',new Float32BufferAttribute(hemCoordinates,1))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return sewnPetticoatGeometry(geometry,foundationSource,count,columns,faceRows,sideColumns,navy)
}

/** Nearest actual cloth surface along a horizontal hip-polar ray.
 * Inward-facing folds participate in the inner clearance as well. */
function radialClothDepth(geometry:BufferGeometry){
  const position=geometry.attributes.position,index=geometry.index!,bins=128,step=2*Math.PI/bins,cellHeight=.025;
  const triangles:{a:Vector3;b:Vector3;c:Vector3}[]=[],cells=new Map<string,number[]>();
  const key=(angle:number,height:number)=>((angle%bins+bins)%bins)+','+height;
  for(let i=0;i<index.count;i+=3){
    const vertices=[0,1,2].map(k=>new Vector3().fromBufferAttribute(position,index.getX(i+k)));
    const angles=vertices.map(v=>Math.atan2(v.x,v.z)),anchor=angles[0];
    for(let k=1;k<3;k++){while(angles[k]-anchor>Math.PI)angles[k]-=2*Math.PI;while(angles[k]-anchor< -Math.PI)angles[k]+=2*Math.PI;}
    const n=triangles.push({a:vertices[0],b:vertices[1],c:vertices[2]})-1;
    for(let angle=Math.floor((Math.min(...angles)-1e-7)/step);angle<=Math.floor((Math.max(...angles)+1e-7)/step);angle++)
      for(let height=Math.floor((Math.min(...vertices.map(v=>v.y))-1e-7)/cellHeight);height<=Math.floor((Math.max(...vertices.map(v=>v.y))+1e-7)/cellHeight);height++){
        const at=key(angle,height),list=cells.get(at);if(list)list.push(n);else cells.set(at,[n]);
      }
  }
  const ray=new Ray(),hit=new Vector3();
  return(x:number,y:number,z:number)=>{
    const angle=Math.atan2(x,z),radius=Math.hypot(x,z);ray.origin.set(0,y,0);ray.direction.set(x/radius,0,z/radius);
    let nearest=Infinity;
    for(const i of cells.get(key(Math.floor(angle/step),Math.floor(y/cellHeight)))??[]){
      const{a,b,c}=triangles[i];if(ray.intersectTriangle(a,b,c,false,hit))nearest=Math.min(nearest,Math.hypot(hit.x,hit.z));
    }
    return Number.isFinite(nearest)?nearest:undefined;
  };
}

// One fixed polar cloth chart joins the gathered root to the visible box folds.
// The cloth has a sewn internal seam and open waist/free-hem boundaries.
function sewnPetticoatGeometry(raw:BufferGeometry,waist:BufferGeometry,panels:number,faceColumns:number,bodyRows:number,seamColumns:number,navy?:BufferGeometry) {
  type ClothPoint={p:Vector3;color:Color;hem:number}
  const columns=panels*(faceColumns+seamColumns),foundationRows=12,totalRows=foundationRows+bodyRows
  const rp=raw.attributes.position,rc=raw.attributes.color,rh=raw.attributes.clothHem
  const originalCount=panels*(bodyRows+1)*(faceColumns+1)
  function read(id:number):ClothPoint{return{p:new Vector3().fromBufferAttribute(rp,id),color:new Color().fromBufferAttribute(rc,id),hem:rh.getX(id)}}
  function sample(loop:ClothPoint[],angle:number):ClothPoint {
    const dx=Math.sin(angle),dz=Math.cos(angle)
    let radius=-Infinity,edge=-1,fraction=0
    for(let i=0;i<loop.length;i++) {
      const a=loop[i].p,b=loop[(i+1)%loop.length].p,ex=b.x-a.x,ez=b.z-a.z,den=dx*ez-dz*ex
      if(Math.abs(den)<1e-12)continue
      const u=(a.x*dz-a.z*dx)/den,r=(a.x*ez-a.z*ex)/den
      if(u>=-1e-7&&u<=1.0000001&&r>radius&&r>0){radius=r;edge=i;fraction=MathUtils.clamp(u,0,1)}
    }
    if(edge<0)throw new Error('Petticoat chart does not enclose its waist axis')
    const a=loop[edge],b=loop[(edge+1)%loop.length]
    return{p:new Vector3(radius*dx,MathUtils.lerp(a.p.y,b.p.y,fraction),radius*dz),color:a.color.clone().lerp(b.color,fraction),hem:MathUtils.lerp(a.hem,b.hem,fraction)}
  }
  const body:ClothPoint[][]=[]
  for(let row=0;row<=bodyRows;row++) {
    const loop:ClothPoint[]=[]
    for(let panel=0;panel<panels;panel++) {
      for(let c=0;c<=faceColumns;c++)loop.push(read(panel*(bodyRows+1)*(faceColumns+1)+row*(faceColumns+1)+c))
      for(let c=1;c<seamColumns;c++)loop.push(read(originalCount+(panel*(bodyRows+1)+row)*(seamColumns-1)+c-1))
    }
    body.push(Array.from({length:columns},(_,c)=>sample(loop,2*Math.PI*c/columns)))
  }
  // A strictly falling material coordinate keeps the longitudinal folds from
  // folding back through themselves, while retaining both authored endpoints.
  for(let c=0;c<columns;c++) {
    const top=body[0][c].p.y,bottom=body[bodyRows][c].p.y
    if(!(top>bottom+.005))throw new Error('Inverted petticoat material span')
    const fall=Array.from({length:bodyRows},(_,i)=>Math.max(.00035,body[i][c].p.y-body[i+1][c].p.y))
    const total=fall.reduce((a,b)=>a+b,0);let accumulated=0
    for(let row=1;row<=bodyRows;row++){accumulated+=fall[row-1];body[row][c].p.y=top-(top-bottom)*accumulated/total}
  }
  // The inner white flounce passes behind the actual navy return before
  // it emerges below the hem. Fit the underlay and folded transition in
  // one fixed material chart shared by all views.
  let maximumInset=0,freeEdgeInset=0;
  if(navy){
    const support=radialClothDepth(navy),inset=body.map(row=>row.map(({p})=>{
      const r=Math.hypot(p.x,p.z),angle=Math.atan2(p.x,p.z);let covered=Infinity;
      // Include the small material cell around a vertex, since its
      // incident triangles can cross the narrow returned navy edge.
      for(const turn of[-.006,0,.006])for(const rise of[-.012,0,.012]){
        const depth=support(Math.sin(angle+turn),p.y+rise,Math.cos(angle+turn));
        if(depth!==undefined)covered=Math.min(covered,depth);
      }
      return Number.isFinite(covered)?Math.max(0,r-covered+.004):0;
    }));
    // Spread the required correction with a bounded material-space slope.
    // A per-vertex radial clamp would cut a ledge into the visible folds.
    for(let pass=0;pass<3;pass++){
      for(let c=0;c<columns;c++)for(const direction of[1,-1])for(let i=0;i<bodyRows;i++){
        const row=direction>0?i:bodyRows-i,next=row+direction;
        inset[next][c]=Math.max(inset[next][c],inset[row][c]-.35*body[row][c].p.distanceTo(body[next][c].p));
      }
      for(let row=0;row<=bodyRows;row++)for(const direction of[1,-1])for(let i=0;i<2*columns;i++){
        const c=((direction>0?i:2*columns-i-1)%columns+columns)%columns,next=(c+direction+columns)%columns;
        inset[row][next]=Math.max(inset[row][next],inset[row][c]-.35*body[row][c].p.distanceTo(body[row][next].p));
      }
    }
    for(let row=0;row<=bodyRows;row++)for(let c=0;c<columns;c++){
      const p=body[row][c].p,r=Math.hypot(p.x,p.z),d=inset[row][c];
      maximumInset=Math.max(maximumInset,d);if(row===bodyRows)freeEdgeInset=Math.max(freeEdgeInset,d);
      p.x*=1-d/r;p.z*=1-d/r;
    }
  }
  const wp=waist.attributes.position,wc=waist.attributes.color,waistLoop:ClothPoint[]=[]
  for(let c=0;c<panels*24;c++)waistLoop.push({p:new Vector3().fromBufferAttribute(wp,c),color:new Color().fromBufferAttribute(wc,c),hem:-2})
  const top=Array.from({length:columns},(_,c)=>sample(waistLoop,2*Math.PI*c/columns))
  const positions:number[]=[],colors:number[]=[],hem:number[]=[],indices:number[]=[],groups:number[]=[]
  for(let row=0;row<=totalRows;row++)for(let c=0;c<columns;c++) {
    let at:ClothPoint
    if(row<=foundationRows){const t=row/foundationRows,a=top[c],b=body[0][c];at={p:a.p.clone().lerp(b.p,t),color:a.color.clone().lerp(b.color,t),hem:-2+t}}
    else at=body[row-foundationRows][c]
    positions.push(at.p.x,at.p.y,at.p.z);colors.push(at.color.r,at.color.g,at.color.b);hem.push(at.hem)
  }
  for(let row=0;row<totalRows;row++)for(let c=0;c<columns;c++) {
    const next=(c+1)%columns,a=row*columns+c,b=(row+1)*columns+c,d=(row+1)*columns+next,e=row*columns+next
    indices.push(a,b,e,e,b,d);groups.push(row<foundationRows?0:1,row<foundationRows?0:1)
  }
  const front=new BufferGeometry();front.setAttribute('position',new Float32BufferAttribute(positions,3));front.setIndex(indices);front.computeVertexNormals()
  // This is one three-dimensional fabric sheet, rendered on both sides.
  // Do not extrude a second lining through the tightly bent skirt pleats.
  const solid=front,allIndices=indices,allGroups=groups
  solid.setAttribute('color',new Float32BufferAttribute(colors,3))
  solid.setAttribute('clothHem',new Float32BufferAttribute(hem,1))
  function part(group:number) {
    const map=new Map<number,number>(),vertices:number[]=[],pigment:number[]=[],normals:number[]=[],coordinate:number[]=[],triangles:number[]=[]
    for(let i=0;i<allIndices.length;i+=3)if(allGroups[i/3]===group)for(let k=0;k<3;k++) {
      const old=allIndices[i+k];let id=map.get(old)
      if(id===undefined){id=map.size;map.set(old,id);vertices.push(solid.attributes.position.getX(old),solid.attributes.position.getY(old),solid.attributes.position.getZ(old));pigment.push(solid.attributes.color.getX(old),solid.attributes.color.getY(old),solid.attributes.color.getZ(old));normals.push(solid.attributes.normal.getX(old),solid.attributes.normal.getY(old),solid.attributes.normal.getZ(old));coordinate.push(solid.attributes.clothHem.getX(old))}
      triangles.push(id)
    }
    const result=new BufferGeometry();result.setAttribute('position',new Float32BufferAttribute(vertices,3));result.setAttribute('normal',new Float32BufferAttribute(normals,3));result.setAttribute('color',new Float32BufferAttribute(pigment,3));result.setAttribute('clothHem',new Float32BufferAttribute(coordinate,1));result.setIndex(triangles)
    if(navy)result.userData.navyNesting={maximumInset,freeEdgeInset,actualTriangles:true,noCameraInput:true}
    result.userData.sewnRoot={front:Array.from({length:columns},(_,c)=>map.get(foundationRows*columns+c)),back:[],columns}
    result.userData.clothSurface={chart:'fixed-hip-polar',foundationRows,bodyRows,columns,wholeTriangles:indices.length/3,doubleSided:true,openBoundaries:'waist and free hem',imageTexture:false}
    return result
  }
  const foundation=part(0),geometry=part(1);front.dispose();raw.dispose()
  return{foundation,geometry}
}

function frontApronTie() {
  const profile = new Shape().moveTo(-.208,.132)
    .bezierCurveTo(-.204,.144,-.165,.147,-.108,.149)
    .bezierCurveTo(-.045,.152,.063,.153,.131,.148)
    .bezierCurveTo(.172,.146,.199,.141,.208,.135)
    .bezierCurveTo(.211,.126,.211,.112,.206,.105)
    .bezierCurveTo(.142,.106,.070,.104,.004,.104)
    .bezierCurveTo(-.071,.104,-.153,.105,-.206,.106)
    .bezierCurveTo(-.211,.111,-.211,.123,-.208,.132)
  profile.closePath()
  const blank = new ExtrudeGeometry(profile, {
    depth: .039, bevelEnabled: true, bevelSegments: 2, bevelSize: .0035, bevelThickness: .004, curveSegments: 16,
  })
  const geometry = refineProfile(blank, .018)
  blank.dispose()
  const points = geometry.attributes.position
  const rim = profile.getPoints(11)
  const colors: number[] = []
  const cloth = new Color(0xf6f0fa), shadow = new Color(0xb5abce), thread = new Color(0x716b98), pigment = new Color()
  for (let i = 0; i < points.count; i++) {
    const x = points.getX(i), y = points.getY(i)
    const across = Math.abs(x) / .211
    points.setZ(i, points.getZ(i) + .206 - .037 * across ** 2)
    let distance = Infinity
    for (let j = 1; j < rim.length; j++) {
      const a = rim[j - 1], b = rim[j], dx = b.x - a.x, dy = b.y - a.y
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)))
      distance = Math.min(distance, Math.hypot(x - a.x - t * dx, y - a.y - t * dy))
    }
    const lower = Math.exp(-(((y - .108) / .010) ** 2))
    const binding = .63 * Math.exp(-((distance / .0032) ** 2))
    pigment.copy(cloth).lerp(shadow, .07 + .20 * lower + .30 * across ** 5).lerp(thread, binding)
    colors.push(pigment.r, pigment.g, pigment.b)
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
  geometry.computeVertexNormals()
  return geometry
}

function apronWaistband(pointAt: (angle: number, depth: number) => Vector3) {
  const positions: number[] = [], indices: number[] = []
  const columns = 72
  for (let i = 0; i <= columns; i++) {
    const angle = Math.PI * (.45 + 1.10 * i / columns)
    for (const depth of [.028,.142]) {
      const point = pointAt(angle, depth)
      positions.push(point.x + .013 * Math.sin(angle), point.y, point.z + .014 * Math.cos(angle))
    }
    if (i < columns) indices.push(2*i,2*i+1,2*i+2,2*i+1,2*i+3,2*i+2)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

// These gathers are sewn into the apron, in the same coordinates as its
// curved panel. The fragment fields keep their tapered edges crisp without
// adding a picture or multiplying the number of deformation vertices.
const APRON_GATHERS = [
  [-.167, -.064, .34, .023, .53], [-.071, -.055, .54, .019, .93],
  [-.005, .007, .24, .028, .63], [.066, .035, .61, .020, .96],
  [.163, .064, .34, .024, .50],
] as const

function apronGatherField() {
  const strokes = APRON_GATHERS.filter((_,i) => i!==2).map(([root,sweep,length,width,strength]) => `{
    float fall = clamp(p.y/${length.toFixed(5)},0.,1.);
    float center = ${root.toFixed(5)}+${sweep.toFixed(5)}*sin(2.67035376*fall);
    float halfWidth = ${width.toFixed(5)}*(1.-.43*fall)*sqrt(max(0.,1.-fall*fall));
    float distance = abs(p.x-center)-halfWidth;
    float edge = max(.0012,fwidth(p.x)*.72);
    float coverage = 1.-smoothstep(-edge,edge,distance);
    float crossFold = clamp((p.x-center)/max(.0001,halfWidth),-1.,1.);
    shade = max(shade,${strength.toFixed(5)}*.82*coverage*pow(1.-fall,.48)*(.67+.33*abs(crossFold)));
  }`).join('\n')
  return `float apronGathers(vec2 p) {
    float shade = 0.;
    ${strokes}
    float fall = clamp(p.y/.24,0.,1.);
    float halfWidth = .057*sqrt(max(0.,1.-fall*fall));
    float distance = abs(p.x+.005)-halfWidth;
    float edge = max(.0015,fwidth(p.x)*.65);
    float centerFold = (1.-smoothstep(-edge,edge,distance))*pow(1.-fall,.35);
    float rim = abs(p.x+.005)/max(.0001,halfWidth);
    return max(shade,.66*centerFold*(.45+.55*clamp(rim*rim,0.,1.)));
  }`
}

function apronPanel(supportDepth?: (x: number, y: number) => number | undefined) {
  const panelRows = 32, frillRows = 20, rollRows = 16, columns = 360
  const rows = panelRows + frillRows + rollRows
  const positions: number[] = [], indices: number[] = [], colors: number[] = [], coordinates: number[] = []
  const seam: Vector3[] = [], edge: Vector3[] = [], edgeTurns: number[] = []
  const cloth = new Color(0xf0e8f3), ruffleCloth = new Color(0xf6eff9)
  const shadow = new Color(0xa8a3cf)
  const lining = new Color(0x514b70)
  const color = new Color()
  for (let row = 0; row <= rows; row++) {
    const t = Math.min(1, row / panelRows)
    const frill = Math.max(0, Math.min(1, (row - panelRows) / frillRows))
    const roll = Math.max(0, (row - panelRows - frillRows) / rollRows)
    const tuck = (1 - Math.cos(roll * Math.PI)) / 2
    for (let column = 0; column <= columns; column++) {
      const u = column / columns
      const side = 2 * u - 1
      const phase = (u - .5) * Math.PI * 12 + .16 * Math.sin(u * Math.PI * 2) + .25 * side * frill
      const fold = Math.cos(phase)
      const pleatAngle = Math.atan2(Math.sin(phase),fold)/Math.PI
      const face = Math.max(0,Math.min(1,(.88-Math.abs(pleatAngle))/.36))
      const inset = Math.max(0,Math.min(1,(Math.abs(pleatAngle)-.68)/.32))
      const broadFold = .85*face*face*(3-2*face)-.55*inset*inset*(3-2*inset)
      const lobe = .72*(fold+.11*Math.cos(2*phase))+.28*broadFold
      const angle = side * (.62 + .36 * Math.sin(Math.PI * .58 * t)) + .012 * frill * Math.sin(phase)
      const center = Math.cos(angle)
      const fullness = .027 * Math.sin(Math.PI * t)
      const rootTuck = Math.exp(-((t / .085) ** 2))
      const r = .284 + t * .134 + fullness + .004 * fold * t
      const edgeAngle = Math.abs(side)
      // Fold fields must remain periodic across atan2's -PI/PI seam.
      // A discontinuous return makes a thin vertical wall between lobes.
      const lipTurn = Math.atan2(Math.sin(phase-.82*Math.PI),Math.cos(phase-.82*Math.PI))/Math.PI
      const returnTurn = Math.atan2(Math.sin(phase+.80*Math.PI),Math.cos(phase+.80*Math.PI))/Math.PI
      const lip = Math.exp(-((lipTurn/.20)**2))*frill**2
      const returnFold = Math.exp(-((returnTurn/.26)**2))*frill**2
      const cornerCurl = returnFold + .45 * lip
      // Keep adjacent sewn columns ordered across the gathered face. The
      // depth folds and separate rolled hem supply its returning surfaces.
      const x = Math.sin(angle) * r + side * .068 * frill + .010 * Math.sin(phase) * frill ** 2
      let gathering = 0
      for (const [root, sweep, length, width, strength] of APRON_GATHERS) {
        const fall = Math.min(1, t / length)
        const center = root + sweep * Math.sin(Math.PI * .85 * fall)
        const cross = (x - center) / (width * (1 - .43 * fall))
        gathering += strength * (1 - fall) ** .59 * Math.exp(-(cross * cross))
      }
      // The seam rises toward both hips and the frill turns around that
      // edge, so its side lobes sit above the lower center scallops.
      const seamRise = .016 * t * t + .037 * t ** 3 * edgeAngle ** 1.6 + .035 * t ** 3 * edgeAngle ** 2
        - .015 * t ** 3 * edgeAngle ** 7
      const hipDrape = .022 * Math.exp(-(((edgeAngle - .66) / .22) ** 2))
      const innerDrape = .022 * Math.exp(-(((edgeAngle - .34) / .18) ** 2))
      const drop = .079 - .031 * edgeAngle ** 2 + hipDrape + innerDrape + .013 * edgeAngle ** 6
      const y = .223 - .270 * t + .171 * (1 - center) + seamRise + .032 * rootTuck - drop * frill * (.53 + .47 * frill)
        - .012 * lobe * frill ** 1.7 + .011 * Math.sin(phase) * frill ** 2
      const sleeveClearance = (.076 * t ** 4 * (1-.30*frill)+.005*frill) * edgeAngle ** 8
      const flankTuck = (.035 + .027 * frill) * t ** 3
        * Math.exp(-(((edgeAngle - .735 - .082 * frill) / .141) ** 4) - (((y - .055) / .055) ** 4))
      let z = center * r * .78 + .104 - .124 * (1 - t) ** 1.4
        + .017 * Math.sin(Math.PI * t * .78) + .020 * Math.sin(Math.PI * frill * .92)
        + .013 * lobe * frill ** 1.5 * (1 - .46 * frill)
        + .038 * Math.sin(phase) * frill ** 1.5
        - .149 * edgeAngle ** 2.8 * t ** 1.5 - .036 * frill * edgeAngle ** 2
        - .018 * gathering - .029 * rootTuck + sleeveClearance - flankTuck
      // Keep the frill outside the actual navy pleats rather than using
      // a fixed forward offset that leaves its side ends floating.
      const support = supportDepth?.(x,y)
      if (support !== undefined && frill > 0) {
        const contact = support+.006-z
        const weight = MathUtils.smoothstep(edgeAngle,.63,.82)*MathUtils.smoothstep(frill,0,.25)
        z += weight*.5*(contact+Math.hypot(contact,.003))
      }
      // Sew the panel outside the actual waist triangles. The lower
      // gathers and free frill retain their independently authored depth.
      if(t<.22 && frill===0){
        // Carry the waist support above its open edge so a panel cell
        // spanning that edge stays outside the seam between its vertices.
        const below=supportDepth?.(x,y-.026),waistSupport=Math.max(support??-Infinity,below??-Infinity);
        if(Number.isFinite(waistSupport)){
          const clearance=waistSupport+.005-z;
          z+=.5*(clearance+Math.hypot(clearance,.0005));
        }
      }
      positions.push(x, y, z)
      coordinates.push(x, t, frill+.05*roll, phase)
      const crease = Math.max(0, -fold)
      const frillShade = .066 + .21 * tuck + .30 * returnFold
      color.copy(cloth).lerp(ruffleCloth, frill)
        .lerp(shadow, row > panelRows ? frillShade : .10 * crease * t ** 4)
      color.lerp(lining, .88 * (.2+.8*Math.min(1,cornerCurl)) * Math.sin(Math.PI * roll) ** .65)
      colors.push(color.r, color.g, color.b)
      if (row === panelRows) seam.push(new Vector3(x, y, z))
      if (row === panelRows + frillRows) {
        edge.push(new Vector3(x,y,z))
        edgeTurns.push(Math.min(1,cornerCurl))
      }
      if (row < rows && column < columns) {
        const a = row * (columns + 1) + column, c = a + columns + 1
        indices.push(a, c, a + 1, a + 1, c, c + 1)
      }
    }
  }
  // Sweep the hem around its own edge, including where a gathered fold
  // points toward the camera. A fixed Y/Z curl lies along those folds
  // instead of around them, leaving flat hanging petals in the front view.
  const edgeRow = panelRows+frillRows
  const originalEdge = edge.map(point=>point.clone())
  const curvatureRadii = originalEdge.map((point,column) => {
    if (column===0 || column===columns) return Infinity
    const incoming = point.clone().sub(originalEdge[column-1])
    const outgoing = originalEdge[column+1].clone().sub(point)
    const span = .5*(incoming.length()+outgoing.length())
    const turn = Math.acos(MathUtils.clamp(incoming.normalize().dot(outgoing.normalize()),-1,1))
    return span/Math.max(.000001,turn)
  })
  // Keep the swept tube inside each bend's radius. Smoothly taper its
  // sewn ends and bound radius changes along the cloth to avoid fins.
  const hemRadii = originalEdge.map((_,column) => {
    const u = column/columns
    const sewn = .04+.96*MathUtils.smoothstep(u,0,.04)*(1-MathUtils.smoothstep(u,.96,1))
    const bend = Math.min(curvatureRadii[Math.max(0,column-1)],curvatureRadii[column],
      curvatureRadii[Math.min(columns,column+1)])
    return Math.min((.0045+.0055*edgeTurns[column])*sewn,.40*bend)
  })
  for (let column=1;column<=columns;column++) hemRadii[column] = Math.min(hemRadii[column],
    hemRadii[column-1]+.35*originalEdge[column].distanceTo(originalEdge[column-1]))
  for (let column=columns-1;column>=0;column--) hemRadii[column] = Math.min(hemRadii[column],
    hemRadii[column+1]+.35*originalEdge[column].distanceTo(originalEdge[column+1]))
  for (let column=0;column<=columns;column++) {
    const start = originalEdge[column]
    const tangent = originalEdge[Math.min(columns,column+1)].clone()
      .sub(originalEdge[Math.max(0,column-1)]).normalize()
    const prior = (edgeRow-1)*(columns+1)+column
    const fall = start.clone().sub(new Vector3().fromArray(positions,3*prior))
    fall.addScaledVector(tangent,-fall.dot(tangent)).normalize()
    const normal = fall.clone().cross(tangent).normalize()
    const radius = hemRadii[column]
    // Keep the lowest silhouette at its fitted height while giving the
    // leading edge room to roll down and return behind the fabric.
    const rise = radius*(normal.y+Math.hypot(fall.y,normal.y))
    for (let row=panelRows+1;row<=edgeRow;row++) {
      const blend = MathUtils.smoothstep((row-panelRows)/frillRows,.65,1)
      positions[3*(row*(columns+1)+column)+1] += rise*blend
    }
    edge[column].y += rise
    for (let row=1;row<=rollRows;row++) {
      const angle = 1.65*Math.PI*row/rollRows
      const point = edge[column].clone().addScaledVector(fall,radius*Math.sin(angle))
        .addScaledVector(normal,-radius*(1-Math.cos(angle)))
      const index = 3*((edgeRow+row)*(columns+1)+column)
      positions[index]=point.x; positions[index+1]=point.y; positions[index+2]=point.z
    }
  }
  if (supportDepth) {
    // A rolled return can reach behind an otherwise clear leading edge.
    // Move the complete cross-section together so the hem keeps its curl.
    const clearance = originalEdge.map((_,column) => {
      let shift = 0
      for (let row=edgeRow;row<=rows;row++) {
        const index=3*(row*(columns+1)+column)
        const support=supportDepth(positions[index],positions[index+1])
        if (support!==undefined) shift=Math.max(shift,support+.004-positions[index+2])
      }
      return shift
    })
    // Spread the required displacement into its neighbors with a bounded
    // slope; independently clamping return vertices would flatten the roll.
    for (let column=1;column<=columns;column++) clearance[column]=Math.max(clearance[column],
      clearance[column-1]-.20*originalEdge[column].distanceTo(originalEdge[column-1]))
    for (let column=columns-1;column>=0;column--) clearance[column]=Math.max(clearance[column],
      clearance[column+1]-.20*originalEdge[column].distanceTo(originalEdge[column+1]))
    for (let column=0;column<=columns;column++) {
      for (let row=panelRows+1;row<=rows;row++) {
        const weight=MathUtils.smoothstep((row-panelRows)/frillRows,.55,1)
        positions[3*(row*(columns+1)+column)+2]+=clearance[column]*weight
      }
      edge[column].z+=clearance[column]
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
  geometry.setAttribute('apronCoordinate', new Float32BufferAttribute(coordinates, 4))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return { geometry, seam, edge }
}

function earGeometry(side: number) {
  const profile = new Shape().moveTo(side * -.018, .183)
  const curves: readonly Curve[] = [
    [.068,.178,.107,.118,.173,.073],[.240,.020,.295,-.013,.353,-.032],
    [.371,-.037,.390,-.044,.376,-.063],[.364,-.091,.326,-.126,.284,-.128],
    [.277,-.157,.246,-.209,.211,-.202],[.194,-.201,.184,-.194,.176,-.191],
    [.169,-.215,.132,-.245,.089,-.235],[.062,-.230,.046,-.204,.052,-.173],
    [.010,-.174,-.019,-.115,-.023,-.064],[-.035,.006,-.029,.117,-.018,.183],
  ]
  for (const [a,b,c,d,e,f] of curves) profile.bezierCurveTo(side*a,b,side*c,d,side*e,f)
  profile.closePath()
  const blank = new ExtrudeGeometry(profile, {
    depth: .034, bevelEnabled: true, bevelSegments: 3, bevelSize: .0028, bevelThickness: .0025, curveSegments: 16,
  })
  const geometry = refineProfile(blank, .015)
  blank.dispose()
  const boundary = profile.getPoints(12)
  const positions = geometry.attributes.position
  const coordinates: number[] = []
  const forward = Math.cos(EAR_TURN), sideways = Math.sin(EAR_TURN)
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i), face = (positions.getZ(i) - .017) / .0195
    let edge = Infinity
    for (let j = 1; j < boundary.length; j++) {
      const a = boundary[j - 1], b = boundary[j], dx = b.x - a.x, dy = b.y - a.y
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)))
      edge = Math.min(edge, Math.hypot(x - a.x - dx * t, y - a.y - dy * t))
    }
    const across = x * side
    const u = Math.max(0, Math.min(1, (across + .02) / .401))
    const cup = Math.sin(Math.PI * u)
    const sweep = .021 * u ** 3 * Math.tanh((y + .066) / .040)
    const innerLobe = .038 * Math.exp(-(((across - .073) / .081) ** 2))
      * Math.max(0, Math.min(1, (-y - .093) / .105)) ** 2
    const bend = .032 - .021 * u + .036 * cup * (.52 + .48 * Math.exp(-(((y + .045) / .105) ** 2))) + sweep + innerLobe
    const petal = .007 * Math.cos((across - .095) * 54) * Math.max(0, Math.min(1, (-y - .075) / .11)) * cup
    const thickness = .0038 + .021 * (1 - Math.exp(-edge / .032))
    const z = bend + petal + face * thickness
    const depth = -.112 - sideways * EAR_SPAN * across + forward * z
    // The upper root curves in under the bow's hanging cloth. Move
    // along the side of the head so the profile of the fin stays intact.
    const tuck = .128 * Math.exp(-(((depth + .263) / .111) ** 2) - (((y - .038) / .148) ** 2))
    // The white membrane sweeps back from the cheek. Keep the upper root
    // and blue tip where they meet the bow and preserve the frontal span.
    const down = Math.max(0, Math.min(1, (-y - .019) / .087))
    const out = Math.max(0, Math.min(1, (across - .156) / .203))
    const membrane = down * down * (3 - 2 * down) * (1 - out * out * (3 - 2 * out))
    const lower = Math.max(0, Math.min(1, (-y - .181) / .061))
    const rimTurn = lower * lower * (3 - 2 * lower) * Math.exp(-(((across - .091) / .069) ** 4))
    const sweepBack = membrane * (.098 * (.54 + .46 * Math.exp(-(((y + .140) / .056) ** 2)))
      + .009 * Math.exp(-(((y + .224) / .026) ** 2))) + .018 * rimTurn
    const membraneLift = .043 * Math.exp(-(((depth - sweepBack + .280) / .132) ** 4) - (((y + .145) / .110) ** 4))
    const ribLift = .024 * Math.exp(-(((depth + .318) / .064) ** 2) - (((y - .014) / .044) ** 2))
    const rollIn = .048 * Math.exp(-(((y + .186) / .045) ** 4) - (((across - .193) / .093) ** 4))
      + .034 * Math.exp(-(((y + .173) / .060) ** 4) - (((across - .062) / .061) ** 4)) + .046 * rimTurn
    const relief = membraneLift + ribLift - tuck - rollIn
    positions.setX(i, x + side * (sideways * sweepBack + forward * relief) / EAR_SPAN)
    positions.setZ(i, z + sideways * relief - forward * sweepBack)
    coordinates.push(across, y, edge)
  }
  geometry.setAttribute('earCoordinate', new Float32BufferAttribute(coordinates, 3))
  geometry.computeVertexNormals()
  return geometry
}

function flukeGeometry(stemShift: Vector3) {
  const profile = new Shape().moveTo(-.048, -.086)
  const curves: readonly Curve[] = [
    [-.061,.019,-.111,.069,-.208,.121],[-.335,.186,-.427,.250,-.410,.378],
    [-.399,.470,-.345,.537,-.281,.550],[-.256,.555,-.252,.518,-.225,.501],
    [-.174,.458,-.046,.416,-.004,.349],[.032,.409,.164,.473,.232,.510],
    [.257,.527,.258,.556,.287,.552],[.341,.545,.405,.467,.416,.385],
    [.433,.313,.409,.231,.333,.177],[.260,.125,.163,.100,.123,.045],
    [.094,.007,.063,-.049,.048,-.086],
    [.019,-.100,-.022,-.100,-.048,-.086],
  ]
  for (const curve of curves) profile.bezierCurveTo(...curve)
  profile.closePath()
  const blank = new ExtrudeGeometry(profile, {
    depth: .036, bevelEnabled: true, bevelSegments: 3, bevelSize: .0028, bevelThickness: .003, curveSegments: 18,
  })
  const geometry = refineProfile(blank, .024)
  blank.dispose()
  const boundary = profile.getPoints(12)
  const points = geometry.attributes.position
  const coordinates: number[] = []
  for (let i = 0; i < points.count; i++) {
    const x = points.getX(i), y = points.getY(i), depth = points.getZ(i)
    let edge = Infinity
    for (let j = 1; j < boundary.length; j++) {
      const a = boundary[j - 1], b = boundary[j], dx = b.x - a.x, dy = b.y - a.y
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)))
      edge = Math.min(edge, Math.hypot(x - a.x - dx * t, y - a.y - dy * t))
    }
    // The lobes bend in depth above the stem. The two surfaces meet at a
    // narrow rim, with more thickness where each blade carries the curve.
    const rise = Math.max(0, Math.min(1, (y + .023) / .50))
    const lift = rise * rise * (3 - 2 * rise)
    const halfWidth = .42
    const width = x / halfWidth
    const crest = Math.max(0, Math.min(1, (y - .386) / .163))
    const blade = Math.max(0, Math.min(1, (y - .19) / .205))
    const notch = Math.max(0, Math.min(1, (y - .393) / .091))
    const forkLift = notch * notch * (3 - 2 * notch)
    // The broad part of each lobe turns in depth while the fork stays open.
    const curl = lift * (.102 + .147 * blade * blade * (3 - 2 * blade) - .145 * crest * crest * (3 - 2 * crest))
    const innerCurl = .67 * curl * (1 - .67 * forkLift), outerCurl = (1.78 - .42 * forkLift) * curl
    const turn = Math.PI * width
    const spread = -.027 * lift
    const rootWidth = 1 + .13 * (1 - lift) ** 5
    const span = x * rootWidth + spread * width * (1 - width ** 2)
    const peak = crest * crest * (3 - 2 * crest)
    const roll = .118 * lift * blade * blade * (3 - 2 * blade) * (1 - .76 * peak)
    const lobeTurn = roll * Math.sin(turn)
    const bend = innerCurl * Math.sin(turn) + outerCurl * width ** 3 * (1 - width ** 2)
      + lift * (.024 * width ** 3 - .031)
    // Bow the two lobes in opposite directions so their faces stay
    // visible as the membrane turns from the side toward the back.
    const sideSpan = .768 + .098 * peak
    const depthRoll = .669 * (1 - .87 * forkLift)
    const lowerSweep = .024 * Math.exp(-(((y - .192) / .122) ** 4)) * Math.min(1, rise * 3)
    const across = .675 * span + .743 * lobeTurn + .011 * lift
    const back = -sideSpan * span + bend + depthRoll * lobeTurn - .015 * lift - lowerSweep

    // Follow the cross section with the shell thickness. A fixed offset
    // would pass through the surface where the two lobes turn over.
    const spanSlope = rootWidth + spread * (1 - 3 * width ** 2) / halfWidth
    const turnSlope = roll * Math.PI * Math.cos(turn) / halfWidth
    const dx = .675 * spanSlope + .743 * turnSlope
    const bendSlope = (innerCurl * Math.PI * Math.cos(turn)
      + (outerCurl * (3 - 5 * width ** 2) + .072 * lift) * width ** 2) / halfWidth
    const dz = -sideSpan * spanSlope + bendSlope + depthRoll * turnSlope
    const tangent = Math.hypot(dx, dz)
    const spanTurn = -6 * spread * width / halfWidth ** 2
    const bendTurn = (-innerCurl * Math.PI ** 2 * Math.sin(turn)
      + (outerCurl * (6 - 20 * width ** 2) + .144 * lift) * width) / halfWidth ** 2
    const rollTurn = -roll * Math.PI ** 2 * Math.sin(turn) / halfWidth ** 2
    const depthTurn = -sideSpan * spanTurn + bendTurn + depthRoll * rollTurn
    const acrossTurn = .675 * spanTurn + .743 * rollTurn
    const curvature = Math.abs(dx * depthTurn - dz * acrossTurn) / tangent ** 3
    const section = .004 + (.054 + .041 * (1 - lift) ** 3) * (1 - Math.exp(-edge / .040))
    const thickness = section / Math.hypot(1, 2 * section * curvature)
    const face = (depth - .018) / .042 * thickness
    // Follow the new stem through the throat while preserving the lobe tips.
    const fan = MathUtils.smoothstep(y, -.030, .246)
    points.setXYZ(i, across - dz * face / tangent - stemShift.x * fan,
      .91 * y, back + dx * face / tangent - stemShift.z * fan)
    coordinates.push(x, y, edge)
  }
  geometry.setAttribute('finCoordinate', new Float32BufferAttribute(coordinates, 3))
  geometry.computeVertexNormals()
  return geometry
}

function tailGeometry(point: (t: number) => Vector3, outerCurve: CatmullRomCurve3) {
  const rings = 52, sides = 40
  const { normals, binormals } = outerCurve.computeFrenetFrames(rings, false)
  const positions: number[] = [], joints: number[] = [], weights: number[] = [], indices: number[] = []
  const tuckedPositions: number[] = []
  const coordinates: number[] = []
  for (let i = 0; i <= rings; i++) {
    const t = i / rings
    const center = point(t)
    let normal = normals[i], binormal = binormals[i]
    if (t < .32) {
      const tangent = point(Math.min(1,t+.00001)).sub(point(Math.max(0,t-.00001))).normalize()
      normal = normal.clone().addScaledVector(tangent,-normal.dot(tangent)).normalize()
      binormal = tangent.clone().cross(normal).normalize()
    }
    const rootBlend=MathUtils.smoothstep(t,.04,.32)
    // Keep the buried attachment under the sewn bow; broaden the emerging root below it.
    const emergingRoot = .075 * MathUtils.smoothstep(t,.06,.13)
    const attachedRoot = .015 * (1-MathUtils.smoothstep(t,0,.08))
    const rootWidth=.040+.156*rootBlend+(.035+attachedRoot+emergingRoot)*(1-rootBlend)
    // A fuller pelvic shoulder emerges below the back bow, then joins the
    // established tail body. Keep the buried attachment and outer sweep fixed.
    const rootShoulder = MathUtils.smoothstep(t,.02,.065) * (1-MathUtils.smoothstep(t,.10,.16))
    const radius = rootWidth * (1 - t) + .066 * t + .041 * Math.sin(Math.PI * t) ** 2 + .035 * rootShoulder
    const midbody = Math.exp(-(((t - .45) / .24) ** 4))
    const hairSide = Math.exp(-(((t - .33) / .22) ** 4))
    const step = Math.min(2, Math.floor(t * 3))
    const blend = t * 3 - step
    for (let j = 0; j < sides; j++) {
      const angle = j * Math.PI * 2 / sides
      const p = center.clone().addScaledVector(normal, radius * Math.cos(angle))
        .addScaledVector(binormal, radius * Math.sin(angle) * .73)
      p.y -= (p.y - center.y) * .13 * midbody
      p.z -= (p.z - center.z) * .24 * midbody
      // Keep the inner surface under the locks. The rear surface holds
      // the drawn outside arc as the tail comes out from behind the waist.
      const inside = Math.max(0, p.z - center.z)
      p.z -= inside * MathUtils.smoothstep(inside, 0, .045) * .44 * hairSide
      // Broaden the emerging waist attachment across the back; keep belly clearance.
      // Broaden the pelvic section laterally and toward the back without
      // lowering its belly into the upper petticoat.
      // Keep extra root volume clear of the bending inner return.
      const rootFullness = MathUtils.smoothstep(t,.025,.065) * (1-MathUtils.smoothstep(t,.09,.145))
      const sideFullness = Math.sin(angle) ** 4
      p.x = center.x + (p.x-center.x) * (1 + (.35 + .40 * sideFullness) * rootFullness + 0.90 * MathUtils.smoothstep(t,.025,.065) * (1-MathUtils.smoothstep(t,.10,.18)))
      p.z -= 0.035 * rootShoulder + (.010 + .008 * sideFullness) * rootFullness
      p.y -= .035 * rootShoulder
      // Round the concave return above the belly. Its inner surface must
      // retain space when adjacent tail joints bend toward one another.
      const returnSeat = MathUtils.smoothstep(t,.135,.165) * (1-MathUtils.smoothstep(t,.215,.25))
        * MathUtils.smoothstep(-Math.sin(angle),.4,.9) * MathUtils.smoothstep(-Math.cos(angle),.1,.5)
      p.lerp(center, .10 * returnSeat)
      positions.push(p.x, p.y, p.z)
      // As the tail rolls downward for a swim stroke, the inner belly
      // flattens above the rear petticoat instead of crossing its hem.
      const clothSide = MathUtils.smoothstep((p.z - center.z) / radius, -.44, .08)
      const tuck = Math.max(0, center.y - p.y) * .46 * hairSide * clothSide
      tuckedPositions.push(p.x, p.y + tuck, p.z)
      const lateral = p.clone().sub(center).normalize()
      coordinates.push(t, lateral.x, lateral.y, lateral.z)
      joints.push(step, step + 1, 0, 0)
      weights.push(1 - blend, blend, 0, 0)
      if (i < rings) {
        const a = i * sides + j
        const b = i * sides + (j + 1) % sides
        indices.push(a, b, a + sides, b, b + sides, a + sides)
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('tailCoordinate', new Float32BufferAttribute(coordinates, 4))
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(joints, 4))
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  const tuck = new BufferGeometry()
  tuck.setIndex(geometry.index)
  tuck.setAttribute('position', new Float32BufferAttribute(tuckedPositions, 3))
  tuck.computeVertexNormals()
  geometry.morphAttributes.position = [tuck.attributes.position]
  geometry.morphAttributes.normal = [tuck.attributes.normal]
  tuck.dispose()
  return geometry
}

export type BluefishModel = ReturnType<typeof createBluefishModel>
