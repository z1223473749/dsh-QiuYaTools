"""Extract the painted poses from the approved full-size Bluefish sheets.

Run with the original PNG directory as the argument and Pillow, NumPy and
OpenCV installed. Runtime builds only need the generated WebP and landmarks.
Landmarks are in local sheet-cell pixels before placement on the stage.
"""
import json
from pathlib import Path
import sys

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ORIGINALS = Path(sys.argv[1])
CELL = 512
COLS = 7
# Left/right eyes, mouth, hair crown, bow, ear, tail fork, collar, hips,
# leading wrist, trailing wrist, leading shoe sole, trailing shoe sole.
poses = {}
cells = []


def sheet(prefix):
    return Image.open(next(ORIGINALS.glob(f'exec-{prefix}*.png'))).convert('RGBA')


def matte(cell, chase=False):
    rgba = np.array(cell)
    if chase:
        rgb = rgba[:, :, :3].astype(np.float32)
        # The chase storyboard is printed on pale blue. Keep highlights
        # inside the connected painted silhouette, including its lace.
        background = np.median(rgb[55:445, 82:106], axis=(0, 1))
        delta = np.linalg.norm(rgb - background, axis=2)
        seed = (delta > 27).astype(np.uint8)
        seed[:, :66] = 0
        seed[:, 505:] = 0
        seed[:16] = 0
        # Retain the soles. The plate shadow, panel rules and butterfly
        # have their own runtime drawings.
        return rgba, seed, delta
    return rgba, (rgba[:, :, 3] > 105).astype(np.uint8), None


def extract(cell, name, pins, floor, size=.85, center=None, origin=None, chase=False, edge=None):
    rgba, seed, delta = matte(cell, chase)
    if chase:
        # Clip only the painted ground ellipse, below the marked soles.
        for x in range(rgba.shape[1]):
            bottom = np.interp(x, *zip(*edge))
            seed[int(bottom):, x] = 0
    _, labels, stats, _ = cv2.connectedComponentsWithStats(seed)
    core = (labels == 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])).astype(np.uint8)
    if chase:
        core = cv2.morphologyEx(core, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        # Restore light details enclosed by the character without filling
        # the larger negative spaces between the hair and tail.
        count, holes, areas, _ = cv2.connectedComponentsWithStats(1 - core)
        for i in range(1, count):
            if areas[i, cv2.CC_STAT_AREA] < 720:
                core[holes == i] = 1
        inside = cv2.distanceTransform(core, cv2.DIST_L2, 5)
        outside = cv2.distanceTransform(1 - core, cv2.DIST_L2, 5)
        rgba[:, :, 3] = np.clip(.5 + (inside - outside) * .39, 0, 1) * 255
    else:
        edge_mask = cv2.dilate(core, np.ones((5, 5), np.uint8))
        rgba[:, :, 3] = np.clip((rgba[:, :, 3].astype(float) - 23) * 255 / 223, 0, 255) * edge_mask
    cx = center if center is not None else pins[2][0]
    ox, oy = round(220 - cx * size), round(463 - floor * size)
    image = Image.fromarray(rgba).resize((round(cell.width * size), round(cell.height * size)), Image.Resampling.LANCZOS)
    stage = Image.new('RGBA', (CELL, CELL))
    stage.paste(image, (ox, oy))
    transform = lambda p: [round(p[0] * size + ox, 2), round(p[1] * size + oy, 2)]
    poses[name] = {'cell': len(cells), 'pins': [transform(p) for p in pins]}
    if origin:
        poses[name]['origin'] = transform(origin)
    cells.append(stage)


def grid(source, names, landmarks, floors, *, size=.85, centers=None, origins=None, chase_edges=None):
    pitch = source.width // 3
    for i, name in enumerate(names):
        col, row = i % 3, i // 3
        cell = source.crop((col * pitch, row * pitch, (col + 1) * pitch, (row + 1) * pitch))
        extract(cell, name, list(zip(landmarks[i][::2], landmarks[i][1::2])), floors[i],
                size, centers[i] if centers else None, origins[i] if origins else None,
                chase_edges is not None, chase_edges[i] if chase_edges else None)


grid(Image.open(ROOT / 'artifacts/ocean-scene/bluefish-chase-prototype.png').convert('RGBA'),
     ['discover','plant','step','jump','reach','land'], [
         [230,238, 282,244, 255,271, 262,145, 358,177, 397,244, 456,229, 280,308, 279,377, 265,431, 292,432, 200,450, 344,451],
         [181,213, 231,219, 211,246, 226,123, 305,150, 347,214, 432,177, 241,281, 276,333, 206,319, 262,326, 232,448, 288,448],
         [186,186, 233,192, 211,222, 229,105, 314,146, 355,204, 432,160, 248,257, 281,322, 131,270, 357,290, 173,444, 387,444],
         [199,165, 257,180, 222,207, 234,81, 336,141, 360,205, 425,155, 252,256, 279,322, 145,225, 367,275, 181,400, 308,425],
         [173,164, 222,176, 190,200, 214,82, 309,141, 347,203, 436,169, 227,253, 260,332, 89,205, 340,276, 178,425, 329,416],
         [203,183, 251,197, 222,223, 233,103, 339,163, 374,225, 426,196, 255,273, 291,345, 145,283, 362,333, 182,461, 343,463],
     ], [454,451,451,463,463,466], size=.93, centers=[278,266,281,279,260,291],
     chase_edges=[
        [(0,443),(170,443),(185,453),(220,455),(241,449),(315,452),(345,459),(376,445),(512,444)],
        [(0,444),(202,444),(210,451),(322,452),(332,444),(512,444)],
        [(0,443),(144,443),(164,450),(194,445),(360,442),(399,449),(412,443),(512,443)],
        [(0,448),(512,448)], [(0,451),(512,451)],
        [(0,455),(146,455),(152,466),(219,466),(231,454),(310,454),(323,465),(373,465),(382,455),(512,455)],
     ])
# Remove the independent butterfly from panel five. Her extended fingertips
# are to its right and are part of the main painted silhouette.

rice_base = [202,203, 269,208, 235,235, 243,104, 355,150, 382,231, 457,213, 250,283, 249,393, 170,304, 273,343, 204,468, 256,468]
def pins(base, changes):
    values = base.copy()
    for index, (x, y) in changes.items():
        values[2*index:2*index+2] = [x, y]
    return values

grid(sheet('b4edd26a'), ['idle','pinch','offer','bite','chew','swallow'], [
    rice_base, pins(rice_base,{9:(155,302)}), pins(rice_base,{2:(215,245),9:(129,287)}),
    pins(rice_base,{9:(169,277)}), pins(rice_base,{0:(183,200),1:(263,204),2:(214,230),9:(140,307)}),
    pins(rice_base,{9:(153,303)}),
], [469]*6, centers=[237,222,218,237,222,218])

grid(sheet('96db23a8'), ['crouch','stand','walkA','walkB','walkC','walkD'], [
    [154,213, 216,218, 180,243, 191,106, 298,154, 321,222, 408,211, 198,273, 213,370, 176,320, 234,325, 195,469, 247,470],
    [154,169, 209,174, 177,199, 198,82, 288,136, 317,211, 398,198, 184,237, 201,349, 151,285, 206,291, 165,470, 242,471],
    [129,183, 187,188, 154,210, 160,93, 275,147, 302,216, 392,198, 173,248, 196,355, 120,299, 177,304, 102,473, 291,470],
    [150,682-512, 205,687-512, 170,710-512, 188,91, 288,131, 310,201, 401,179, 174,229, 200,341, 137,277, 193,284, 184,471, 258,439],
    [128,167, 185,175, 151,198, 168,82, 275,134, 298,201, 396,190, 164,233, 190,342, 115,279, 169,286, 93,471, 315,470],
    [123,171, 182,180, 148,201, 161,82, 269,135, 292,204, 387,186, 158,234, 182,340, 119,283, 168,286, 167,473, 204,441],
], [472,473,478,474,476,476], centers=[215,205,195,201,190,183])

grid(sheet('dc064f75'), ['bedside','knee','climb','lie','pull','sleep'], [
    [190,207, 247,200, 223,234, 216,109, 109,147, 84,219, 43,217, 218,278, 191,362, 119,341, 270,343, 165,454, 198,454],
    [245,210, 298,198, 278,234, 262,107, 160,152, 132,224, 68,217, 269,272, 203,338, 254,357, 294,350, 158,456, 194,360],
    [268,207, 319,196, 299,230, 278,109, 181,151, 149,221, 93,212, 290,273, 243,331, 292,304, 336,290, 208,364, 254,365],
    [261,207, 330,228, 285,236, 313,129, 238,151, 201,196, 125,193, 275,278, 228,330, 228,294, 274,308, 125,416, 300,423],
    [269,217, 337,234, 298,244, 315,128, 242,156, 207,200, 128,199, 286,276, 228,329, 241,271, 316,279, 125,415, 301,421],
    [278,222, 340,248, 302,251, 325,144, 252,164, 211,207, 120,204, 291,275, 229,329, 242,273, 316,282, 125,415, 301,421],
], [492,492,492,487,487,487], centers=[252]*6)

desk_base = [202,206, 271,211, 236,237, 243,102, 354,145, 380,226, 453,207, 251,286, 248,403, 158,342, 280,367, 213,482, 269,482]
grid(sheet('e31eb922'), ['clear','fetch','closedBook','openBook','write','doze'], [
    pins(desk_base,{9:(125,378),10:(150,428)}),
    pins(desk_base,{9:(214,319),10:(302,337)}),
    pins(desk_base,{9:(185,317),10:(285,382)}),
    pins(desk_base,{9:(180,314),10:(280,382)}),
    pins(desk_base,{9:(218,327),10:(286,382)}),
    pins(desk_base,{0:(196,220),1:(274,225),9:(227,383),10:(262,384)}),
], [485]*6, centers=[237,237,237,237,237,237])

grid(sheet('935c5784'), ['gunLap','gunAim','gunFire','wandLap','wandAim','wandBlow'], [
    pins(desk_base,{9:(206,322),10:(294,367)}),
    pins(desk_base,{9:(146,312),10:(183,333)}),
    pins(desk_base,{2:(233,245),9:(150,301),10:(181,321)}),
    pins(desk_base,{9:(183,339),10:(266,375)}),
    pins(desk_base,{9:(167,302),10:(269,375)}),
    pins(desk_base,{9:(168,301),10:(271,373)}),
], [487]*6, centers=[235]*6, origins=[(191,343),(114,282),(105,263),(183,289),(194,248),(195,244)])

run_gun = [153,207, 214,213, 179,239, 191,108, 296,150, 321,226, 407,213, 198,277, 204,366, 114,285, 157,296, 185,478, 257,478]
run_wand = pins(run_gun,{0:(153,171),1:(207,177),2:(170,204),3:(188,101),4:(288,140),5:(317,213),6:(404,192),7:(190,244),9:(113,260),10:(205,298),11:(178,485),12:(253,485)})
grid(sheet('4f7f6bd1'), ['gunRun0','gunRun1','gunRun2','wandRun0','wandRun1','wandRun2'], [
    run_gun,
    pins(run_gun,{0:(150,167),1:(208,175),2:(173,203),3:(191,80),4:(289,135),5:(315,212),7:(194,241),9:(113,263),10:(154,277),11:(98,476),12:(299,475)}),
    pins(run_gun,{0:(131,182),1:(195,187),2:(160,213),3:(172,87),4:(270,138),5:(298,219),7:(181,251),9:(99,268),10:(136,281),11:(106,446),12:(289,478)}),
    run_wand,
    pins(run_wand,{0:(133,168),1:(188,173),2:(151,201),9:(100,253),10:(200,294),11:(76,482),12:(312,485)}),
    pins(run_wand,{0:(126,172),1:(184,177),2:(148,206),3:(173,91),9:(99,255),10:(187,294),11:(129,454),12:(278,485)}),
], [482,482,482,487,487,487], centers=[205,194,180,199,185,176],
     origins=[(81,251),(85,230),(62,233),(132,213),(116,207),(114,207)])

meal_base = [163,165, 217,166, 190,192, 202,73, 285,109, 314,188, 375,157, 206,228, 191,328, 123,247, 227,290, 161,391, 212,391]
meal_pins = [
    meal_base, pins(meal_base,{2:(186,201),9:(135,235)}), pins(meal_base,{2:(186,185),9:(118,249)}),
]
grid(sheet('8c857f0e'), [f'{food}{i}' for food in ['pork','eggs','cookies'] for i in range(3)],
     meal_pins * 3, [395]*9, size=1.025, centers=[191,188,185]*3)

atlas = Image.new('RGBA', (COLS * CELL, ((len(cells) + COLS - 1) // COLS) * CELL))
for i, stage in enumerate(cells):
    atlas.paste(stage, ((i % COLS) * CELL, (i // COLS) * CELL))
out = ROOT / 'assets/theme-covers'
atlas.save(out / 'q-bluefish-motion.webp', quality=93, method=6, exact=False)
(out / 'q-bluefish-motion.json').write_text(json.dumps(poses, ensure_ascii=False, separators=(',', ':')) + '\n')
