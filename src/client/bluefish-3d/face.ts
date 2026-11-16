import {
  AlwaysStencilFunc, BackSide, BufferGeometry, Float32BufferAttribute, Matrix4, Mesh, MeshBasicMaterial,
  NotEqualStencilFunc, Object3D, ReplaceStencilOp, ShapeUtils, type MeshPhongMaterial, Vector2, Vector3,
} from 'three'
import { profileFrontDepth } from './profile-geometry.ts'

// Turnaround landmarks in head coordinates. The frontal cheek width and
// the profile muzzle depth are fitted independently at the same heights.
const SECTIONS = [
  [-.2664, 0, 0, 0, .096],
  [-.2575, .066, .055, .015, .0968],
  [-.2500, .100, .120, .050, .099],
  [-.2395, .150, .132, .076, .106],
  [-.2295, .171, .147, .105, .106],
  [-.2140, .214, .173, .129, .098],
  [-.1985, .234, .197, .160, .086],
  [-.1840, .255, .220, .190, .070],
  [-.1690, .262, .227, .220, .060],
  [-.15456, .278, .249, .240, .050],
  [-.13776, .285, .267, .260, .040],
  [-.09856, .288, .288, .290, .030],
  [-.08000, .292, .293, .300, .027],
  [-.06496, .295, .288, .310, .025],
  [-.04816, .307, .267, .320, .022],
  [-.02576, .322, .248, .340, .020],
  [.00224, .340, .2612, .350, .020],
  [.08624, .372, .2656, .366, .010],
  [.14224, .376, .2700, .374, .000],
  [.25424, .370, .2408, .380, -.010],
  [.369, .320, .212, .308, -.019],
  [.455, .205, .133, .217, -.044],
  [.502, 0, 0, 0, -.058],
] as const
// One physical lateral aperture taper, shared by skin holes, sclera,
// eyelids and their procedural ink. No view angle enters this fit.
const LATERAL_APERTURE={start:208.4,full:211.4} as const
const [MIN_Y] = SECTIONS[0]
const [MAX_Y] = SECTIONS[SECTIONS.length - 1]!

function section(y: number) {
  const upperIndex = SECTIONS.findIndex(([upper], index) => index > 0 && upper >= y)
  const i = upperIndex < 0 ? SECTIONS.length - 2 : upperIndex - 1
  const lower = SECTIONS[i]!, upper = SECTIONS[i + 1]!
  const before = SECTIONS[Math.max(0, i - 1)]!, after = SECTIONS[Math.min(SECTIONS.length - 1, i + 2)]!
  const range = upper[0] - lower[0]
  const t = (y - lower[0]) / range
  const t2 = t * t, t3 = t2 * t
  const component = (k: 1 | 2 | 3 | 4) =>
    lower[k] * (2 * t3 - 3 * t2 + 1) + upper[k] * (-2 * t3 + 3 * t2) +
    (t3 - 2 * t2 + t) * range * (upper[k] - before[k]) / (upper[0] - before[0]) +
    (t3 - t2) * range * (after[k] - lower[k]) / (after[0] - lower[0])
  return { width: component(1), front: component(2), back: component(3), center: component(4) }
}

// Invert the monotone authored orbital span continuously. A short binary
// lookup quantized its depth and left small steps in the dense skin surface.
function upperLidCurveParameter(referenceX:number) {
  let t=Math.max(0,Math.min(1,(referenceX-203.2)/41.3))
  for(let i=0;i<6;i++){
    const u=1-t
    const x=203.2*u*u*u+3*214*u*u*t+3*236.2*u*t*t+244.5*t*t*t
    const slope=3*(214-203.2)*u*u+6*(236.2-214)*u*t+3*(244.5-236.2)*t*t
    t=Math.max(0,Math.min(1,t-(x-referenceX)/slope))
  }
  return t
}

// The orbital fold is a fixed part of the closed head. Its two depth
// curves are fitted together with the front and side eyelid contours.
function upperLidFoldDepth(x:number,y:number,depth:number) {
  const referenceX=227-(Math.abs(x)-.169)/(.96*.0056)
  if(referenceX<203.2||referenceX>244.5||y<-.010||y>.145)return depth
  const cubic=(a:number,b:number,c:number,d:number,t:number)=>
    a*(1-t)**3+3*b*(1-t)**2*t+3*c*(1-t)*t*t+d*t**3
  const smooth=(a:number,b:number,value:number)=>{
    const t=Math.max(0,Math.min(1,(value-a)/(b-a)));return t*t*(3-2*t)
  }
  const t=upperLidCurveParameter(referenceX)
  const physicalY=(referenceY:number)=>(175.4-referenceY)*.0056*.96+.00012
  const fit=smooth(211,219,referenceX)*(1-smooth(237,242,referenceX))
  const peakDelta=(referenceX-224.5)/2.8
  const peak=Math.exp(-peakDelta*peakDelta)*(x>0?1:.6)
  const topBase=physicalY(cubic(168.8,150.3683,147.1474,172.6,t))
    +.96*((x>0?.003:-.003)*fit+.0015*peak)
  const lashDepth=.012*Math.exp(-(((referenceX-207.6)/4.8)**2))
  const white=physicalY(cubic(176.5,152.75,154.,172.8,t))
    -.96*(lashDepth+.0048+(x>0?.0056:.0084)*fit)
  const top=white+(topBase-white)*(1-0.30*fit)
  const taper=1-smooth(237.5,241.5,referenceX)
  const inkTop=top,inkBottom=top+(white-top)*taper
  if(!(inkTop>inkBottom+.000001))return depth
  const support=smooth(inkBottom,inkTop,y)*(1-smooth(inkTop+.001,inkTop+.011,y))
    *smooth(203.2,207.,referenceX)*(1-smooth(239.,243.,referenceX))*smooth(.02,.10,taper)
  const fold=x>0?cubic(0,-.012,.012,0,t):cubic(0,-.0036,.012,-.006,t)
  return depth+support*fold
}

// A single fixed 3D upper-lid arc joins the current skin aperture.
// Its transverse depth is monotone, with a slower tangent at the crown.
function closedUpperLidArc(x:number,y:number,depth:number):number {
  const referenceX=227-(Math.abs(x)-.169)/(.96*.0056)
  if(referenceX<=203.2||referenceX>=244.5||y<=.005||y>=.16)return depth
  const cubic=(a:number,b:number,c:number,d:number,t:number)=>a*(1-t)**3+3*b*(1-t)**2*t+3*c*(1-t)*t*t+d*t**3
  const smooth=(a:number,b:number,v:number)=>{const t=Math.max(0,Math.min(1,(v-a)/(b-a)));return t*t*(3-2*t)}
  const t=upperLidCurveParameter(referenceX),fit=smooth(211,219,referenceX)*(1-smooth(237,242,referenceX))
  const peakDelta=(referenceX-224.5)/2.8,peak=Math.exp(-peakDelta*peakDelta)*(x>0?1:.6)
  const py=(v:number)=>.00012+.96*.0056*(175.4-v)
  const topBase=py(cubic(168.8,150.3683,147.1474,172.6,t))+.96*((x>0?.003:-.003)*fit+.0015*peak)
  const lashDelta=(referenceX-207.6)/4.8
  const white=py(cubic(176.5,152.75,154,172.8,t))-.96*(.012*Math.exp(-lashDelta*lashDelta)+.0048+(x>0?.0056:.0084)*fit)
  const top=white+(topBase-white)*(1-0.30*fit)
  const taper=1-smooth(237.5,241.5,referenceX)
  const inkTop=top,inkBottom=top+(white-top)*taper
  const support=smooth(inkBottom-.002,inkBottom+.002,y)*(1-smooth(inkTop+.001,inkTop+.010,y))
    *smooth(203.2,209.,referenceX)*(1-smooth(242.,244.5,referenceX))*smooth(.02,.10,taper)
  if(support<=0)return depth
  const s=section(inkTop),cosine=Math.sqrt(Math.max(0,1-(x/s.width)**2))
  const original=frontSurface(x,inkTop,cosine,s.front,s.center,true,true,false)
  const peakT=x>0?0.4983043578245551:0.4992695142707880,peakY=x>0?0.1067004519131235:0.1014615299028927
  const rise=Math.max(0,Math.min(1,(inkTop-peakY+.100)/.100))
  const u=t-peakT,radial=Math.sqrt(Math.max(0,1-rise*rise))
  const radius=.050+((u<0?.120:.055)-.050)*smooth(.025,.120,Math.abs(u))
  const target=.200+(u<0?-1:1)*radius*radial
  return depth+(target-original)*support
}

// Use one tangent-matched mouth-to-chin profile on the real closed skin.
// The author guide and all feature coordinates remain in their original frame.
function closedMuzzleProfile(x:number,y:number,depth:number):number {
  const low=-.214,high=-.1505
  if(y<=low||y>=high||Math.abs(x)>=.100)return depth
  const at=(value:number):number=>bluefishFaceDepth(0,value)!
  const step=.00001,span=high-low,t=(y-low)/span
  const lower=at(low),upper=at(high)
  const lowerSlope=(at(low+step)-at(low-step))/(2*step)
  const upperSlope=(at(high+step)-at(high-step))/(2*step)
  const target=lower*(2*t*t*t-3*t*t+1)+upper*(-2*t*t*t+3*t*t)
    +(t*t*t-2*t*t+t)*span*lowerSlope+(t*t*t-t*t)*span*upperSlope
  const edge=Math.max(0,Math.min(1,(Math.abs(x)-.070)/.030))
  const support=Math.exp(-((x/.055)**4))*(1-edge*edge*(3-2*edge))
  return depth+1*(target-at(y))*support
}

// Local closed lower-lip return: an uninked rim and a shallow inner crease.
// The rim is bounded by the original midline envelope at the same height.
function closedLipReturn(x:number,y:number,depth:number) {
  const across=Math.abs(x),radius=.0511
  if(across>=.060||y<=-.184||y>=-.150)return depth
  const smooth=(value:number)=>{const t=Math.max(0,Math.min(1,value));return t*t*(3-2*t)}
  const curve=Math.max(0,1-(x/radius)**2),lip=-.1505-.0181*curve**.70
  const delta=y-lip
  const local=smooth((y+.184)/.008)*smooth((-.150-y)/.008)
  const rimX=Math.exp(-(((across-.032)/.011)**4))*smooth((across-.014)/.010)
    *(1-smooth((across-.043)/.017))
  const rim=Math.exp(-(((delta+.0067)/.0045)**4))*rimX*local
  const envelope=closedMuzzleProfile(0,y,bluefishFaceDepth(0,y)!)
  // Keep the real lip shallow. The former narrow rise reached the
  // midline envelope and folded back over its own projected pigment.
  const rise=.0015*Math.tanh(Math.max(0,envelope-depth)/.0015)
  const outer=depth+rise*rim
  const crease=Math.exp(-((x/.023)**4)-((delta/.0045)**2))*local
  return outer-.00075*crease
}

// Fixed nasal onset and a broad sublabial return on the closed skin.
// Separate supports keep the nasal adjustment clear of the eye apertures,
// and distribute the chin return across the lower face without a local notch.
function closedNasalChinProfile(x:number,y:number,depth:number):number {
  if(Math.abs(x)>=.160||y<=-.240||y>=.030)return depth
  const smooth=(a:number,b:number,value:number)=>{const t=Math.max(0,Math.min(1,(value-a)/(b-a)));return t*t*(3-2*t)}
  const nasalAcross=Math.exp(-((x/.040)**4))*(1-smooth(.048,.060,Math.abs(x)))
  const chinAcross=Math.exp(-((x/.110)**4))*(1-smooth(.130,.160,Math.abs(x)))
  // Carry the existing nasal profile upward as one curve. A separate
  // added bump would leave the old tip behind and create a second crest.
  const nasalShift=.0035*smooth(-.105,-.085,y)*(1-smooth(-.050,-.038,y))
  const nasal=nasalShift ? bluefishFaceDepth(0,y-nasalShift)!-bluefishFaceDepth(0,y)! : 0
  const chin=.008*Math.exp(-(((y+.201)/.022)**4))
    *smooth(-.240,-.230,y)*(1-smooth(-.196,-.184,y))
  // Round the continuous nose-to-mouth return across the lower face.
  // The eye apertures, nasal crest and frontal feature coordinates stay fixed.
  const muzzleReturn=.0045*Math.exp(-(((y+.132)/.045)**4))
    *smooth(.092,.102,-y)*(1-smooth(.190,.205,-y))
  // The bridge fill stays inside the nasal midline, clear of both eye holes.
  const bridgeFill=.008*Math.exp(-(((y+.007)/.020)**4))
    *smooth(-.038,-.030,y)*(1-smooth(.012,.022,y))
  return depth+nasal*nasalAcross-chin*chinAcross+muzzleReturn*chinAcross+bridgeFill*nasalAcross
}

// One continuous transverse lower-face loft. The central profile and
// frontal widths remain fixed while the cheeks meet the muzzle as a
// rounded volume, independent of camera yaw and pitch.
function closedCheekVolume(x:number,y:number,depth:number):number {
  const across=Math.abs(x);
  if(across<1e-8||y>=-.100||y<=-.250)return depth;
  const smooth=(a:number,b:number,v:number)=>{const t=Math.max(0,Math.min(1,(v-a)/(b-a)));return t*t*t*(t*(t*6-15)+10)};
  // One continuous cheek loft replaces the stacked lateral mouth recesses.
  // Keep the fitted midline, outer head seam and orbital region in place.
  const support=smooth(.100,.142,-y)*(1-smooth(.205,.250,-y))
    *(1-smooth(.180,.260,across));
  if(support<=0)return depth;
  const s=closedLowerFaceSection(y),profile=frontSurface(0,y,1,s.front,s.center,true,false);
  const radius=Math.max(0,1-(x/s.width)**2);
  const target=s.center+(profile-s.center)*Math.sqrt(radius);
  return depth+(target-depth)*support;
}

function frontSurface(x: number, y: number, cosine: number, front: number, center: number, closedSurface = false, lipReturn = true, superiorArc = true) {
  // Confine the nose to the midline, keeping it from pulling the lower
  // eyelid forward in profile. The lip corners wrap into the cheeks.
  const bridgeRise = Math.max(0, center + front - .281)
  const noseFalloff = 1 - Math.exp(-((x / .095) ** 2))
  const eyeSocket = .025 * Math.exp(-(((Math.abs(x) - .168) / .080) ** 4) - (((y - .010) / .12) ** 4))
  const mouthWrap = .045 * (1 - Math.exp(-((x / .047) ** 2))) * Math.exp(-(((y + .156) / .032) ** 4))
  const cheek = Math.exp(-(((y + .111) / .095) ** 2))
  const seam = Math.min(1, cosine / .24)
  // Regularize the closed skin seam while retaining the authored fringe
  // guide. Rebuilding that guide would resculpt already fitted hair locks.
  const seamCurve = seam * seam * (3 - 2 * seam)
  const interior = closedSurface ? seamCurve * seamCurve : seamCurve
  const smooth=(a:number,b:number,value:number)=>{const t=Math.max(0,Math.min(1,(value-a)/(b-a)));return t*t*(3-2*t)}
  // A broader transverse cheek keeps the lower face round in oblique
  // views while retaining the front widths and the central profile.
  const lowerFace=closedSurface?Math.exp(-(((y+.145)/.045)**4))*smooth(.085,.100,-y)*(1-smooth(.205,.225,-y)):0
  // Round the real muzzle into both cheeks, below the eye apertures.
  // The central profile and frontal widths stay in their authored frame.
  const muzzleBlend=closedSurface ? (.024*(1-Math.exp(-((x/.047)**2)))-.005*Math.exp(-((x/.060)**4)))
    *Math.exp(-(((y+.156)/.032)**4))*smooth(.105,.125,-y)*(1-smooth(.210,.230,-y)) : 0
  // The mandibular volume rounds beneath the mouth rather than inflating
  // the muzzle. It is one fixed transverse head section at every view.
  const jawRound = closedSurface ? .48 * Math.exp(-(((y+.190)/.034)**4))
    * smooth(.145,.160,-y) * (1-smooth(.224,.245,-y))
    * (1-smooth(.180,.235,Math.abs(x))) : 0
  const surface = center + front * cosine ** (2.15 - .65 * cheek - .40 * lowerFace - jawRound)
    - (bridgeRise * noseFalloff + eyeSocket + mouthWrap) * interior + muzzleBlend*interior
  // Keep the eyelid field shallow across the iris, with a small recess at
  // the nose-side corner. The iris follows this same surface at every angle.
  const across = Math.abs(x)
  const socket = Math.exp(-(((across - .169) / .128) ** 4) - (((y - .003) / .112) ** 4))
  const eyeRound = .031 * Math.exp(-(((across - .161) / .086) ** 2))
  const cornea = .016 * Math.exp(-(((across - .154) / .057) ** 2) - (((y + .004) / .090) ** 4))
  const innerCorner = .0075 * Math.exp(-(((across - .106) / .039) ** 2))
  const eyeRecess = (.021 - .004 * Math.tanh(x / .075))
    * (.56 + .44 * Math.exp(-(((across - .157) / .069) ** 2)))
  // The iris sits on the shallower part of the eye. The recess at its
  // inner corner and the round outer edge still turn away in profile.
  const orbitOffset = across - .169
  const orbitSlope = .145 + .100 * Math.min(1, (orbitOffset / .069) ** 2)
  // A broad corneal rise keeps the iris open in profile. The two orbits
  // have separately fitted depths, without changing the frontal eye field.
  const profileSide = .5+.5*Math.tanh(x/.075)
  const firstOrbit = -.016+.022*Math.exp(-(((across-.160)/.055)**2))
  const secondOrbit = -.020+.026*Math.exp(-(((across-.160)/.060)**2))
  const profileRelief = firstOrbit+(secondOrbit-firstOrbit)*profileSide
  const orbitalDepth = .182 - orbitSlope * orbitOffset + .035 * y + eyeRound + cornea - innerCorner - eyeRecess + profileRelief
  const lowerLid = .009 * Math.exp(-(((across - .125) / .043) ** 4) - (((y + .065) / .047) ** 4))
  // One orbit has a deeper inner fold. Keep the corneal crest in
  // front of it so the iris still has depth when seen straight from the side.
  const sideRelief = .585 - .415 * Math.tanh(x / .063)
  const innerFold = .008 * Math.exp(-(((across - .109) / .044) ** 4) - (((y - .026) / .068) ** 4))
  const outerLid = .010 * Math.exp(-(((across - .227) / .049) ** 4) - (((y - .018) / .089) ** 4))
  const crest = .005 * Math.exp(-(((across - .153) / .031) ** 2) - (((y + .002) / .090) ** 4))
  const orbit = surface + (orbitalDepth - surface) * socket * interior * .91
    + lowerLid + sideRelief * (outerLid - innerFold + crest)
  // The outer white turns behind the cornea. Keep the measured iris
  // surface while allowing the white opening to remain wider in profile.
  const irisCenter = x < 0 ? .1594 : .16324
  const irisRadius = Math.hypot((across-irisCenter)/.06432,(y+.0018)/.08256)
  // Tilt the corneal surface toward the temple. A central depth hump
  // hid half of the painted iris and the inner white in a side view.
  const corneaEdge=Math.max(0,Math.min(1,(irisRadius-1.12)/.29))
  const corneaWeight=1-corneaEdge*corneaEdge*(3-2*corneaEdge)
  const corneaTilt=closedSurface ? .25 : (x>0 ? .43 : .386)
  const corneaPlane=.1924-corneaTilt*(across-irisCenter)+.035*y
    +.0025*Math.exp(-((irisRadius/.80)**4))
  const eyeSurface=orbit+(corneaPlane-orbit)*corneaWeight
  const irisEdge = Math.max(0,Math.min(1,(irisRadius-1.13)/.18))
  const whiteOnly = irisEdge*irisEdge*(3-2*irisEdge)
  const outerWhite = Math.max(0,Math.min(1,(across-.195)/.070))
  const scleraTurn = .017 * outerWhite*outerWhite*(3-2*outerWhite)
    * Math.exp(-(((y-.008)/.11)**4))
    * whiteOnly * (closedSurface ? interior : 1)
  const cornerLower = Math.max(0,Math.min(1,(y+.110)/.035))
  const cornerUpper = Math.max(0,Math.min(1,(.125-y)/.035))
  const innerWhite = (.062 - .062 * cornerLower*cornerLower*(3-2*cornerLower)
    *cornerUpper*cornerUpper*(3-2*cornerUpper)) * Math.exp(-(((across-.078)/.031)**4)
    - (((y+.008)/.115)**4)) * whiteOnly
    * (1-Math.max(0,Math.min(1,(across-.088)/.015))**2
      *(3-2*Math.max(0,Math.min(1,(across-.088)/.015))))
  // Keep the bridge, rounded nose and muzzle independent of the eye
  // sockets. These are depths of the closed head, not drawn profile cards.
  const midline = Math.exp(-((x / .045) ** 4))
  const noseOnset = Math.max(0, Math.min(1, (-y - .014) / .014))
  const nose = .0060 * noseOnset * noseOnset * (3 - 2 * noseOnset)
    * Math.exp(-(((y + .050) / .057) ** 4))
  const bridge = .0090 * Math.exp(-(((y - .016) / .036) ** 4))
  const muzzle = .0060 * Math.exp(-(((y + .156) / .035) ** 4))
  const lowerCheek = .0042 * Math.exp(-(((y + .195) / .022) ** 4))
  // Restore the rounded muzzle-to-chin depth below the whole moving iris.
  // Keep the lateral hair contact and the fitted lowest chin rings fixed.
  const cheekAcross = Math.max(0, Math.min(1, (Math.abs(x) - .055) / .055))
  const cheekStart = Math.max(0, Math.min(1, (-y - .125) / .018))
  const cheekEnd = Math.max(0, Math.min(1, (-y - .217) / .019))
  const cheekSupport = (.0056 + midline * lowerCheek)
    * (1 - cheekAcross * cheekAcross * (3 - 2 * cheekAcross))
    * cheekStart * cheekStart * (3 - 2 * cheekStart)
    * (1 - cheekEnd * cheekEnd * (3 - 2 * cheekEnd))
  const depth=bluefishTempleDepth(x,y,eyeSurface-scleraTurn+innerWhite
    +midline*(nose-bridge+muzzle-lowerCheek)+cheekSupport)
  const folded=closedSurface?upperLidFoldDepth(x,y,depth):depth
  const closedDepth=closedSurface?closedMuzzleProfile(x,y,superiorArc?closedUpperLidArc(x,y,folded):folded):depth
  const lipDepth=closedSurface&&lipReturn?closedLipReturn(x,y,closedDepth):closedDepth
  if(!closedSurface)return lipDepth
  const cheekDepth=closedCheekVolume(x,y,closedNasalChinProfile(x,y,closedDepth))
  // Add the physical lip crease/rim once, locally, on the same skin.
  return cheekDepth+(lipDepth-closedDepth)
}

// The temple turns back under the long fringe. Both the skin and the
// covering lock follow this cross-section so the side brow stays open.
export function bluefishTempleDepth(x: number, y: number, depth: number, clearance = 0) {
  const edge = .126 + .66 * (.285 - y) + (x < 0 ? .013 : 0)
  const t = Math.max(0, Math.min(1, (Math.abs(x) - edge + .047) / .052))
  const opening = Math.exp(-(((y - .191) / .092) ** 4))
  const temple = .141 + .55 * (y - .172) + clearance
  return depth - Math.max(0, depth - temple) * t * t * (3 - 2 * t) * opening
}

export function bluefishFaceDepth(x: number, y: number) {
  if (y <= MIN_Y || y >= MAX_Y) return undefined
  const { width, front, center } = section(y)
  if (Math.abs(x) >= width) return undefined
  const cosine = Math.sqrt(1 - (x / width) ** 2)
  return frontSurface(x, y, cosine, front, center)
}

// Hair clears the actual closed skin rather than the earlier author guide.
// Use the envelope of both lip morph endpoints, independent of the camera.
export function bluefishFaceClearanceDepth(x:number,y:number) {
  if(y<=MIN_Y||y>=MAX_Y)return undefined
  const {width}=closedLowerFaceSection(y)
  if(Math.abs(x)>=width)return undefined
  let depth=Math.max(socketSkinDepth(x,y,false),socketSkinDepth(x,y,true))
  // The convex cornea can stand ahead of the surrounding skin. Hair clears
  // its actual fixed front triangles, including the eyelid's small offset.
  for(const sample of socketScleraClearance.values()){const eye=sample(x,y);if(eye!==undefined)depth=Math.max(depth,eye+.0015)}
  return depth
}

// Round the full chin depth below the fitted jaw. Keep frontal widths,
// back skin and the exported hair guide exact while matching the upper tangent.
function closedLowerFaceSection(y:number) {
  const original=section(y),join=-.214
  if(y>=join)return original
  const top=section(join),before=section(join-.00001),after=section(join+.00001)
  const span=join-MIN_Y,t=Math.max(0,Math.min(1,(y-MIN_Y)/span)),radial=Math.sqrt(t)
  const first=1.50*top.front,upper=2*span*(after.front-before.front)/.00002
  const front=first*radial+(3*top.front-upper-2*first)*radial*radial
    +(upper-2*top.front+first)*radial*radial*radial
    // A broad lower-chin section with zero displacement and tangent at both
    // ends keeps the pole and upper-jaw join while rounding the return.
    +.009*16*t*t*(1-t)*(1-t)
  return{...original,front}
}

function headGeometry(lipReturn=true) {
  return socketHeadGeometry(lipReturn)
}

// Draw the features on the same triangles as the skin. This keeps the
// eye corners and mouth attached when the camera grazes the cheek.
const FEATURES = `
uniform vec2 gaze;
uniform float blink;
uniform float smile;
varying vec2 facePoint;
varying float visibleFace;
vec4 over(vec4 a, vec3 color, float opacity) {
  float alpha = a.a + (1. - a.a) * opacity;
  return vec4((a.rgb * a.a * (1. - opacity) + color * opacity) / max(alpha, .0001), alpha);
}
float coverage(float distance) {
  float width = max(.00065, fwidth(distance) * .8);
  return 1. - smoothstep(-width, width, distance);
}
float oval(vec2 at, vec2 center, vec2 radius) {
  return coverage((length((at - center) / radius) - 1.) * min(radius.x, radius.y));
}
float line(vec2 at, vec2 from, vec2 to, float width) {
  vec2 axis = to - from;
  return coverage(distance(at, from + axis * clamp(dot(at - from, axis) / dot(axis, axis), 0., 1.)) - width);
}

float pointedLash(vec2 at, vec2 root, vec2 tip, float width) {
  vec2 axis = tip - root;
  float t = clamp(dot(at - root, axis) / dot(axis, axis), 0., 1.);
  return coverage(distance(at, root + axis * t) - width * (1. - t));
}

float cubic(vec4 values, float t) {
  vec3 first = mix(values.xyz, values.yzw, t);
  vec2 second = mix(first.xy, first.yz, t);
  return mix(second.x, second.y, t);
}

float eyeHeight(float referenceY) {
  return (175.4 - referenceY) * .0056 - .003;
}

vec2 eyePoint(float x, float y) {
  return vec2((227. - x) * .0056, eyeHeight(y));
}

vec4 eye(vec4 under, vec2 p, float side) {
  p /= .96;
  vec2 q = vec2(side * p.x, p.y);
  // The outer corner, upper lash, white opening and inner corner are
  // separate curves, measured in the front-view drawing's coordinates.
  float referenceX = 227. - q.x / .0056;
  vec4 span = vec4(203.2, 214.0, 236.2, 244.5);
  float low = 0., high = 1.;
  for (int i = 0; i < 9; i++) {
    float t = (low + high) * .5;
    if (cubic(span, t) < referenceX) low = t;
    else high = t;
  }
  float t = (low + high) * .5;
  float closed = eyeHeight(cubic(vec4(172., 176., 176., 173.), t));
  // The outer start rises while the middle and inner upper arc stay fitted.
  float top = mix(eyeHeight(cubic(vec4(168.8, 150.3683, 147.1474, 172.6), t)), closed + .004, blink);
  float outerTaper = (referenceX - 207.6) / 4.8;
  float lashDepth = .012 * exp(-outerTaper * outerTaper);
  float whiteTop = mix(eyeHeight(cubic(vec4(176.5, 152.75, 154.0, 172.8), t)) - lashDepth, closed, blink) - .0048;
  // Fit the open middle upper lid while keeping its closed line intact.
  float upperArcFit = smoothstep(211.,219.,referenceX)
    * (1. - smoothstep(237.,242.,referenceX)) * (1. - blink);
  top += mix(-.003,.003,max(0.,side)) * upperArcFit;
  whiteTop -= mix(.0084,.0056,max(0.,side)) * upperArcFit;
  // One fixed upper-arc peak, shared with the actual orbital fold.
  float peakDelta=(referenceX-224.5)/2.8;
  float upperPeak=exp(-peakDelta*peakDelta)*mix(.6,1.,max(0.,side))*(1.-blink);
  top += .0015*upperPeak;
  // Close the lower outer wedge while the iris center stays fixed.
  float outerWhiteLift = .014 * (1. - smoothstep(211.,217.,referenceX));
  float lowerOuterFit = mix(.0014,.0056,max(0.,side)) * smoothstep(208.,214.,referenceX)
    * (1. - smoothstep(222.,228.,referenceX));
  float bottom = mix(eyeHeight(cubic(vec4(172.8, 198.5, 197.6, 172.8), t)) + outerWhiteLift + lowerOuterFit, closed - .004, blink);
  float innerLashStart=mix(237.5,237.5,blink);
  float innerLashEnd=mix(241.5,244.5,blink);
  float innerLashTaper=1.-smoothstep(innerLashStart,innerLashEnd,referenceX);
  // Taper the open lid upward into its continuous upper arc. The closed
  // line retains its previous two boundaries and original endpoint.
  // Keep lash roots on the closing upper edge rather than fading them
  // at the open-eye coordinates. These fields use fixed head coordinates.
  float openFit=smoothstep(211.,219.,referenceX)*(1.-smoothstep(237.,242.,referenceX));
  float openTop=eyeHeight(cubic(vec4(168.8,150.3683,147.1474,172.6),t))
    +mix(-.003,.003,max(0.,side))*openFit
    +.0015*exp(-peakDelta*peakDelta)*mix(.6,1.,max(0.,side));
  float untrimmedTop=top;
  top=mix(whiteTop,top,1.-0.30*upperArcFit);
  // Follow closure without translating the authored neutral lash tips
  // when only the thickness of the open upper-ink band is refitted.
  float lidShift=untrimmedTop-openTop;
  float originalInkTop=mix(whiteTop,top,innerLashTaper);
  // The eyeliner keeps its authored upper crest while the real scleral
  // opening retains the separately fitted lower ink boundary.
  float upperInkTop=top+(untrimmedTop-top)*mix(1.,.75,max(0.,side));
  // Fit the left inner return on the same fixed facial surface.
  float innerInkArc=smoothstep(228.,233.,referenceX)*(1.-smoothstep(237.,241.,referenceX));
  upperInkTop+=(1.-blink)*.0056*innerInkArc*(1.-max(0.,side));
  float inkTop=mix(upperInkTop,originalInkTop,blink);
  float inkBottom=mix(mix(top,whiteTop,innerLashTaper),whiteTop,blink);
  // Sclera, ink margin and the real lid use one shared open boundary.
  whiteTop=inkBottom;
  float lateralAperture=mix(smoothstep(${LATERAL_APERTURE.start.toFixed(1)},${LATERAL_APERTURE.full.toFixed(1)},referenceX),1.,blink);
  // The white aperture grows from the lower lid, leaving one continuous
  // tapered upper rim rather than a flat corner step.
  whiteTop=mix(bottom,whiteTop,lateralAperture);
  inkBottom=whiteTop;
  float horizontal = max(span.x - referenceX, referenceX - span.w) * .0056;
  float shape = coverage(max(horizontal, max(q.y - upperInkTop, bottom - q.y)));
  float white = coverage(max(horizontal, max(q.y - whiteTop, bottom - q.y))) * (1. - smoothstep(.80,.99,blink));

  vec3 sclera = mix(vec3(1., .982, .966), vec3(.77, .72, .83), smoothstep(.015, .083, q.y));
  vec2 local = p - vec2(-side * .006 + (side < 0. ? .004 : 0.) + gaze.x * .026, -.005 + gaze.y * .021);
  vec2 irisSize = vec2(.067, .086);
  vec2 uv = local / irisSize;
  float r = length(uv);
  float lowerLight = 1. - smoothstep(-.98, .44, uv.y);
  vec3 iris = mix(vec3(.123,.205,.554), vec3(.365,.580,.950), lowerLight);
  vec2 upperReflection = (uv - vec2(.25,.45)) / vec2(.30,.43);
  float upperSheen = .55 * exp(-dot(upperReflection,upperReflection));
  iris = mix(iris,vec3(.30,.43,.86),upperSheen);
  float angle = atan(uv.y, uv.x);
  float striation = .5 + .5 * sin(37. * angle + 5. * r);
  float fibers = smoothstep(.43,.58,r) * (1. - smoothstep(.88,.97,r));
  iris += vec3(.037,.055,.068) * lowerLight * fibers * striation;
  // The lower reflection is a curved shape inside the iris. Keep the
  // blue rim outside it so the highlight reads even in a narrow profile.
  // The lower pool spreads upward into a ripple-edged fan while its
  // bright center stays soft and the blue iris rim remains outside it.
  // Two raised shoulders define the lower reflection's drawn fan edge.
  // The field follows the iris with gaze; it is independent of the camera.
  float reflectedSide = max(0.,side);
  float fanLeft = exp(-pow((local.x + mix(.027,.036,reflectedSide)) / .027, 2.));
  float fanRight = exp(-pow((local.x - mix(.029,.022,reflectedSide)) / .026, 2.));
  float fanTop = -.032 + mix(.034,.022,reflectedSide) * fanLeft + mix(.028,.024,reflectedSide) * fanRight;
  float fanCoverage = 1. - smoothstep(fanTop - .0035, fanTop + .0035, local.y);
  float poolEdge = .92 * fanCoverage * (1. - smoothstep(.89,1.,r));
  vec2 brightPool = (local - vec2(mix(-.003,-.006,reflectedSide),-.065)) / vec2(.038,.026);
  float poolCenter = exp(-.78 * dot(brightPool,brightPool));
  vec3 reflectionLow = vec3(.28,.50,.91);
  vec3 reflectionHigh = vec3(mix(.800,.840,reflectedSide),mix(.940,.990,reflectedSide),.990);
  float pearlTop = smoothstep(-.080,-.055,local.y);
  reflectionHigh += vec3(.035 * pearlTop,.008 * pearlTop - .010 * (1. - pearlTop),0.);
  vec3 blueReflection = mix(reflectionLow,reflectionHigh,poolCenter);
  iris = mix(iris, blueReflection, poolEdge);
  vec3 rim = mix(vec3(.078,.115,.274),vec3(.217,.422,.732),lowerLight * .84);
  float rimStart = .86 - .16 * smoothstep(.05,.60,uv.y);
  iris = mix(iris, rim, smoothstep(rimStart,1.,r) * .91);
  vec3 pupilTop = side < 0. ? vec3(18.,27.,90.)/255. : vec3(21.,35.,109.)/255.;
  vec3 pupilMiddle = vec3(22.,31.,83.)/255.;
  vec3 pupilLower = side < 0. ? vec3(21.,25.,68.)/255. : vec3(20.,27.,80.)/255.;
  vec3 pupil = mix(pupilMiddle,pupilLower,1. - smoothstep(-.015,.010,local.y));
  pupil = mix(pupil,pupilTop,smoothstep(.010,.029,local.y));
  if (side < 0.) pupil = mix(pupil,vec3(3.,6.,52.)/255.,1. - smoothstep(-.027,-.016,local.y));
  float pupilX = -side * .0035 + .001;
  float pupilRadius = length((local-vec2(pupilX,-.0055))/vec2(.0200,.0330));
  float pupilSupport = 1. - smoothstep(1.18,1.42,pupilRadius);
  float pupilCoverage = oval(local,vec2(pupilX,-.0055),vec2(.0200,.0330)) * pupilSupport;
  if(side < 0.) iris=mix(iris,vec3(.12,.15,.42),
    .55*oval(local,vec2(pupilX+.003,.025),vec2(.0075,.014)));
  iris = mix(iris, pupil, pupilCoverage);
  vec2 reflectionSize = side < 0. ? vec2(.0158,.0170) : vec2(.0165,.0160);
  float reflection = oval(local, vec2(-.0213 - .0003 * side,.0451 - .0014 * side), reflectionSize);
  iris = mix(iris, vec3(1.,.995,.990), reflection);
  iris = mix(iris, vec3(.87,.95,1.), .32 * oval(local, vec2(.020,-.046), vec2(.008,.007)));
  // Leave a white inner corner as the iris turns toward the nose.
  float nasalGaze = smoothstep(.15,.75,-side * gaze.x);
  float innerIrisGuard = 1. - nasalGaze * smoothstep(240.5,242.3,referenceX);
  vec3 color = mix(sclera, iris, coverage((r - 1.) * irisSize.x) * innerIrisGuard);

  vec2 lashQ=q-vec2(0.,lidShift);
  float lashes = max(pointedLash(lashQ,eyePoint(207.1,168.8),eyePoint(197.7,165.8),.008),
    max(pointedLash(lashQ,eyePoint(209.7,164.6),eyePoint(204.1,159.7),.0066),
      pointedLash(lashQ,eyePoint(216.9,157.8),eyePoint(215.6,154.5),.0052)));
  // Only the upper portion is inked. The lower sclera edge has a soft seam.
  // The open inner lash ends near the iris; keep the fitted closed line.
  float upperInk=shape*coverage(max(inkBottom-q.y,q.y-inkTop))
    *smoothstep(.02,.10,innerLashTaper)
    *(1.-.55*max(0.,side)*(1.-blink)*smoothstep(237.5,240.5,referenceX)
      *smoothstep(.004,.018,q.y-inkBottom));
  vec3 lashInk=side<0. ? vec3(.104,.087,.099) : vec3(.130,.105,.126);
  lashInk+=vec3(.030,.018,.020)*(1.-smoothstep(205.,222.,referenceX));
  under = over(under, lashInk, max(upperInk, lashes * (1. - blink)));
  // The real scleral solid fills the physical aperture. Lids carry skin and ink.
  float cornerY = 175.4 - (q.y + .003) / .0056;
  float outerCornerEnd=mix(182.2,183.2,max(0.,side));
  float corner = clamp((cornerY - 168.8) / (outerCornerEnd-168.8), 0., 1.);
  float outerLid = mix(200.5, 208.4, pow(corner,.80));
  float innerLid = mix(211.0, 208.9, corner);
  float cornerDistance = max(max(168.8 - cornerY, cornerY - outerCornerEnd),
    max(outerLid - referenceX, referenceX - innerLid));
  float outerTip = coverage(cornerDistance * .0056);
  under = over(under,lashInk,outerTip * (1. - smoothstep(0.,.5,blink)));
  float lowerRange = smoothstep(208.,216.,referenceX) * (1. - smoothstep(236.,243.,referenceX));
  float lowerSeam = coverage(abs(q.y - bottom + .003) - .0013);
  under = over(under, vec3(.77,.46,.46), lowerSeam * lowerRange * .37 * (1. - blink));
  float creaseRange = smoothstep(217.,220.,referenceX) * (1. - smoothstep(236.,239.,referenceX));
  float crease = coverage(abs(q.y - untrimmedTop - .012) - .0023);
  float creaseSupport = 1. - smoothstep(.020,.030,abs(q.y - untrimmedTop - .012));
  vec3 creaseColor = mix(vec3(.60,.37,.35),vec3(.52,.30,.28),creaseSupport);
  float creaseStrength = mix(.52,.75,creaseSupport);
  under = over(under,creaseColor,crease * creaseRange * creaseStrength * (1. - blink));
  float browX = q.x / .091;
  float arch = max(0., 1. - browX * browX);
  float browHeight = .199 + .027 * arch - .009 * browX;
  float browWidth = .0014 + .0026 * arch;
  float brow = coverage(max((abs(browX) - 1.) * .091, abs(q.y - browHeight) - browWidth));
  return over(under,vec3(.40,.24,.28),brow*.80);
}

vec4 drawFace(vec2 p) {
  vec4 outColor = vec4(0.);
  for (int i = 0; i < 2; i++) {
    float s = float(i) * 2. - 1.;
    // One fixed cheek field, fitted jointly to the front and both profiles.
    vec2 cheek = (p - vec2(.2055 * s, -.114)) / vec2(.1105,.06675);
    // The blush belongs to the cheek; its soft tail clears the nasal bridge.
    float tint = .50 * exp(-1.9 * dot(cheek, cheek))
      * smoothstep(s > 0. ? .140 : .110, s > 0. ? .220 : .190, abs(p.x));
    outColor = over(outColor, vec3(.98,.53,.50), tint);
    for (int h = -2; h <= 2; h++) {
      vec2 mark = vec2(.2065 * s + float(h) * .016, -.110 - float(abs(h)) * .002);
      outColor = over(outColor, vec3(.88,.45,.44), .46 * line(p, mark, mark + vec2(-.008,-.014), .0013));
    }
  }
  outColor = eye(outColor, p - vec2(-.169,.003), -1.);
  outColor = eye(outColor, p - vec2(.169,.003), 1.);
  outColor = over(outColor, vec3(.94,.60,.58), .44 * oval(p, vec2(-.003,-.087), vec2(.005,.006)));
  vec2 mouth = p - vec2(0.,-.1505);
  float x = mouth.x;
  // Keep derivative-based edge coverage inside the physical mouth region.
  float mouthSupport = (1. - smoothstep(.082,.090,abs(x)))
    * smoothstep(-.100,-.090,mouth.y) * (1. - smoothstep(.015,.025,mouth.y));
  float mouthSmile = clamp(smile,0.,1.12);
  float open = smoothstep(.08,.25,mouthSmile);
  float r = mix(.0504,.0572,open) + .014 * mouthSmile;
  float width = x / r;
  float curve = max(0., 1. - width * width);
  float taper = sqrt(curve);
  float lip = mix(-0.0181 * pow(curve,.70),-.0207 * pow(curve,.70) + .003,open);
  float upper = mix(lip, .005 - .011 * taper, open);
  float lower = upper - (.015 + mouthSmile * .057) * taper * open;
  mouthSupport *= smoothstep(lower - .022,lower - .014,mouth.y)
    * (1. - smoothstep(upper + .014,upper + .022,mouth.y));
  float inside = coverage(max(abs(x) - r, max(mouth.y - upper, lower - mouth.y))) * open;
  vec3 inner = mix(vec3(.99,.61,.58), vec3(.56,.23,.32), smoothstep(lower,upper + .001,mouth.y));
  outColor = over(outColor, inner, inside * mouthSupport);
  float lipCorner = smoothstep(.35,.68,abs(width));
  float strokeWidth = .0023 + .0014 * lipCorner;
  float lipDistance = max(abs(x) - r, abs(mouth.y - upper) - strokeWidth);
  float lipBlur = max(.0012,fwidth(lipDistance)*1.2);
  float closedStroke = 1. - smoothstep(-lipBlur,lipBlur,lipDistance);
  float capDistance = length(mouth-vec2((x<0. ? -1. : 1.) * r,0.))-.0035;
  float capBlur = max(.0012,fwidth(capDistance)*1.2);
  float lipCap = 1. - smoothstep(-capBlur,capBlur,capDistance);
  float stroke = mix(max(closedStroke,lipCap),coverage(lipDistance),open);
  vec3 lipColor = mix(vec3(.72,.32,.29),vec3(.31,.10,.12),lipCorner);
  float lipOpacity=mix(.72+.24*lipCorner,.60+.32*lipCorner,open);
  outColor = over(outColor, lipColor, stroke * lipOpacity * mouthSupport);
  // A thin warm lower-lip sheen follows the actual lower aperture.
  // Fade it during opening so no closed smile remains under an open mouth.
  float lipSheenRange = smoothstep(.05,.35,curve);
  float lipSheen = coverage(abs(mouth.y - lower + strokeWidth + .0030) - .0014);
  outColor = over(outColor, vec3(1.,.985,.955), (.45 + .45 * smoothstep(.10,.46,abs(width))) * lipSheen * lipSheenRange
    * (1. - smoothstep(.05,.70,open)) * mouthSupport);
  return outColor;
}
`

function socketEyeProfile(t:number,blinkAmount:number,side:number) {
  const cubic=(a:number,b:number,c:number,d:number)=>a*(1-t)**3+3*b*(1-t)**2*t+3*c*(1-t)*t*t+d*t**3
  const smooth=(a:number,b:number,v:number)=>{const q=Math.max(0,Math.min(1,(v-a)/(b-a)));return q*q*(3-2*q)}
  const mix=(a:number,b:number,q:number)=>a+(b-a)*q,blink=Math.max(0,Math.min(1,blinkAmount))
  const x=cubic(203.2,214,236.2,244.5),height=(v:number)=>(175.4-v)*.0056-.003
  const closed=height(cubic(172,176,176,173)),fit=smooth(211,219,x)*(1-smooth(237,242,x))*(1-blink)
  let top=mix(height(cubic(168.8,150.3683,147.1474,172.6)),closed+.004,blink)
  let white=mix(height(cubic(176.5,152.75,154,172.8))-.012*Math.exp(-(((x-207.6)/4.8)**2)),closed,blink)-.0048
  top+=(side>0?.003:-.003)*fit+.0015*Math.exp(-(((x-224.5)/2.8)**2))*(side>0?1:.6)*(1-blink)
  white-=(side>0?.0056:.0084)*fit
  const lowerFit=(side>0?.0056:.0014)*smooth(208,214,x)*(1-smooth(222,228,x))
  const bottom=mix(height(cubic(172.8,198.5,197.6,172.8))+.014*(1-smooth(211,217,x))+lowerFit,closed-.004,blink)
  const taper=1-smooth(237.5,mix(241.5,244.5,blink),x)
  top=mix(white,top,1-.30*fit)
  white=mix(mix(top,white,taper),white,blink)
  const lateral=mix(smooth(LATERAL_APERTURE.start,LATERAL_APERTURE.full,x),1,blink)
  return{x,top:.003+.96*mix(bottom,white,lateral),bottom:.003+.96*bottom}
}

// Fixed head-local modeling parameters shared by the GPU and diagnostics.
// Iris and pupil proportions follow the turnaround within one fixed
// convex volume at every view. Neutral centers and gaze offsets stay fixed.
const IRIS_SHAPE={xzPower:6,radii:[.06432,.08064,0.024153646945530318],
  tilt:0,pupilRadii:[.02016,.03456,.01008],
  pupilCenterTilt:0.24497866312686414} as const

const OPTICAL_IRIS_COLORS=FEATURES.slice(FEATURES.indexOf('  float lowerLight ='),FEATURES.indexOf('  // Leave a white inner corner'))
  .replace('float pupilRadius = length((local-vec2(pupilX,-.0055))/vec2(.0200,.0330));',
    `float pupilRadius=irisNorm(irisNearest(lensPoint,view,irisCenter+opticalRotate(vec3(.96*pupilX,-.96*.0055,.004),side*${IRIS_SHAPE.pupilCenterTilt.toPrecision(17)}),vec3(${IRIS_SHAPE.pupilRadii.map(v=>v.toPrecision(17)).join(",")}),${IRIS_SHAPE.tilt.toFixed(1)}));`)
  .replace('oval(local,vec2(pupilX,-.0055),vec2(.0200,.0330)) * pupilSupport',
    'coverage((pupilRadius-1.)*.0200)*pupilSupport')

const OPTICAL_VOLUME_SHADER=`
uniform vec2 gaze;
uniform float eyeSide;
varying vec3 lensPoint;
varying vec3 lensView;
float coverage(float d){float width=max(.00065,fwidth(d)*.8);return 1.-smoothstep(-width,width,d);}
float oval(vec2 at,vec2 center,vec2 radius){return coverage((length((at-center)/radius)-1.)*min(radius.x,radius.y));}
vec3 opticalRotate(vec3 p,float angle){float c=cos(angle),s=sin(angle);return vec3(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);}
// Closest point to a ray in one fixed convex 3D iris volume.
// XZ is a rounded superellipse, Y remains elliptical. This geometry fit
// has no view-angle gain, preset lookup, image or vertex deformation.
float irisNorm(vec3 p){return sqrt(pow(pow(abs(p.x),${IRIS_SHAPE.xzPower.toFixed(1)})+pow(abs(p.z),${IRIS_SHAPE.xzPower.toFixed(1)}),2./${IRIS_SHAPE.xzPower.toFixed(1)})+p.y*p.y);}
vec3 irisNearest(vec3 p,vec3 view,vec3 center,vec3 radii,float angle){
  vec3 at=opticalRotate(p-center,-angle)/radii,ray=normalize(opticalRotate(view,-angle)/radii);
  float middle=-dot(at,ray),span=2.*length(at)+1.,lo=middle-span,hi=middle+span;
  for(int i=0;i<20;i++){
    float t=(lo+hi)*.5;vec3 q=at+t*ray;
    float base=max(1.e-12,pow(abs(q.x),${IRIS_SHAPE.xzPower.toFixed(1)})+pow(abs(q.z),${IRIS_SHAPE.xzPower.toFixed(1)}));
    float slope=pow(base,2./${IRIS_SHAPE.xzPower.toFixed(1)}-1.)*(sign(q.x)*pow(abs(q.x),${IRIS_SHAPE.xzPower.toFixed(1)}-1.)*ray.x+sign(q.z)*pow(abs(q.z),${IRIS_SHAPE.xzPower.toFixed(1)}-1.)*ray.z)+q.y*ray.y;
    if(slope>0.)hi=t;else lo=t;
  }
  return at+ray*((lo+hi)*.5);
}
vec3 opticalEyeColor(){
  float side=eyeSide,tilt=${IRIS_SHAPE.tilt.toFixed(1)};
  vec3 view=normalize(lensView);
  vec3 irisCenter=vec3(side*.169+.96*(-side*.006+(side<0.?.004:0.)+gaze.x*.026),.003+.96*(-.005+gaze.y*.021),.1924);
  vec3 radii=vec3(${IRIS_SHAPE.radii.map(v=>v.toPrecision(17)).join(",")}),at=irisNearest(lensPoint,view,irisCenter,radii,tilt);
  vec3 ray=normalize(opticalRotate(view,-tilt)/radii),right=normalize(vec3(ray.z,0.,-ray.x)),up=cross(ray,right);
  vec2 uv=vec2(dot(at,right),dot(at,up)),irisSize=vec2(.067,.086),local=uv*irisSize;
  float r=irisNorm(at),qy=(lensPoint.y-.003)/.96;
  vec3 sclera=mix(vec3(1.,.982,.966),vec3(.77,.72,.83),smoothstep(.015,.083,qy));
${OPTICAL_IRIS_COLORS}
  return mix(sclera,iris,coverage((r-1.)*irisSize.x));
}
`

type SocketSample={x:number,top:number,bottom:number,t:number}
const socketSamples=new Map<number,SocketSample[]>()
const socketDepthSamples=new Map<number,{z0:number,z1:number,rise:number}[]>()
const socketScleraClearance=new Map<number,(x:number,y:number)=>number|undefined>()
function socketEyeSamples(side:number) {
  const cached=socketSamples.get(side);if(cached)return cached
  const gap=(t:number)=>{const p=socketEyeProfile(t,0,side);return p.top-p.bottom}
  let first=-1,last=-1
  for(let i=0;i<=256;i++)if(gap(i/256)>1e-8){if(first<0)first=i;last=i}
  if(first<0||last<=first)throw Error('No positive eye aperture')
  let a=Math.max(0,(first-1)/256),b=first/256
  for(let i=0;i<36;i++){const t=(a+b)/2;if(gap(t)>0)b=t;else a=t}
  const start=(a+b)/2;a=last/256;b=Math.min(1,(last+1)/256)
  for(let i=0;i<36;i++){const t=(a+b)/2;if(gap(t)>0)a=t;else b=t}
  const end=(a+b)/2,samples:SocketSample[]=[]
  for(let i=0;i<=128;i++){
    const t=start+(end-start)*i/128,p=socketEyeProfile(t,0,side),pole=i===0||i===128,cy=(p.top+p.bottom)/2
    samples.push({t,x:side*.169+side*.96*(227-p.x)*.0056,top:pole?cy:p.top,bottom:pole?cy:p.bottom})
  }
  socketSamples.set(side,samples);return samples
}
function socketHeadRingY(ring:number) {
  const y=-.2608+(MAX_Y+.2608)*ring/224,t=Math.max(0,Math.min(1,(-.2395-y)/.0213))
  return y+(MIN_Y+.2608)*t*t*(3-2*t)
}
let socketSeamSections:{y:number;center:number}[]|undefined
function socketSeamCenter(y:number) {
  const rows=socketSeamSections??=Array.from({length:225},(_,i)=>{const y=socketHeadRingY(i);return{y,center:closedLowerFaceSection(y).center}})
  let low=0,high=rows.length-1
  while(high-low>1){const mid=(low+high)>>1;if(rows[mid].y<y)low=mid;else high=mid}
  const a=rows[low],b=rows[high],t=Math.max(0,Math.min(1,(y-a.y)/(b.y-a.y)))
  return a.center+(b.center-a.center)*t
}
// A fixed physical B-spline fairing field regularizes the lower skin.
// It changes actual XYZ vertices and their differential normals together.
// Build the correction from the uncreased lip endpoint, then keep the same
// correction on both mouth morphs so the authored lip detail stays intact.
let lowerSkinFairGrid:Float64Array|undefined
function lowerSkinFairing(x:number,y:number) {
  const smooth=(a:number,b:number,v:number)=>{const t=Math.max(0,Math.min(1,(v-a)/(b-a)));return t*t*t*(t*(t*6-15)+10)}
  const width=closedLowerFaceSection(y).width,across=Math.abs(x)/Math.max(width,1e-8)
  if(y<=-.249||y>=-.100||across>=.90)return 0
  const weight=smooth(-.249,-.223,y)*(1-smooth(-.131,-.100,y))*(1-smooth(.60,.90,across))*smooth(.015,.065,Math.abs(x))
  const nx=128,ny=80,x0=-.30,x1=.30,y0=-.270,y1=-.085
  if(!lowerSkinFairGrid){
    const raw=new Float64Array((nx+1)*(ny+1))
    for(let row=0;row<=ny;row++)for(let col=0;col<=nx;col++)raw[row*(nx+1)+col]=socketRawSkinDepth(x0+(x1-x0)*col/nx,y0+(y1-y0)*row/ny,false)
    let filtered=raw.slice()
    const kernel=[1,4,6,4,1]
    for(let pass=0;pass<8;pass++)for(const axis of[0,1]){
      const next=new Float64Array(raw.length)
      for(let row=0;row<=ny;row++)for(let col=0;col<=nx;col++){
        let value=0
        for(let k=-2;k<=2;k++){
          const r=Math.max(0,Math.min(ny,row+(axis===1?k:0))),c=Math.max(0,Math.min(nx,col+(axis===0?k:0)))
          value+=kernel[k+2]*filtered[r*(nx+1)+c]/16
        }
        next[row*(nx+1)+col]=value
      }
      filtered=next
    }
    lowerSkinFairGrid=filtered.map((z,i)=>z-raw[i])
  }
  const u=(x-x0)/(x1-x0)*nx,v=(y-y0)/(y1-y0)*ny,col=Math.floor(u),row=Math.floor(v)
  const basis=(t:number)=>[(1-t)**3/6,(3*t**3-6*t*t+4)/6,(-3*t**3+3*t*t+3*t+1)/6,t**3/6]
  const bx=basis(u-col),by=basis(v-row);let delta=0
  for(let r=0;r<4;r++)for(let c=0;c<4;c++)delta+=by[r]*bx[c]*lowerSkinFairGrid[Math.max(0,Math.min(ny,row+r-1))*(nx+1)+Math.max(0,Math.min(nx,col+c-1))]
  return weight*0.008*Math.tanh(delta/0.008)
}
// Retreat the broad lower cheek toward one monotone section. The smooth
// positive part has two zero derivatives at contact and never advances skin.
// One common correction keeps both existing lip morph endpoints coherent.
function lowerFaceRetreat(x:number,y:number,neutralDepth:number) {
  if(y>=-.100||y<=MIN_Y||Math.abs(x)<1e-8)return 0
  const s=closedLowerFaceSection(y)
  if(Math.abs(x)>=s.width)return 0
  const radius=Math.max(0,1-(x/s.width)**2)
  const profile=frontSurface(0,y,1,s.front,s.center,true,false)
  const target=s.center+(profile-s.center)*radius**(.5+.950*radius)
  const q=Math.max(0,Math.min(1,(-y-.100)/.042)),support=q*q*q*(q*(q*6-15)+10)
  const excess=Math.max(0,neutralDepth-target)
  return support*(excess-.0015*Math.tanh(excess/.0015))
}
function socketSkinDepth(x:number,y:number,lipReturn=true) {
  const fair=lowerSkinFairing(x,y),neutral=socketRawSkinDepth(x,y,false)+fair
  const depth=lipReturn?socketRawSkinDepth(x,y,true)+fair:neutral
  return depth-lowerFaceRetreat(x,y,neutral)
}
function socketRawSkinDepth(x:number,y:number,lipReturn=true) {
  const s=closedLowerFaceSection(y),cosine=Math.sqrt(Math.max(0,1-(x/Math.max(1e-12,s.width))**2))
  const seam=socketSeamCenter(y)
  if(Math.abs(x)>=s.width-1e-12)return seam
  const u=Math.max(0,Math.min(1,(cosine-.04)/.16)),weight=1-u*u*(3-2*u)
  // Match the actual linear back-ring seam, including the strip just under
  // the chin, rather than crossing it with an independently sampled centre.
  return frontSurface(x,y,cosine,s.front,s.center,true,lipReturn)+(seam-s.center)*weight
}
function socketLensDepth(side:number,row:number,y:number) {
  const p=socketEyeSamples(side)[row],gap=p.top-p.bottom,u=gap>1e-10?Math.max(0,Math.min(1,(y-p.bottom)/gap)):.5
  let depths=socketDepthSamples.get(side)
  if(!depths){depths=socketEyeSamples(side).map((p,row)=>({z0:socketSkinDepth(p.x,p.bottom),z1:socketSkinDepth(p.x,p.top),rise:.032*Math.sin(Math.PI*row/128)}));socketDepthSamples.set(side,depths)}
  const{z0,z1,rise}=depths[row]
  return z0+(z1-z0)*u+rise*Math.sqrt(Math.max(0,1-(2*u-1)**2))
}

// One indexed front surface with two real holes, joined to the original back.
// Protected edges are never split: both eye solids and skin use these vertices.
let socketPlan:{xy:number[],index:number[],frontCount:number,backZ:Map<number,number>,outer:Set<number>,holeLoops:number[][]}|undefined
function socketHeadPlan() {
  if(socketPlan)return socketPlan
  const yAt=socketHeadRingY
  const outer:Vector2[]=[],left:number[]=[],right:number[]=[]
  for(let row=0;row<=224;row++){const y=yAt(row);left[row]=outer.length;outer.push(new Vector2(-closedLowerFaceSection(y).width,y))}
  right[0]=left[0];right[224]=left[224]
  for(let row=223;row>0;row--){const y=yAt(row);right[row]=outer.length;outer.push(new Vector2(closedLowerFaceSection(y).width,y))}
  const holes=[-1,1].map(side=>{const p=socketEyeSamples(side),loop=p.map(q=>new Vector2(q.x,q.top));for(let row=127;row>0;row--)loop.push(new Vector2(p[row].x,p[row].bottom));return loop})
  const all=[...outer,...holes.flat()],xy=all.flatMap(p=>[p.x,p.y]),holeLoops:number[][]=[],protectedEdges=new Set<string>(),outerIds=new Set(outer.map((_,i)=>i))
  const edgeKey=(a:number,b:number)=>Math.min(a,b)+','+Math.max(a,b)
  let offset=0;for(const loop of[outer,...holes]){const ids=loop.map((_,i)=>offset+i);for(let i=0;i<ids.length;i++)protectedEdges.add(edgeKey(ids[i],ids[(i+1)%ids.length]));if(offset)holeLoops.push(ids);offset+=loop.length}
  let index=ShapeUtils.triangulateShape(outer,holes).flat()
  for(let i=0;i<index.length;i+=3){const[a,b,c]=index.slice(i,i+3),area=(xy[2*b]-xy[2*a])*(xy[2*c+1]-xy[2*a+1])-(xy[2*b+1]-xy[2*a+1])*(xy[2*c]-xy[2*a]);if(area<0)[index[i+1],index[i+2]]=[index[i+2],index[i+1]]}
  for(let pass=0;pass<12;pass++){
    const mids=new Map<string,number>(),out:number[]=[]
    const split=(a:number,b:number)=>{const key=edgeKey(a,b);if(protectedEdges.has(key))return-1;const dx=xy[2*a]-xy[2*b],dy=xy[2*a+1]-xy[2*b+1];if(dx*dx+dy*dy<=.012*.012)return-1;const old=mids.get(key);if(old!==undefined)return old;const n=xy.length/2;xy.push((xy[2*a]+xy[2*b])/2,(xy[2*a+1]+xy[2*b+1])/2);mids.set(key,n);return n}
    for(let i=0;i<index.length;i+=3){const[a,b,c]=index.slice(i,i+3),ab=split(a,b),bc=split(b,c),ca=split(c,a),mask=(ab>=0?1:0)|(bc>=0?2:0)|(ca>=0?4:0)
      switch(mask){case 0:out.push(a,b,c);break;case 1:out.push(a,ab,c,ab,b,c);break;case 2:out.push(a,b,bc,a,bc,c);break;case 3:out.push(a,ab,c,ab,bc,c,ab,b,bc);break;case 4:out.push(a,b,ca,b,c,ca);break;case 5:out.push(a,ab,ca,ab,b,c,ab,c,ca);break;case 6:out.push(a,b,bc,a,bc,ca,bc,c,ca);break;case 7:out.push(a,ab,ca,ab,b,bc,ca,bc,c,ab,bc,ca);break}
    }
    index=out;if(!mids.size)break
  }
  const frontCount=xy.length/2,backZ=new Map<number,number>(),backRows:number[][]=[]
  for(let row=0;row<=224;row++){
    if(row===0||row===224){backRows.push([left[row]]);continue}
    const y=yAt(row),s=closedLowerFaceSection(y),ring=[right[row]]
    for(let j=1;j<192;j++){const theta=Math.PI/2+j*Math.PI/192,n=xy.length/2;xy.push(s.width*Math.sin(theta),y);backZ.set(n,s.center+s.back*Math.cos(theta));ring.push(n)}ring.push(left[row]);backRows.push(ring)
  }
  for(let row=1;row<=224;row++)for(let j=0;j<192;j++){
    const a=backRows[row-1],b=backRows[row]
    if(row===1)index.push(a[0],b[j+1],b[j]);else if(row===224)index.push(a[j],a[j+1],b[0]);else index.push(a[j],a[j+1],b[j],a[j+1],b[j+1],b[j])
  }
  socketPlan={xy,index,frontCount,backZ,outer:outerIds,holeLoops};return socketPlan
}
function socketHeadGeometry(lipReturn=true) {
  const p=socketHeadPlan(),positions:number[]=[],weights:number[]=[]
  for(let i=0;i<p.xy.length/2;i++){
    const x=p.xy[2*i],y=p.xy[2*i+1],back=p.backZ.get(i),s=closedLowerFaceSection(y)
    const z=back!==undefined?back:p.outer.has(i)?s.center:socketSkinDepth(x,y,lipReturn)
    positions.push(x,y,z);const cosine=Math.sqrt(Math.max(0,1-(x/Math.max(1e-12,s.width))**2));weights.push(back===undefined?Math.max(0,Math.min(1,(cosine-.045)/.16)):0)
  }
  const g=new BufferGeometry();g.setAttribute('position',new Float32BufferAttribute(positions,3));g.setAttribute('faceWeight',new Float32BufferAttribute(weights,1));g.setIndex(p.index);g.computeVertexNormals()
  // Differentiate the authored skin in its XY chart. Dense, thin triangles
  // amplify float32 position rounding when their normals are accumulated.
  // These normals are the actual surface tangents, not a lighting-only blur.
  const normal=g.attributes.normal,step=.00002
  for(let i=0;i<p.frontCount;i++){
    if(p.outer.has(i))continue
    const x=p.xy[2*i],y=p.xy[2*i+1]
    if(y-step<=MIN_Y||y+step>=MAX_Y)continue
    const width=Math.min(closedLowerFaceSection(y-step).width,closedLowerFaceSection(y+step).width)
    if(Math.abs(x)+step>=width)continue
    const dx=(socketSkinDepth(x+step,y,lipReturn)-socketSkinDepth(x-step,y,lipReturn))/(2*step)
    const dy=(socketSkinDepth(x,y+step,lipReturn)-socketSkinDepth(x,y-step,lipReturn))/(2*step)
    const length=Math.hypot(dx,dy,1)
    normal.setXYZ(i,-dx/length,-dy/length,1/length)
  }
  g.computeBoundingSphere();g.userData.eyeSockets={holes:2,sharedBoundarySamples:256,frontVertexCount:p.frontCount,holeLoops:p.holeLoops};return g
}

// A closed slab with a curved front, an inset rear and shared edge walls.
function socketSolidPositions(side:number,kind:'sclera'|'upper-lid'|'lower-lid',blinkAmount:number) {
  const samples=socketEyeSamples(side),columns=24,positions:number[]=[],rows:number[][]=[]
  for(let row=0;row<=128;row++){
    const p=samples[row],now=socketEyeProfile(p.t,blinkAmount,side),shut=socketEyeProfile(p.t,1,side),gap=p.top-p.bottom,meeting=Math.max(p.bottom+.03*gap,Math.min(p.top-.03*gap,(shut.top+shut.bottom)/2)),close=blinkAmount>=.99
    let lower=p.bottom,upper=p.top
    if(kind==='upper-lid')lower=close?meeting:Math.min(p.top-.015*gap*blinkAmount,Math.max(meeting,now.top))
    if(kind==='lower-lid')upper=close?meeting:Math.max(p.bottom+.015*gap*blinkAmount,Math.min(meeting,now.bottom))
    const pole=row===0||row===128,ring:number[]=[]
    for(let col=0;col<=(pole?0:columns);col++){
      const u=pole?.5:col/columns,y=lower+(upper-lower)*u,z=socketLensDepth(side,row,y)
      const onBoundary=kind==='upper-lid'?u===1:kind==='lower-lid'?u===0:true
      const lift=kind==='sclera'||pole||onBoundary?0:.0015*Math.sin(Math.PI*row/128)
      ring.push(positions.length/3);positions.push(p.x,y,z+lift)
    }rows.push(ring)
  }
  const frontCount=positions.length/3
  for(let i=0;i<frontCount;i++)positions.push(positions[3*i],positions[3*i+1],positions[3*i+2]-(kind==='sclera'?.040:.003))
  return{positions,rows,frontCount,columns}
}
function socketSolid(side:number,kind:'sclera'|'upper-lid'|'lower-lid',blinkAmount:number) {
  const{positions,rows,frontCount,columns}=socketSolidPositions(side,kind,blinkAmount),indices:number[]=[]
  const front:number[]=[]
  for(let row=1;row<=128;row++)for(let j=0;j<columns;j++){
    const a=rows[row-1],b=rows[row]
    if(row===1)front.push(a[0],b[j],b[j+1]);else if(row===128)front.push(a[j],b[0],a[j+1]);else front.push(a[j],b[j],a[j+1],a[j+1],b[j],b[j+1])
  }
  if(side>0)for(let i=0;i<front.length;i+=3)[front[i+1],front[i+2]]=[front[i+2],front[i+1]]
  indices.push(...front);for(let i=0;i<front.length;i+=3)indices.push(front[i]+frontCount,front[i+2]+frontCount,front[i+1]+frontCount)
  const boundary=[...rows.map(r=>r[0]),...rows.slice(1,-1).reverse().map(r=>r[columns])]
  const edges=new Map<string,[number,number]>()
  for(let i=0;i<front.length;i+=3)for(let e=0;e<3;e++){const a=front[i+e],b=front[i+(e+1)%3],key=Math.min(a,b)+','+Math.max(a,b);if(edges.has(key))edges.delete(key);else edges.set(key,[a,b])}
  for(const[a,b]of edges.values())indices.push(b,a,b+frontCount,a,a+frontCount,b+frontCount)
  const g=new BufferGeometry();g.setAttribute('position',new Float32BufferAttribute(positions,3));g.setAttribute('faceWeight',new Float32BufferAttribute(Array(positions.length/3).fill(1),1));g.setIndex(indices);g.computeVertexNormals();g.computeBoundingSphere();g.userData.eyeSolid={kind,side,frontCount,frontBoundary:boundary,thickness:kind==='sclera'?.040:.003,blink:blinkAmount};return g
}

function socketOpticalMaterial(skin:MeshPhongMaterial,side:number,gaze:{value:Vector2}) {
  const paint=skin.clone();paint.userData.outlineParameters={visible:false};paint.userData.fixedIrisVolume={...IRIS_SHAPE,radii:[...IRIS_SHAPE.radii],pupilRadii:[...IRIS_SHAPE.pupilRadii],implicitNPR:true};paint.stencilWrite=true;paint.stencilRef=1;paint.stencilWriteMask=1;paint.stencilFunc=AlwaysStencilFunc;paint.stencilZPass=ReplaceStencilOp
  paint.onBeforeCompile=(shader,renderer)=>{
    skin.onBeforeCompile(shader,renderer);Object.assign(shader.uniforms,{gaze,eyeSide:{value:side}})
    shader.vertexShader='varying vec3 lensPoint; varying vec3 lensView;\n'+shader.vertexShader
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\n lensPoint=position; lensView=vec3(modelViewMatrix[0].z,modelViewMatrix[1].z,modelViewMatrix[2].z);')
    shader.fragmentShader=OPTICAL_VOLUME_SHADER+shader.fragmentShader
    shader.fragmentShader=shader.fragmentShader.replace('#include <envmap_fragment>','#include <envmap_fragment>\n outgoingLight=sRGBTransferEOTF(vec4(opticalEyeColor(),1.)).rgb;')
  };paint.customProgramCacheKey=()=> 'bluefish-socket-optical-volume-'+JSON.stringify(IRIS_SHAPE)+'-'+side;return paint
}
function createSocketEyes(head:Object3D,skin:MeshPhongMaterial,lidPaint:MeshPhongMaterial,gaze:{value:Vector2}) {
  const lids:{mesh:Mesh,side:number,kind:'upper-lid'|'lower-lid',closedPosition:Float32Array,closedNormal:Float32Array}[]=[]
  for(const side of[-1,1]){
    const white=new Mesh(socketSolid(side,'sclera',0),socketOpticalMaterial(skin,side,gaze));white.name='eye-sclera-'+(side<0?'left':'right');head.add(white)
    socketScleraClearance.set(side,profileFrontDepth(white.geometry))
    for(const kind of['upper-lid','lower-lid']as const){const mesh=new Mesh(socketSolid(side,kind,1),lidPaint);mesh.name=kind+'-'+(side<0?'left':'right');mesh.visible=false;head.add(mesh);lids.push({mesh,side,kind,closedPosition:new Float32Array(mesh.geometry.attributes.position.array),closedNormal:new Float32Array(mesh.geometry.attributes.normal.array)})}
  }
  let previous=-1
  return{draw(blinkAmount:number){const b=Math.max(0,Math.min(1,blinkAmount)),visible=b>.00001;for(const{mesh}of lids)mesh.visible=visible;if(b===previous)return;previous=b
    // Topology and GPU buffers stay fixed throughout the blink. Hidden lids
    // return to their valid closed geometry; visible lids update only vertices.
    for(const{mesh,side,kind,closedPosition,closedNormal}of lids){const g=mesh.geometry
      if(visible){g.attributes.position.array.set(socketSolidPositions(side,kind,b).positions);g.computeVertexNormals()}
      else{g.attributes.position.array.set(closedPosition);g.attributes.normal.array.set(closedNormal);g.attributes.normal.needsUpdate=true}
      g.attributes.position.needsUpdate=true;g.computeBoundingSphere();g.userData.eyeSolid.blink=visible?b:1
    }
  }}
}

export function createBluefishFace(head: Object3D, skin: MeshPhongMaterial) {
  const faceSkin = skin.clone()
  faceSkin.userData.outlineParameters = { visible: false }
  faceSkin.stencilWrite = true
  faceSkin.stencilRef = 1
  faceSkin.stencilWriteMask = 1
  faceSkin.stencilFunc = AlwaysStencilFunc
  faceSkin.stencilZPass = ReplaceStencilOp
  const gaze = { value: new Vector2() }
  const blink = { value: 0 }
  const smile = { value: 0 }
  faceSkin.onBeforeCompile = (shader, renderer) => {
    skin.onBeforeCompile(shader, renderer)
    Object.assign(shader.uniforms, { gaze, blink, smile })
    shader.vertexShader = 'attribute float faceWeight; varying vec2 facePoint; varying float visibleFace;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      facePoint = position.xy;
      visibleFace = faceWeight;
    `)
    shader.fragmentShader = FEATURES + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.,.88,.83), (1.-smoothstep(-.24,.04,facePoint.y))*.38);
    `)
    shader.fragmentShader = shader.fragmentShader.replace('#include <envmap_fragment>', `
      #include <envmap_fragment>
      // The outline shell follows the visible silhouette. A normal-based
      // band also inked the recessed eye socket and cheek at oblique views.
      // Derivative-based feature coverage must run in every fragment.
      // The fixed front-surface weight keeps features off the rear skin.
      vec4 detail = drawFace(facePoint);
      outgoingLight = mix(outgoingLight, sRGBTransferEOTF(detail).rgb, detail.a * visibleFace);
    `)
  }
  // Include the concrete feature field, so factories with different fixed
  // aperture fits cannot accidentally reuse each other's skin/lid shader.
  faceSkin.customProgramCacheKey=()=> 'bluefish-fixed-face-field|'+FEATURES
  // A facial-expression target only: fully open uses the neutral physical skin.
  const geometry = headGeometry(false)
  const closedLipGeometry = headGeometry()
  const closedPositions = closedLipGeometry.getAttribute('position').clone()
  const closedNormals = closedLipGeometry.getAttribute('normal').clone()
  closedPositions.name = 'closed-lip-return'
  closedNormals.name = 'closed-lip-return'
  geometry.morphAttributes.position = [closedPositions]
  geometry.morphAttributes.normal = [closedNormals]
  geometry.morphTargetsRelative = false
  closedLipGeometry.dispose()
  const mesh = new Mesh(geometry, faceSkin)
  mesh.name = 'face-skin'
  head.add(mesh)
  // Mask the skin before drawing its inverted hull. The concave orbit
  // must not expose outline fragments across the cheek or closed eyelid.
  const contour = new MeshBasicMaterial({
    color: 0x674a59, side: BackSide, depthWrite: false,
    stencilWrite: true, stencilRef: 1, stencilFunc: NotEqualStencilFunc, stencilFuncMask: 1,
  })
  contour.userData.outlineParameters = { visible: false }
  contour.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #if !defined ( USE_ENVMAP ) && !defined ( USE_SKINNING )
        #include <beginnormal_vertex>
        #include <morphnormal_vertex>
      #endif
      #include <begin_vertex>
    `)
    // Absolute morph targets scale the base vertex before adding the
    // target. Expand the finished surface so its outline does not vanish
    // at a fully weighted view, and use that view's morphed normal.
    shader.vertexShader = shader.vertexShader.replace('#include <morphtarget_vertex>', `
      #include <morphtarget_vertex>
      transformed += normalize(objectNormal) * .0040;
    `)
  }
  const hull = new Mesh(geometry, contour)
  hull.name = 'face-contour'
  hull.renderOrder = 1
  head.add(hull)
  const socketEyes=createSocketEyes(head,skin,faceSkin,gaze)
  return {
    draw(gazeX: number, gazeY: number, blinkAmount: number, smileAmount: number) {
      gaze.value.set(gazeX, gazeY)
      blink.value = blinkAmount
      socketEyes.draw(blinkAmount)
      smile.value = smileAmount
      const phase=Math.max(0,Math.min(1,(Math.max(0,Math.min(1.12,smileAmount))-.08)/.17))
      const closedWeight=1-phase*phase*(3-2*phase)
      mesh.morphTargetInfluences![0]=closedWeight
      hull.morphTargetInfluences![0]=closedWeight
    },
  }
}


/** Keep the full head in one authored physical shape as the camera moves.
 * Gaze and expression fields remain attached to the skin. Hair settlement
 * and the existing skeletal animation keep their original controllers. */
export function createBluefishHeadShapes(head: Object3D,
  _clothContacts?: readonly ((y: number,z: number)=>number|undefined)[]) {
  head.updateWorldMatrix(true, true)
  const local = new Vector3()
  const inverseHead = new Matrix4()
  return {
    draw(viewDirection: Vector3) {
      inverseHead.copy(head.matrixWorld).invert()
      local.copy(viewDirection).transformDirection(inverseHead)
      const angle = Math.atan2(local.x,local.z)
      const pitch = Math.atan2(local.y,Math.hypot(local.x,local.z))
      return {angle,pitch,weight:0,profileWeight:0,rearWeight:0}
    },
  }
}
