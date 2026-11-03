import { MOONFROST_SCENE_DATA_URL, MOONFROST_CLEAN_PLATE_DATA_URL } from './brand-assets.ts'
import { installLandscapeScene } from './landscape-scene.ts'
import { createLayeredSceneArt } from './layered-scene-art.ts'

// Only the loose train, trailing silk and hair tips enter these mattes. The head, hands,
// bodice, exposed legs and heels always come from the original still image.
export const MOONFROST_CLOTH_PATHS = [
  `M 1226 352 C 1205 414 1181 459 1148 498
   C 1087 540 1045 551 1006 565 C 956 589 927 613 892 636
   C 847 663 800 682 792 706 L 810 754 L 774 789
   C 742 814 704 840 624 852 C 680 871 732 856 781 872
   C 860 884 940 864 1008 866 C 1070 868 1120 841 1151 807
   C 1138 785 1137 762 1152 737 C 1173 681 1185 631 1203 577
   C 1220 523 1233 471 1241 422 Z`,
  `M 1198 355 C 1158 395 1117 428 1076 429
   C 1031 433 1007 406 974 400 C 948 397 923 407 895 403
   C 923 415 942 414 962 414 C 1012 433 1032 451 1074 445
   C 1124 437 1159 409 1205 376 Z`,
  `M 1126 465 C 1061 495 1020 502 989 500
   C 951 495 917 482 881 491 C 918 491 945 509 980 514
   C 1034 519 1078 501 1139 482 Z`,
] as const

export const MOONFROST_HAIR_PATH = `M 1216 181
 C 1180 213 1140 204 1095 199 C 1053 192 1008 211 982 238
 C 1024 214 1055 212 1090 225 C 1050 236 1011 253 1001 285
 C 990 313 1008 327 1030 336 C 1005 312 1009 291 1036 274
 C 1045 265 1068 256 1092 251 C 1059 280 1045 309 1061 342
 C 1062 362 1077 382 1097 386 C 1074 354 1072 331 1092 308
 C 1128 291 1165 280 1190 259 L 1216 220 Z`

export const MOONFROST_FRAGMENT_SHADER = `precision highp float;
varying vec2 v_uv;
uniform sampler2D u_art,u_plate,u_matte;
uniform vec2 u_size,u_viewport,u_origin;
uniform float u_time,u_anchor;
vec2 wind(vec2 p){
  // Waist attachment stays fixed; increasingly loose fabric receives a
  // traveling wave, rather than translating or warping the whole figure.
  float loose=smoothstep(0.,1.,clamp((1238.-p.x)/550.,0.,1.));
  float wave=sin(u_time*1.8-p.x*.013+p.y*.004);
  return vec2(sin(u_time*1.45-p.y*.016)*18.,wave*42.+sin(u_time*2.1-p.x*.025)*7.)*loose;
}
vec2 hairWind(vec2 p){
  float loose=smoothstep(0.,1.,clamp((1218.-p.x)/230.,0.,1.));
  return vec2(sin(u_time*1.7-p.y*.018)*12.,sin(u_time*2.-p.x*.02)*22.)*loose;
}
void main(){
  vec2 source=vec2(1672.,941.);
  float fit=max(u_viewport.x/source.x,u_viewport.y/source.y);
  vec2 scaled=source*fit;
  vec2 offset=(u_viewport-scaled)*vec2(1.,u_anchor);
  vec2 uv=(u_origin+v_uv*u_size-offset)/scaled;
  vec2 p=uv*source;
  vec2 warped=uv-wind(p)/source;
  vec2 hair=uv-hairWind(p)/source;
  // Original cloth is erased over a registered clean plate before the moving
  // cloth is composited. This prevents a second, stationary hem underneath.
  vec2 matte=texture2D(u_matte,uv).rg;
  float erase=max(matte.r,matte.g);
  float alpha=texture2D(u_matte,warped).r;
  vec3 base=mix(texture2D(u_art,uv).rgb,texture2D(u_plate,uv).rgb,erase);
  base=mix(base,texture2D(u_art,warped).rgb,alpha);
  gl_FragColor=vec4(mix(base,texture2D(u_art,hair).rgb,texture2D(u_matte,hair).g),1.);
}`

/** Reuse the registered-art renderer and the shared landscape lifecycle. */
export function createMoonfrostArt(doc: Document) {
  return createLayeredSceneArt(doc, {
    width: 1672, height: 941, marker: 'data-qyt-moonfrost-cloth',
    art: MOONFROST_SCENE_DATA_URL, plate: MOONFROST_CLEAN_PLATE_DATA_URL,
    fragmentShader: MOONFROST_FRAGMENT_SHADER,
    regions: [{ color: '#f00', paths: MOONFROST_CLOTH_PATHS }, { color: '#0f0', paths: [MOONFROST_HAIR_PATH] }],
  })
}

export function installMoonfrostScene(doc: Document): () => void {
  return installLandscapeScene(doc, { movement: 'none', atmosphere: 'snow', intensity: .8, speed: 1.05, position: 'right bottom', createArt: createMoonfrostArt })
}
