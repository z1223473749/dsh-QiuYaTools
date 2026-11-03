import { BULIANGREN_SCENE_DATA_URL, BULIANGREN_CLEAN_PLATE_DATA_URL } from './brand-assets.ts'
import { createLayeredSceneArt } from './layered-scene-art.ts'
import { installLandscapeScene } from './landscape-scene.ts'

// Registered to the approved 1672 × 941 painting. Only loose cloth and hair
// enter the moving mattes; the mask, hat, hands, belt and torso stay still.
export const BULIANGREN_CLOTH_PATHS = [
  `M 1290 500 C 1232 548 1193 575 1140 599
   C 1075 623 991 638 934 661 L 966 658 L 985 675
   C 1034 692 1085 654 1138 646 C 1080 682 1023 691 967 710
   C 901 733 873 763 819 800 L 868 783 L 899 769
   C 879 812 861 845 827 884 C 886 859 914 837 934 815
   C 928 861 912 896 896 924 C 955 893 973 878 994 858
   C 981 894 966 916 946 941 L 1174 941
   C 1234 838 1263 725 1294 613 L 1314 535 Z`,
  `M 1334 343 C 1325 394 1302 439 1266 467
   C 1235 490 1200 490 1163 502 C 1135 513 1118 529 1093 534
   L 1113 554 L 1109 576 C 1131 563 1132 548 1146 535
   C 1173 515 1201 518 1232 505 C 1296 480 1328 427 1345 370 Z`,
  `M 1309 611 C 1273 645 1237 673 1201 700
   C 1177 718 1152 724 1130 745 C 1167 733 1198 736 1225 715
   C 1264 682 1288 655 1320 626 Z`,
] as const

export const BULIANGREN_HAIR_PATHS = [
  `M 1421 208 C 1396 224 1382 238 1355 245
   C 1322 250 1290 257 1267 280 C 1297 262 1319 266 1347 257
   C 1319 274 1316 294 1293 306 C 1322 299 1333 278 1353 270
   C 1333 292 1323 309 1325 324 C 1337 301 1350 292 1367 282
   C 1350 309 1347 330 1327 347 C 1362 332 1364 304 1389 277
   C 1401 258 1416 237 1433 223 Z`,
] as const

// Blue matte selects actual soft cloud/fog pockets, away from the moon, face
// and architecture. Ambient texture moves locally rather than panning the city.
export const BULIANGREN_AIR_PATHS = [
  `M 0 0 H 1150 V 215 C 920 260 798 236 635 317
   C 370 369 195 357 0 432 Z`,
  `M 1090 0 H 1672 V 42 C 1510 20 1465 45 1360 40
   C 1220 14 1230 190 1120 220 Z`,
  `M 310 594 C 414 541 555 565 644 610 C 746 639 827 590 928 575
   C 980 573 1015 600 1022 632 C 916 643 880 680 751 689
   C 594 689 440 648 310 674 Z`,
  `M 314 782 C 458 744 613 743 718 762 C 764 780 800 800 826 831
   C 795 881 720 910 680 941 H 323 C 300 883 293 828 314 782 Z`,
] as const

export const BULIANGREN_FRAGMENT_SHADER = `precision highp float;
varying vec2 v_uv;
uniform sampler2D u_art,u_plate,u_matte;
uniform vec2 u_size,u_viewport,u_origin;
uniform float u_time,u_anchor;
vec2 clothWind(vec2 p){
  float loose=smoothstep(0.,1.,clamp((1345.-p.x)/450.,0.,1.));
  float ribbon=1.-smoothstep(570.,650.,p.y);
  float start=1.-exp(-u_time*1.5);
  return vec2(sin(u_time*1.25-p.y*.012)*12.,
    sin(u_time*1.65-p.x*.015+p.y*.004)*(28.+ribbon*14.))*loose*start;
}
vec2 hairWind(vec2 p){
  float loose=smoothstep(0.,1.,clamp((1430.-p.x)/160.,0.,1.));
  return vec2(sin(u_time*1.4-p.y*.025)*8.,sin(u_time*1.8-p.x*.025)*20.)*loose*(1.-exp(-u_time*1.5));
}
float cloudNoise(vec2 p){
  vec2 i=floor(p),f=fract(p);
  f=f*f*(3.-2.*f);
  vec4 h=fract(sin(vec4(dot(i,vec2(127.1,311.7)),dot(i+vec2(1.,0.),vec2(127.1,311.7)),
    dot(i+vec2(0.,1.),vec2(127.1,311.7)),dot(i+vec2(1.,1.),vec2(127.1,311.7))))*43758.5453);
  return mix(mix(h.x,h.y,f.x),mix(h.z,h.w,f.x),f.y);
}
float moonCloud(vec2 p){
  return cloudNoise(p)*.57+cloudNoise(p*2.03+17.)*.28+cloudNoise(p*4.1-9.)*.15;
}
void main(){
  vec2 source=vec2(1672.,941.);
  float fit=max(u_viewport.x/source.x,u_viewport.y/source.y);
  vec2 scaled=source*fit;
  vec2 offset=(u_viewport-scaled)*vec2(1.,u_anchor);
  vec2 uv=(u_origin+v_uv*u_size-offset)/scaled;
  vec2 p=uv*source;
  vec3 matte=texture2D(u_matte,uv).rgb;
  vec2 cloth=uv-clothWind(p)/source;
  vec2 hair=uv-hairWind(p)/source;
  vec3 original=texture2D(u_art,uv).rgb;
  float cloud=1.-smoothstep(360.,480.,p.y);
  float air=matte.b*(1.-max(matte.r,matte.g));
  // Let clouds travel around the moon without deforming its disc.
  air*=smoothstep(60.,90.,length(p-vec2(1283.,89.)));
  air*=1.-step(1275.,p.x)*step(45.,p.y)*(1.-step(220.,p.y));
  vec2 flow=vec2(sin(u_time*.42+p.y*.006)*(45.+cloud*45.),
    sin(u_time*.32+p.x*.005)*9.)*(1.-exp(-u_time*.8));
  vec3 movingAir=texture2D(u_art,uv-flow/source).rgb;
  vec3 base=mix(original,movingAir,air);
  // Gentle changing density makes the existing mist breathe without moving
  // roofs or introducing fog over the character's mask and body.
  float mist=air*(1.-cloud)*(.5+.5*sin(p.x*.009+p.y*.012-u_time*.9))*.15;
  base=mix(base,vec3(.42,.47,.51),mist);
  // A separate drifting cloud veil crosses the moon's stationary disc. The
  // original moon is never resampled or warped; only the foreground cloud's
  // density and lit wisps move. Feathered bounds keep it off the hat and face.
  float moonArea=smoothstep(1020.,1100.,p.x)*(1.-smoothstep(1315.,1360.,p.x))
    *smoothstep(0.,18.,p.y)*(1.-smoothstep(160.,205.,p.y));
  vec2 cloudPoint=vec2(p.x*.017-u_time*.48,p.y*.035+sin(u_time*.24)*.18);
  float wisps=smoothstep(.33,.72,moonCloud(cloudPoint));
  float band=.45+.55*(.5+.5*sin(p.y*.048-u_time*.28));
  float veil=moonArea*wisps*band*.62;
  float moonLight=1.-smoothstep(40.,150.,length(p-vec2(1283.,89.)));
  base=mix(base,mix(vec3(.105,.135,.17),vec3(.32,.31,.28),moonLight*.55),veil);
  base=mix(base,texture2D(u_plate,uv).rgb,max(matte.r,matte.g));
  base=mix(base,texture2D(u_art,cloth).rgb,texture2D(u_matte,cloth).r);
  base=mix(base,texture2D(u_art,hair).rgb,texture2D(u_matte,hair).g);
  // Protect the face even where loose hair emerges beside the mask.
  float face=step(1398.,p.x)*(1.-step(1500.,p.x))*step(120.,p.y)*(1.-step(240.,p.y));
  base=mix(base,original,face);
  gl_FragColor=vec4(base,1.);
}`

export function createBuliangrenArt(doc: Document) {
  return createLayeredSceneArt(doc, {
    width: 1672, height: 941, marker: 'data-qyt-buliangren-art',
    art: BULIANGREN_SCENE_DATA_URL, plate: BULIANGREN_CLEAN_PLATE_DATA_URL,
    fragmentShader: BULIANGREN_FRAGMENT_SHADER,
    regions: [
      { color: '#00f', paths: BULIANGREN_AIR_PATHS, blur: 28 },
      { color: '#f00', paths: BULIANGREN_CLOTH_PATHS, blur: .8 },
      { color: '#0f0', paths: BULIANGREN_HAIR_PATHS, blur: .6 },
    ],
  })
}

export function installBuliangrenScene(doc: Document): () => void {
  return installLandscapeScene(doc, {
    movement: 'none', atmosphere: 'petals', atmosphereColor: '#cb4937',
    particleStyle: { shape: 'maple', count: 36, speed: 2.8 }, intensity: .78, speed: 1.05,
    position: 'right bottom', createArt: createBuliangrenArt,
  })
}
