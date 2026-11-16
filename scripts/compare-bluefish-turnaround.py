#!/usr/bin/env python3
"""Compare the six design silhouettes with preview-bluefish-3d.mjs --matte output."""

import argparse
import json
from math import degrees, sqrt
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

VIEWS = [
    ("front", 257, 466, 0),
    ("left", 710, 466, 90),
    ("back", 1280, 466, 180),
    ("front-quarter", 227, 972, 45),
    ("right", 826, 972, 270),
    ("back-quarter", 1277, 972, 135),
]
PANEL_WIDTH = 512
PANEL_HEIGHT = 476
MARGIN = 96
WORLD_UNITS_PER_REFERENCE_PIXEL = .0056


def design_mask(panel):
    pixels = np.asarray(panel).astype(np.int16)
    edges = np.concatenate((pixels[:, 4:20], pixels[:, -20:-4]), axis=1)
    background = np.median(edges, axis=1, keepdims=True)
    difference = np.max(np.abs(pixels - background), axis=2)
    mask = (difference > 10).astype(np.uint8)
    mask[:3] = 0
    mask[:, :3] = mask[:, -3:] = 0
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    _, components, sizes, _ = cv2.connectedComponentsWithStats(mask)
    subject = (components == 1 + np.argmax(sizes[1:, cv2.CC_STAT_AREA])).astype(np.uint8)
    count, holes, areas, _ = cv2.connectedComponentsWithStats(1 - subject)
    for index in range(1, count):
        region = holes == index
        if areas[index, cv2.CC_STAT_AREA] <= 120 or np.mean(difference[region] > 3) > .8:
            subject[region] = 1
    return np.pad(subject.astype(bool), ((0, 0), (MARGIN, MARGIN)))


def aligned_model(matte, projection, anchor, panel):
    height, width = matte.height, matte.width
    scale = height / projection["worldHeight"] * WORLD_UNITS_PER_REFERENCE_PIXEL
    x = width * projection["x"] + (panel[0] - anchor[0] - MARGIN) * scale
    y = height * projection["y"] + (panel[1] - anchor[1]) * scale
    size = (PANEL_WIDTH + 2 * MARGIN, PANEL_HEIGHT)
    extent = (x, y, x + size[0] * scale, y + size[1] * scale)
    return matte.transform(size, Image.Transform.EXTENT, extent, Image.Resampling.BICUBIC)


def reference_tail_intervals(masks):
    # At this height the visible tail stem is separated from the hair.
    # Project the orthogonal intervals into the two labeled oblique views.
    height = 195
    stems = {}
    for name, (mask, anchor_x, floor_y) in masks.items():
        if name not in ("front", "left", "front-quarter", "back-quarter"):
            continue
        edges = np.diff(np.pad(mask[floor_y - height].astype(int), 1))
        runs = list(zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1) - 1))
        if len(runs) < 2:
            return None
        stem = runs[0] if name == "back-quarter" else runs[-1]
        stems[name] = [int(x) - MARGIN - anchor_x for x in stem]
    front, left = stems["front"], stems["left"]
    front_quarter = [(front[0] + left[0]) / sqrt(2), (front[1] + left[1]) / sqrt(2)]
    back_quarter = [(left[0] - front[1]) / sqrt(2), (left[1] - front[0]) / sqrt(2)]
    return {
        "heightAboveFloorPixels": height,
        "drawnIntervalsPixels": stems,
        "orthographicProjectionFromFrontAndLeftPixels": {
            "front-quarter": [round(x, 1) for x in front_quarter],
            "back-quarter": [round(x, 1) for x in back_quarter],
        },
    }


def compare(output, reference):
    capture = json.loads((output / "review.json").read_text())
    report = {"modelSha256": capture["modelSha256"], "visualAcceptance": "pending", "views": {}}
    masks = {}
    for index, (name, x, y, yaw) in enumerate(VIEWS):
        panel_x, panel_y = index % 3 * PANEL_WIDTH, index // 3 * 512
        panel = reference.crop((panel_x, panel_y, panel_x + PANEL_WIDTH, panel_y + PANEL_HEIGHT))
        original = design_mask(panel)
        masks[name] = (original, x - panel_x, y - panel_y)
        capture_names = [name]
        opposite = "back-quarter-opposite"
        if name == "back-quarter" and f"model-{opposite}" in capture["projections"]:
            capture_names.append(opposite)
        for capture_name in capture_names:
            screenshot = f"model-{capture_name}"
            with Image.open(output / f"{screenshot}-matte.png") as matte:
                aligned = aligned_model(matte, capture["projections"][screenshot], (x, y), (panel_x, panel_y))
            model = np.asarray(aligned.getchannel("A")) >= 64
            shared = original & model
            missing = original & ~model
            extra = model & ~original
            result = {
                "referenceYawDegrees": yaw,
                "yawDegrees": round(degrees(capture["angles"][screenshot]), 2),
                "silhouetteIoU": round(float(shared.sum() / (original | model).sum()), 4),
                "designOnlyPixels": int(missing.sum()),
                "modelOnlyPixels": int(extra.sum()),
            }
            if capture_name == name:
                report["views"][name] = result
            else:
                report["oppositeRearDiagnostic"] = result
            mask = np.full((*original.shape, 3), (244, 244, 249), dtype=np.uint8)
            mask[shared] = (170, 181, 217)
            mask[missing] = (219, 99, 121)
            mask[extra] = (69, 154, 181)
            strip = Image.new("RGB", (PANEL_WIDTH + 2 * aligned.width, PANEL_HEIGHT), (244, 244, 249))
            strip.paste(panel, (0, 0))
            strip.paste(aligned, (PANEL_WIDTH, 0), aligned)
            strip.paste(Image.fromarray(mask), (PANEL_WIDTH + aligned.width, 0))
            strip.save(output / f"compare-{capture_name}.png")
    report["referenceTailIntervals"] = reference_tail_intervals(masks)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path, help="Directory produced by the preview script with --matte")
    parser.add_argument(
        "--reference", type=Path,
        default=Path(__file__).resolve().parents[1] / "artifacts/ocean-scene/bluefish-model-review/reference-turnaround.png",
    )
    args = parser.parse_args()
    with Image.open(args.reference) as sheet:
        result = compare(args.capture, sheet.convert("RGB"))
    report = json.dumps(result, indent=2)
    (args.capture / "outline-fit.json").write_text(report + "\n")
    print(report)
