/** Coordinates belong to the packaged 1600 × 900 illustration, not the UI.
 * R: water, G: rider/whale, B: flexible details. Soft mask edges let the
 * original brush strokes move together without cutting the painting apart. */
export function createOceanMask(doc: Document): HTMLCanvasElement | null {
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
  ctx.fillStyle = horizon
  ctx.fillRect(0, 507, 1600, 393)
  // The transition must be wider than the largest displacement. Otherwise
  // clouds and a thin fin can sample opposite sides of the same outline and
  // fold the tip inward. This is a motion field, not a hard cutout alpha mask.
  ctx.filter = 'blur(18px)'
  const paint = (color: string, path: string): void => {
    ctx.fillStyle = color
    ctx.fill(new win.Path2D(path))
  }
  paint('#00ff00', `M 827 592 C 814 552 860 513 912 506 C 963 493 1006 511 1040 511
    L 1146 525 C 1218 547 1280 589 1341 573 C 1409 557 1405 518 1382 488
    C 1346 464 1293 463 1268 410 C 1252 383 1246 348 1242 323
    C 1268 326 1267 365 1307 375 C 1355 381 1390 417 1402 445
    C 1411 408 1462 405 1484 370 C 1502 379 1506 427 1493 459
    C 1474 493 1445 513 1452 551 C 1474 588 1478 649 1457 697
    C 1437 750 1380 772 1347 775 C 1388 799 1430 810 1482 815
    C 1473 844 1389 849 1349 843 C 1281 840 1242 807 1207 780
    C 1136 788 1072 779 1001 753 C 919 724 852 660 827 592 Z`)
  paint('#00ff00', `M 1011 510 L 1030 487 C 1038 477 1039 447 1053 435
    L 1067 428 L 1066 416 C 1049 410 1055 392 1058 387
    L 1052 373 L 1073 362 L 1077 351 L 1094 356 L 1117 353
    L 1115 360 L 1134 368 L 1130 379 L 1144 394 L 1136 401
    L 1148 409 L 1138 416 L 1141 424 L 1117 433 L 1117 440
    C 1142 444 1138 477 1174 495 L 1185 506 C 1229 520 1239 555 1237 582
    L 1233 602 L 1230 639 L 1256 662 C 1257 673 1240 679 1228 669
    L 1205 655 L 1200 635 L 1178 601 C 1144 605 1122 582 1118 562
    L 1080 528 L 1035 518 Z`)
  paint('#00ffff', `M 1055 388 L 1053 374 L 1069 370 L 1067 360 L 1080 363
    L 1080 352 L 1098 359 L 1120 354 L 1114 365 L 1134 369 L 1127 378
    L 1144 395 L 1134 403 L 1148 409 L 1137 417 L 1141 424 L 1121 432
    L 1102 427 L 1108 414 L 1103 401 L 1093 390 L 1080 379 L 1066 388 Z`)
  paint('#00ffff', `M 1157 510 C 1195 492 1222 495 1244 506
    L 1273 528 C 1235 531 1218 510 1200 519 L 1170 528 Z`)
  paint('#00ffff', `M 1387 503 C 1366 470 1299 469 1270 413
    C 1255 384 1246 348 1242 323 C 1268 326 1267 365 1307 375
    C 1355 381 1390 417 1402 445 C 1411 408 1462 405 1484 370
    C 1502 379 1506 427 1493 459 C 1476 486 1444 514 1448 537 Z`)
  paint('#00ffff', `M 1095 677 C 1115 652 1152 680 1188 705
    C 1284 769 1387 807 1482 815 C 1473 844 1389 849 1349 843
    C 1241 834 1155 761 1118 716 Z`)
  return mask
}

export interface OceanMesh {
  vertices: Float32Array
  indices: Uint16Array
}

/** Build the motion mesh once. The extra vertices around the hair retain each
 * tuft's outline; moving tips have separate weights from the pinned roots and
 * the face. Nothing reads pixels or rebuilds geometry in the animation loop. */
export function createOceanMesh(doc: Document): OceanMesh | null {
  const mask = createOceanMask(doc)
  const ctx = mask?.getContext('2d')
  if (!ctx) return null
  const pixels = ctx.getImageData(0, 0, 1600, 900).data
  const axis = (end: number, detailStart: number, detailEnd: number): number[] => {
    const values = new Set<number>([-32, end + 32, end])
    for (let n = 0; n < end; n += 16) values.add(n)
    for (let n = detailStart; n <= detailEnd; n += 3) values.add(n)
    return [...values].sort((a, b) => a - b)
  }
  const xs = axis(1600, 1040, 1160), ys = axis(900, 336, 450)
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
  offset = 0
  for (let y = 0; y < ys.length - 1; y++) for (let x = 0; x < xs.length - 1; x++) {
    const a = y * xs.length + x, b = a + 1, c = a + xs.length, d = c + 1
    indices.set([a, c, b, b, c, d], offset)
    offset += 6
  }
  return { vertices, indices }
}

// All wind/water calculations run per mesh vertex. The old shader did this
// work for every pixel, including the three ripple exponentials while idle.
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
varying vec2 v_uv;
varying float v_light;
const vec2 ART = vec2(1600., 900.);
void main() {
  float fit = max(u_viewport.x / ART.x, u_viewport.y / ART.y);
  vec2 p = a_position / ART;
  float water = a_region.r;
  float subject = a_region.g;
  float sky = (1. - smoothstep(.47, .58, p.y)) * (1. - subject);
  float nearWater = smoothstep(.57, 1., p.y);
  float wind = .55 + sin(u_time * .7) * .36 + sin(u_time * 1.3 + 1.) * .12;
  vec2 flow = vec2(0.);
  // Displacements are in original-art pixels, before cover and overscan.
  float hairArea = max(a_detail.x, max(a_detail.y, a_detail.z));
  flow += sky * (1. - hairArea) * vec2(sin(u_time * .12 + p.y * 5.) * 9., sin(u_time * .19 + p.x * 6.) * 1.1);
  flow += water * vec2(
    sin(p.y * 49. - u_time * 1.05 + sin(p.x * 10. + u_time * .3)) * (.8 + nearWater * 3.),
    sin(p.x * 29. + p.y * 17. - u_time * .9) * (.35 + nearWater * 2.));
  float bob = sin(u_time * .72) * 2.1 + sin(u_time * 1.13) * .4;
  flow += subject * vec2(sin(u_time * .36) * 1.2, bob);
  flow += a_detail.x * vec2(wind * 7.5, sin(u_time * 1.8 + p.x * 23.) * 1.6 - wind * 1.5);
  flow += a_detail.y * vec2(wind * 9., sin(u_time * 1.8 - a_position.y * .055) * 2.4 - wind * 2.);
  flow += a_detail.z * vec2(wind * 2.8, sin(u_time * 1.8) * 1.2);
  flow += a_detail.w * vec2(wind * 2., sin(u_time * 1.8 - a_position.x * .024) * 7. + wind * 2.);
  float tail = a_region.b * smoothstep(1235., 1375., a_position.x) * (1. - smoothstep(489., 550., a_position.y));
  float fin = a_region.b * smoothstep(655., 713., a_position.y);
  flow += tail * vec2(sin(u_time * .72 - .7) * 1.8, sin(u_time * .72 - .7) * 3.);
  flow.y += fin * sin(u_time * .72 - 1.1) * 2.1 * smoothstep(1100., 1460., a_position.x);
  vec2 parallax = u_pointer * vec2(7., 2.8) * (.22 + subject * .5 + water * nearWater * .8);
  float glint = 0.;
  for (int i = 0; i < 3; i++) {
    vec3 ripple = u_ripples[i];
    if (ripple.z < 2.5 && water > .01) {
      vec2 delta = (p - ripple.xy) * vec2(ART.x / ART.y, 1.);
      float ring = length(delta) - ripple.z * .042;
      float life = smoothstep(0., .18, ripple.z) * (1. - smoothstep(.8, 2.5, ripple.z));
      float wave = sin(ring * 240.) * exp(-abs(ring) * 95.) * life;
      flow += water * normalize(delta + vec2(.0001)) * wave * .8;
      glint += wave * .012 * water;
    }
  }
  vec2 screen = u_viewport - ART * fit + ((p - .5) * 1.035 + .5) * ART * fit;
  screen += (flow + parallax) * u_amount * 1.035 * fit;
  vec2 clip = (screen - u_bounds.xy) / u_bounds.zw;
  gl_Position = vec4(clip.x * 2. - 1., 1. - clip.y * 2., 0., 1.);
  v_uv = clamp(p, .001, .999);
  v_light = glint * u_amount;
}`

export const OCEAN_FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_art;
varying vec2 v_uv;
varying float v_light;
void main() {
  gl_FragColor = vec4(texture2D(u_art, v_uv).rgb + v_light, 1.);
}`
