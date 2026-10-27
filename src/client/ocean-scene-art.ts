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

export const OCEAN_VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_position.x * .5 + .5, .5 - a_position.y * .5);
  gl_Position = vec4(a_position, 0., 1.);
}`

export const OCEAN_FRAGMENT_SHADER = `
precision highp float;
uniform sampler2D u_art;
uniform sampler2D u_mask;
uniform vec2 u_viewport;
uniform vec4 u_bounds;
uniform vec2 u_pointer;
uniform vec3 u_ripples[3];
uniform float u_time;
uniform float u_amount;
varying vec2 v_uv;
const vec2 ART = vec2(1600., 900.);
void main() {
  float fit = max(u_viewport.x / ART.x, u_viewport.y / ART.y);
  vec2 p = (u_bounds.xy + v_uv * u_bounds.zw - u_viewport + ART * fit) / (ART * fit);
  // A small overscan reserves room for parallax at all four edges.
  p = (p - .5) / 1.035 + .5;
  vec3 region = texture2D(u_mask, p).rgb;
  float water = region.r * (1. - region.g);
  float subject = region.g;
  float sky = (1. - smoothstep(.47, .58, p.y)) * (1. - subject);
  float nearWater = smoothstep(.57, 1., p.y);
  float wind = sin(u_time * .43) * .65 + sin(u_time * .91 + .7) * .35;
  vec2 flow = vec2(0.);
  // Coherent wind, with a different scale and response for each material.
  flow += sky * vec2(sin(u_time * .12 + p.y * 5.) * .007, sin(u_time * .19 + p.x * 6.) * .0014);
  flow += water * vec2(
    sin(p.y * 57. - u_time * 1.15 + sin(p.x * 12. + u_time * .35)) * (.001 + nearWater * .003),
    sin(p.x * 33. + p.y * 20. - u_time * .95) * (.0005 + nearWater * .0024));
  float bob = sin(u_time * .72) * .0027 + sin(u_time * 1.13) * .0006;
  flow += subject * vec2(sin(u_time * .36) * .0011, bob);
  vec2 detail = p * ART;
  float hair = region.b * (1. - smoothstep(424., 445., detail.y)) * (1. - smoothstep(1140., 1170., detail.x));
  float ribbon = region.b * smoothstep(1168., 1220., detail.x) *
    (1. - smoothstep(1270., 1290., detail.x)) *
    (1. - smoothstep(530., 551., detail.y)) * smoothstep(468., 490., detail.y);
  float tail = region.b * smoothstep(1235., 1375., detail.x) * (1. - smoothstep(489., 550., detail.y));
  float fin = region.b * smoothstep(655., 713., detail.y);
  flow += hair * vec2(wind * .0015 * smoothstep(1070., 1143., detail.x), sin(u_time * 1.6 + detail.x * .025) * .0009);
  flow.y += ribbon * (wind * .0034 + sin(u_time * 2. + detail.x * .024) * .0015);
  flow += tail * vec2(sin(u_time * .72 - .7) * .0015, sin(u_time * .72 - .7) * .0035);
  flow.y += fin * sin(u_time * .72 - 1.1) * .0028 * smoothstep(1100., 1460., detail.x);
  vec2 parallax = u_pointer * vec2(.005, .0032) * (.22 + subject * .5 + water * nearWater * .8);
  float glint = 0.;
  for (int i = 0; i < 3; i++) {
    vec3 ripple = u_ripples[i];
    vec2 delta = (p - ripple.xy) * vec2(ART.x / ART.y, 1.);
    float radius = length(delta);
    float ring = radius - ripple.z * .042;
    float life = smoothstep(0., .18, ripple.z) * (1. - smoothstep(.8, 2.5, ripple.z));
    float wave = sin(ring * 240.) * exp(-abs(ring) * 95.) * life;
    flow += water * normalize(delta + vec2(.0001)) * wave * .00085;
    glint += wave * .025 * water;
  }
  vec2 uv = clamp(p + (flow + parallax) * u_amount, .001, .999);
  vec3 color = texture2D(u_art, uv).rgb;
  float light = sin(p.x * 73. + p.y * 121. - u_time * .8) * sin(p.y * 93. + u_time * .53);
  color += (light * .012 * water * nearWater + glint) * u_amount;
  gl_FragColor = vec4(color, 1.);
}`
