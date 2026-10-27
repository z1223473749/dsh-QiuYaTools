/** Coordinates belong to the packaged 1600 × 900 illustration, not the UI.
 * R: water, G: rider/whale, B: flexible details. Soft mask edges let the
 * original brush strokes move together without cutting the painting apart. */
export function createOceanMask(doc: Document, matte = false): HTMLCanvasElement | null {
  const win = doc.defaultView
  if (!win?.Path2D) return null
  const mask = doc.createElement('canvas')
  mask.width = 1600
  mask.height = 900
  const ctx = mask.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, 1600, 900)
  // Feather the horizon, then paint the silhouettes over the water channel.
  const horizon = ctx.createLinearGradient(0, 507, 0, 552)
  horizon.addColorStop(0, '#000')
  horizon.addColorStop(1, '#f00')
  if (!matte) {
    ctx.fillStyle = horizon
    ctx.fillRect(0, 507, 1600, 393)
  }
  // The transition must be wider than the largest displacement. Otherwise
  // clouds and a thin fin can sample opposite sides of the same outline and
  // fold the tip inward. This is a motion field, not a hard cutout alpha mask.
  ctx.filter = matte ? 'blur(.4px)' : 'blur(18px)'
  const paint = (color: string, path: string, edgeWidth = 1.2): void => {
    const outline = new win.Path2D(path)
    ctx.fillStyle = matte ? '#fff' : color
    ctx.fill(outline)
    if (matte) {
      // Follow the inked silhouette with subpixel coverage. A broad stroke
      // carries the source sea along with the moving belly and fin.
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = edgeWidth
      ctx.lineJoin = 'round'
      ctx.stroke(outline)
    }
  }
  paint('#00ff00', `M 827 592 C 814 552 860 513 912 506 C 963 493 1006 511 1040 511
    L 1146 525 C 1218 547 1280 589 1341 573 C 1409 557 1405 518 1382 488
    C 1346 464 1293 463 1268 410 C 1252 383 1246 348 1242 323
    C 1268 326 1267 365 1307 375 C 1355 381 1390 417 1402 445
    C 1411 408 1462 405 1484 370 C 1502 379 1506 427 1493 459
    C 1474 493 1445 513 1452 551 C 1464 576 1473 604 1470 630
    C 1470 650 1466 669 1455 682 C 1451 694 1445 704 1437 710
    C 1428 722 1419 731 1408 740 C 1395 750 1378 758 1364 763
    C 1356 767 1348 769 1341 771 C 1388 799 1430 810 1474 813
    C 1480 813 1484 815 1483 819 C 1482 823 1475 827 1462 831
    C 1437 840 1388 847 1349 843 C 1281 840 1242 807 1207 780
    C 1136 788 1072 779 1001 753 C 919 724 852 660 827 592 Z`)
  paint('#00ff00', `M 1011 510 L 1030 487 C 1038 477 1039 447 1053 435
    L 1067 428 L 1066 416 C 1049 410 1055 392 1058 387
    L 1052 373 L 1073 362 L 1077 351 L 1094 356 L 1117 353
    L 1115 360 L 1134 368 L 1130 379 L 1144 394 L 1136 401
    L 1148 409 L 1138 416 L 1141 424 L 1117 433 L 1117 440
    C 1142 444 1138 477 1174 495 L 1185 506 C 1229 520 1239 555 1237 582
    L 1233 602 L 1230 639 L 1256 662 C 1257 673 1240 679 1228 669
    L 1205 655 L 1200 635 L 1178 601 C 1144 605 1122 582 1118 562
    L 1080 528 L 1035 518 Z`, 2)
  paint('#00ffff', `M 1055 388 L 1053 374 L 1069 370 L 1067 360 L 1080 363
    L 1080 352 L 1098 359 L 1120 354 L 1114 365 L 1134 369 L 1127 378
    L 1144 395 L 1134 403 L 1148 409 L 1137 417 L 1141 424 L 1121 432
    L 1102 427 L 1108 414 L 1103 401 L 1093 390 L 1080 379 L 1066 388 Z`, 2)
  paint('#00ffff', `M 1157 510 C 1195 492 1222 495 1244 506
    L 1273 528 C 1235 531 1218 510 1200 519 L 1170 528 Z`)
  paint('#00ffff', `M 1387 503 C 1366 470 1299 469 1270 413
    C 1255 384 1246 348 1242 323 C 1268 326 1267 365 1307 375
    C 1355 381 1390 417 1402 445 C 1411 408 1462 405 1484 370
    C 1502 379 1506 427 1493 459 C 1476 486 1444 514 1448 537 Z`)
  paint('#00ffff', `M 1095 677 C 1115 652 1152 680 1188 705
    C 1284 769 1387 807 1474 813 C 1480 813 1484 815 1483 819
    C 1482 823 1475 827 1462 831 C 1437 840 1388 847 1349 843
    C 1241 834 1155 761 1118 716 Z`)
  if (!matte) {
    // The distal fin moves by 30px at the strongest upstroke. Its motion
    // support extends beyond the visible alpha so the tip rotates as one
    // surface instead of folding back where the original feather fades.
    ctx.filter = 'blur(10px)'
    paint('#00ffff', `M 1390 788 C 1430 774 1498 774 1516 797
      C 1534 831 1504 862 1467 868 L 1390 858 Z`)
  }
  return mask
}

export interface OceanMesh {
  vertices: Float32Array
  indices: Uint16Array
  foregroundIndices: Uint16Array
  matte: HTMLCanvasElement
}

/** Build the motion mesh once. Hair, the fin root and the curved belly have
 * closer-spaced vertices so their outlines survive the larger swimming stroke.
 * Nothing reads pixels or rebuilds geometry in the animation loop. */
export function createOceanMesh(doc: Document): OceanMesh | null {
  const mask = createOceanMask(doc)
  const matte = createOceanMask(doc, true)
  const ctx = mask?.getContext('2d')
  if (!ctx || !matte) return null
  const pixels = ctx.getImageData(0, 0, 1600, 900).data
  const axis = (end: number, details: [number, number, number][], anchors: number[]): number[] => {
    const values = new Set<number>([-32, end + 32, end, ...anchors])
    for (let n = 0; n < end; n += 16) values.add(n)
    for (const [start, stop, step] of details) for (let n = start; n <= stop; n += step) values.add(n)
    return [...values].sort((a, b) => a - b)
  }
  const xs = axis(1600, [[1040, 1160, 3], [1080, 1512, 8], [1390, 1482, 4], [1432, 1490, 2]], [1110, 1482, 1483])
  const ys = axis(900, [[336, 450, 3], [656, 856, 8], [632, 768, 4], [804, 842, 2]], [683, 815, 818, 822, 831])
  const vertices = new Float32Array(xs.length * ys.length * 9)
  const smooth = (low: number, high: number, value: number): number => {
    const t = Math.max(0, Math.min(1, (value - low) / (high - low)))
    return t * t * (3 - 2 * t)
  }
  const lobe = (x: number, y: number, cx: number, cy: number, rx: number, ry: number): number =>
    1 - smooth(.25, 1, ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2)
  let offset = 0
  for (const y of ys) for (const x of xs) {
    const pixel = (Math.round(Math.max(0, Math.min(899, y))) * 1600 + Math.round(Math.max(0, Math.min(1599, x)))) * 4
    const subject = pixels[pixel + 1] / 255
    // Three anchored hair regions: crown, rear tufts and the little fringe.
    // These weights deliberately do not use the broad silhouette feather.
    const crown = lobe(x, y, 1097, 359, 65, 40) * (1 - smooth(368, 391, y))
    const back = lobe(x, y, 1128, 403, 40, 47) * smooth(1103, 1140, x)
    const fringe = lobe(x, y, 1062, 374, 20, 20) * (1 - smooth(376, 392, y))
    const ribbon = lobe(x, y, 1224, 513, 79, 36) * smooth(1165, 1245, x)
    vertices.set([x, y, pixels[pixel] / 255 * (1 - subject), subject, pixels[pixel + 2] / 255, crown, back, fringe, ribbon], offset)
    offset += 9
  }
  const indices = new Uint16Array((xs.length - 1) * (ys.length - 1) * 6)
  const foregroundIndices: number[] = []
  offset = 0
  for (let y = 0; y < ys.length - 1; y++) for (let x = 0; x < xs.length - 1; x++) {
    const a = y * xs.length + x, b = a + 1, c = a + xs.length, d = c + 1
    indices.set([a, c, b, b, c, d], offset)
    if (xs[x + 1] >= 740 && xs[x] <= 1545 && ys[y + 1] >= 295 && ys[y] <= 865) {
      foregroundIndices.push(a, c, b, b, c, d)
    }
    offset += 6
  }
  return { vertices, indices, foregroundIndices: new Uint16Array(foregroundIndices), matte }
}

// Keep contact water and local flipper motion on the same pose as the rider.
const OCEAN_POSE_GLSL = `
vec2 turn(vec2 point, vec2 pivot, float angle) {
  float c = cos(angle), s = sin(angle);
  vec2 d = point - pivot;
  return pivot + vec2(c * d.x - s * d.y, s * d.x + c * d.y);
}
float softNoise(float time) {
  float cell = floor(time), f = fract(time);
  f = f * f * (3. - 2. * f);
  float a = fract(sin(cell * 127.1 + 17.) * 43758.5453);
  float b = fract(sin((cell + 1.) * 127.1 + 17.) * 43758.5453);
  return mix(a, b, f);
}
float swimPhase(float time) { return time * 1.12 + sin(time * .27) * .16; }
float finBend(float phase) { return -sin(phase - 1.05) * .073 + sin(phase * 2. - .5) * .011; }
vec2 bodyShift(float phase) { return vec2(sin(phase - .5) * 3., sin(phase - .55) * 8.5 + sin(phase * 2. + .4) * 1.2); }
vec2 whalePose(vec2 point, float phase, float amount) {
  return turn(point, vec2(1135., 650.), sin(phase - .9) * .0065 * amount) + bodyShift(phase) * amount;
}
vec2 inverseWhalePose(vec2 point, float phase, float amount) {
  return turn(point - bodyShift(phase) * amount, vec2(1135., 650.), -sin(phase - .9) * .0065 * amount);
}`

// Large-scene motion runs per mesh vertex; local collision foam is evaluated
// only in the small foreground contact regions, with early exits elsewhere.
export const OCEAN_VERTEX_SHADER = `
precision highp float;
attribute vec2 a_position;
attribute vec3 a_region;
attribute vec4 a_detail;
uniform vec2 u_viewport;
uniform vec4 u_bounds;
uniform vec2 u_pointer;
uniform vec3 u_ripples[3];
uniform float u_time;
uniform float u_amount;
uniform float u_layer;
varying vec2 v_uv;
varying float v_light;
varying float v_water;
const vec2 ART = vec2(1600., 900.);
${OCEAN_POSE_GLSL}
void main() {
  float fit = max(u_viewport.x / ART.x, u_viewport.y / ART.y);
  vec2 p = a_position / ART;
  float water = smoothstep(.57, .65, p.y);
  float sky = 1. - smoothstep(.43, .55, p.y);
  float nearWater = smoothstep(.57, 1., p.y);
  float onset = smoothstep(0., .55, u_time);
  float amount = u_amount * onset;
  // Slow gusts set the strength; shorter waves travel from hair roots to tips.
  float gust = .35 + softNoise(u_time * .24) * .85;
  float wind = gust * (.8 + sin(u_time * 1.3) * .2);
  float phase = swimPhase(u_time);
  float stroke = phase + sin(phase) * .18;
  vec2 position = a_position;
  vec2 flow = vec2(0.);
  v_uv = p;
  v_water = u_layer < .5 || u_layer > 1.5 ? water * nearWater : 0.;
  if (u_layer < .5 || u_layer > 1.5) {
    // Clean scenery can advect continuously: no foreground pixels get dragged
    // through the sky, and clouds never reverse at a sine-wave turning point.
    // Horizontal drift is sampled as separate whole cloud layers in the
    // fragment shader. A y-dependent UV velocity would keep accumulating
    // shear and turn the clouds into diagonal streaks after a few minutes.
    v_uv.y += sky * sin(u_time * .43 + p.x * 8.) * .0011 * amount;
    flow += water * vec2(
      sin(p.y * 45. - u_time * 1.4 + sin(p.x * 11. - u_time * .23)) * (1. + nearWater * 4.8),
      sin(p.x * 23. + p.y * 16. - u_time * 1.15) * (.7 + nearWater * 3.8));
    flow.y += water * nearWater * sin(p.x * 9. - u_time * .62) * 2.;
    flow += u_pointer * vec2(2., 1.1) * (.3 + nearWater * .5);
  } else {
    // The whole whale/rider keeps one rigid parent transform. Tail and fin
    // rotations happen around their own roots before that parent transform.
    float tail = (1. - smoothstep(480., 555., a_position.y)) * smoothstep(1200., 1230., a_position.x);
    tail *= max(1. - smoothstep(445., 485., a_position.y), smoothstep(1300., 1380., a_position.x));
    float tailAngle = (sin(stroke) + sin(stroke * 2. + .5) * .1) * .066 * amount;
    position = mix(position, turn(position, vec2(1395., 525.), tailAngle), tail);
    float fin = smoothstep(.025, .25, a_region.b) * smoothstep(630., 660., a_position.y - (a_position.x - 1100.) * .36);
    fin *= smoothstep(1070., 1110., a_position.x) * smoothstep(645., 680., a_position.y);
    float finAngle = finBend(phase) * amount;
    position = mix(position, turn(position, vec2(1110., 683.), finAngle), fin);
    flow += a_detail.x * vec2(wind * 10., sin(u_time * 1.9 + p.x * 23.) * 2.4 - wind * 2.);
    flow += a_detail.y * vec2(wind * 12., sin(u_time * 2.1 - a_position.y * .06) * 3.4 - wind * 2.5);
    flow += a_detail.z * vec2(wind * 3.5, sin(u_time * 1.9) * 1.7);
    flow += a_detail.w * vec2(wind * 3., sin(u_time * 2. - a_position.x * .028) * (8. + gust * 3.) + wind * 3.);
    position += flow * amount;
    position = whalePose(position, phase, amount);
    position += u_pointer * vec2(7., 3.2) * u_amount;
    flow = vec2(0.);
  }
  float glint = 0.;
  for (int i = 0; i < 3; i++) {
    vec3 ripple = u_ripples[i];
    if ((u_layer < .5 || u_layer > 1.5) && ripple.z < 2.5 && water > .01) {
      vec2 delta = (p - ripple.xy) * vec2(ART.x / ART.y, 1.);
      float ring = length(delta) - ripple.z * .042;
      float life = smoothstep(0., .18, ripple.z) * (1. - smoothstep(.8, 2.5, ripple.z));
      float wave = sin(ring * 240.) * exp(-abs(ring) * 95.) * life;
      flow += water * normalize(delta + vec2(.0001)) * wave * .8;
      glint += wave * .012 * water;
    }
  }
  vec2 screen = u_viewport - ART * fit + ((position / ART - .5) * 1.035 + .5) * ART * fit;
  screen += flow * amount * 1.035 * fit;
  vec2 clip = (screen - u_bounds.xy) / u_bounds.zw;
  gl_Position = vec4(clip.x * 2. - 1., 1. - clip.y * 2., 0., 1.);
  v_light = glint * u_amount;
}`

export const OCEAN_FRAGMENT_SHADER = `
precision highp float;
uniform sampler2D u_art;
uniform sampler2D u_matte;
uniform float u_layer;
uniform float u_time;
uniform float u_amount;
uniform vec2 u_pointer;
varying vec2 v_uv;
varying float v_light;
varying float v_water;
${OCEAN_POSE_GLSL}
float foamHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float foamNoise(vec2 p) {
  vec2 cell = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(foamHash(cell), foamHash(cell + vec2(1., 0.)), f.x),
    mix(foamHash(cell + vec2(0., 1.)), foamHash(cell + vec2(1.)), f.x), f.y);
}
float mirrorX(float value) { return 1. - abs(mod(value, 2.) - 1.); }
vec3 driftingCloud(vec2 uv, vec3 clearSky) {
  // Wrap through an irregular soft gap, rather than reflecting the edge cloud
  // into a conspicuous pair of identical "butterfly" shapes at the seam.
  float x = fract(uv.x);
  float feather = .11 + sin(uv.y * 19.) * .025;
  float edge = smoothstep(0., feather, x) * smoothstep(0., feather, 1. - x);
  return mix(clearSky, texture2D(u_art, vec2(x, clamp(uv.y, .001, .999))).rgb, edge);
}
vec3 flowingWater(vec2 uv) {
  float phase = fract(u_time / 9.);
  // Nearby water moves aft and toward the viewer faster than distant water,
  // giving the paddling whale forward travel instead of stationary bobbing.
  vec2 travel = vec2(-.03, -.014) * v_water * u_amount;
  vec2 first = uv + travel * phase, second = uv + travel * fract(phase + .5);
  first = vec2(mirrorX(first.x), clamp(first.y, .001, .999));
  second = vec2(mirrorX(second.x), clamp(second.y, .001, .999));
  return mix(texture2D(u_art, first).rgb, texture2D(u_art, second).rgb, abs(phase * 2. - 1.));
}
void main() {
  if (u_layer > 1.5) {
    vec2 art = v_uv * vec2(1600., 900.);
    if (art.y < 625. || art.y > 890.) discard;
    float onset = smoothstep(0., .55, u_time), amount = u_amount * onset;
    float phase = swimPhase(u_time);
    float pressure = pow(max(0., cos(phase - .9)), 2.);
    vec2 viewShift = u_pointer * vec2(7., 3.2) * u_amount;
    vec2 hull = inverseWhalePose(art - viewShift, phase, amount);

    // A fixed sea-surface strip establishes the front/back relation. The
    // collision foam below rises at contact, then leaves a broken aft trail.
    float line = 710. + (art.x - 900.) * .22 + sin(art.x * .037 - u_time * 1.4) * 2. + sin(art.x * .012 - u_time * .8) * 4.;
    float side = smoothstep(820., 880., art.x) * (1. - smoothstep(1190., 1280., art.x));
    float depth = smoothstep(line - 4., line + 7., art.y) * (1. - smoothstep(line + 22., line + 45., art.y));
    float waterAlpha = side * depth * .86;

    vec2 bowCenter = vec2(862. + bodyShift(phase).x * .65, 747. + bodyShift(phase).y * .18 + sin(phase - .2) * 2.);
    vec2 bow = art - bowCenter;
    vec2 bowSize = vec2(106. + pressure * 8., 39. + pressure * 7.);
    float bowRadius = length(bow / bowSize);
    float bowArc = smoothstep(.53, .79, bowRadius) * (1. - smoothstep(.99, 1.2, bowRadius));
    bowArc *= (1. - smoothstep(1., 15., bow.y)) * (1. - smoothstep(75., 108., bow.x));
    float bowSupport = step(756., art.x) * step(art.x, 1010.) * step(art.y, 790.);
    bowArc *= bowSupport;
    float bowLip = bowCenter.y - sqrt(max(0., 1. - (bow.x / bowSize.x) * (bow.x / bowSize.x))) * bowSize.y;
    float bowDepth = art.y - bowLip;
    float bowFilm = smoothstep(-3., 6., bowDepth) * (1. - smoothstep(24., 44., bowDepth))
      * smoothstep(760., 800., art.x) * (1. - smoothstep(965., 1005., art.x)) * bowSupport;
    waterAlpha = max(waterAlpha, bowFilm * (.45 + pressure * .45));

    // Follow the true curved right hull, with a narrow, intermittent water
    // film over the edge. This must not become a glowing outline around it.
    float y = clamp(hull.y, 625., 770.);
    float edgeX = 1470. - .0045 * (y - 625.) * (y - 625.) - .018 * max(0., y - 730.) * max(0., y - 730.);
    float edgeDistance = hull.x - edgeX;
    float rightGate = smoothstep(645., 672., hull.y) * (1. - smoothstep(745., 777., hull.y));
    float rightFilm = smoothstep(-12., -3., edgeDistance) * (1. - smoothstep(11., 29., edgeDistance)) * rightGate;
    waterAlpha = max(waterAlpha, rightFilm * (.2 + pressure * .24));
    float rightFoam = (1. - smoothstep(2., 10., abs(edgeDistance - 1.))) * rightGate;

    vec2 finTip = whalePose(turn(vec2(1466., 820.), vec2(1110., 683.), finBend(phase) * amount), phase, amount) + viewShift;
    vec2 finWakeDelta = art - finTip - vec2(10., 5.);
    float kick = pow(max(0., cos(phase - 4.8)), 4.);
    float finWake = 1. - smoothstep(.55, 1.14, length(finWakeDelta / vec2(55., 13.)));
    finWake *= kick;

    if (waterAlpha < .002 && bowArc < .002 && rightFoam < .002 && finWake < .002 && bowSupport < .5) discard;
    float grain = foamNoise(art * .16 + vec2(-u_time * 2.1, u_time * .55)) * .68
      + foamNoise(art * .37 + vec2(u_time * .7, 0.)) * .32;
    float broken = smoothstep(.24, .72, grain);
    float contactFocus = 1. - smoothstep(14., 85., abs(art.x - 916.));
    float foam = bowArc * (.22 + pressure * .6) * (.34 + broken * .66) * (.35 + contactFocus * .65);
    float trail = (1. - smoothstep(2., 8., abs(art.y - line - 2.)))
      * smoothstep(880., 920., art.x) * (1. - smoothstep(1040., 1110., art.x));
    foam = max(foam, trail * (.08 + pressure * .28) * broken);
    foam = max(foam, rightFoam * (.1 + pressure * .24) * broken);
    foam = max(foam, finWake * (.22 + broken * .36));

    // Six short-lived, unequal droplets leave the bow, fall under gravity,
    // and bend downwind. They never become a screen-wide snow or mist layer.
    float spray = 0.;
    if (bowSupport > .5) {
      float cycle = floor((phase - .82) / 6.2831853);
      float age = mod(phase - .82 + 6.2831853, 6.2831853) / 1.12;
      for (int i = 0; i < 6; i++) {
        float n = float(i), random = foamHash(vec2(n + 1., cycle));
          float life = .5 + random * .28, t = age - n * .018;
        if (t > 0. && t < life) {
          vec2 velocity = vec2(-108. + n * 17. + random * 10., -65. - random * 40.);
          vec2 origin = whalePose(vec2(920. + n * .7, 711.), phase, amount) + viewShift;
          vec2 drop = origin + velocity * t + vec2(95., 145.) * t * t;
          float size = 1.05 + random * 1.1;
          float shape = length((art - drop) / vec2(size * .75, size * (1.2 + t * .5)));
          float opacity = smoothstep(0., .045, t) * (1. - smoothstep(life * .55, life, t));
          spray = max(spray, (1. - smoothstep(.45, 1.2, shape)) * opacity * .68);
        }
      }
    }
    float alpha = max(waterAlpha, max(foam, spray)) * amount;
    if (alpha < .002) discard;
    vec3 color = flowingWater(v_uv) + v_light;
    vec3 cream = mix(vec3(.82, .91, .86), vec3(.95, .96, .88), .35 + grain * .65);
    color = mix(color, cream, clamp(foam * 1.5 + spray * 1.3, 0., .95));
    gl_FragColor = vec4(color, alpha);
  } else if (u_layer < .5) {
    // Two overlapping nine-second water flows hide the reset of either sample.
    // Cloud layers wrap through soft open-sky gaps without reversing.
    float cloud = 1. - smoothstep(.44, .52, v_uv.y);
    vec3 color = cloud < .999 ? flowingWater(v_uv) : vec3(0.);
    if (cloud > .001) {
      // Sampling toward the left moves the painted clouds to the right,
      // matching the breeze that pushes the rider's hair and waist ribbon.
      vec2 highCloud = vec2(v_uv.x - u_time * .0032 * u_amount, v_uv.y);
      vec2 lowCloud = vec2(v_uv.x - u_time * .0021 * u_amount, v_uv.y);
      vec3 clearSky = texture2D(u_art, vec2(.34, clamp(v_uv.y * .5, .001, .22))).rgb;
      vec3 sky = mix(driftingCloud(highCloud, clearSky), driftingCloud(lowCloud, clearSky), smoothstep(.25, .47, v_uv.y));
      color = mix(color, sky, cloud);
    }
    gl_FragColor = vec4(color + v_light, 1.);
  } else {
    vec2 uv = clamp(v_uv, .001, .999);
    gl_FragColor = vec4(texture2D(u_art, uv).rgb, texture2D(u_matte, uv).r);
  }
}`
