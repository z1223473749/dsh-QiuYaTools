#!/usr/bin/env python3
"""Render recorded Windows soak resources; never changes the runner verdict."""

import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = json.loads(args.report.read_text(encoding="utf-8"))
    samples = report.get("resources", [])
    if not samples or not all(isinstance(s.get("processes"), list) for s in samples):
        raise SystemExit("Expected recorded Windows process snapshots")
    output = args.output or args.report.parent
    output.mkdir(parents=True, exist_ok=True)
    groups = {
        "total": lambda name: True,
        "browser": lambda name: name.lower() in ("msedge.exe", "msedgewebview2.exe"),
        "native": lambda name: name.lower() == "qiuya-windows.exe",
        "node": lambda name: name.lower() == "node.exe",
    }
    rows = []
    for sample in samples:
        row = {"elapsedMs": sample["elapsedMs"]}
        for group, include in groups.items():
            processes = [p for p in sample["processes"] if include(p["name"])]
            for source, suffix in [("workingSetBytes", "WorkingSetBytes"), ("privateBytes", "PrivateBytes")]:
                row[group + suffix] = sum(p[source] for p in processes)
        rows.append(row)
    summary = {
        "sourceReport": args.report.name,
        "runnerStatus": report["status"],
        "samples": len(rows),
        "firstSampleMs": rows[0]["elapsedMs"],
        "lastSampleMs": rows[-1]["elapsedMs"],
        "definition": "WorkingSet and raw CIM PrivatePageCount are different measurements. "
        "Snapshots include sampling PowerShell/conhost. Peaks between samples are not observed. "
        "This summary does not replace or change the runner verdict or add a private-bytes threshold.",
        "metrics": {},
    }
    for key in rows[0]:
        if key == "elapsedMs":
            continue
        values = [r[key] for r in rows]
        summary["metrics"][key] = {
            "first": values[0], "last": values[-1], "peak": max(values),
            "lastMinusFirst": values[-1] - values[0],
        }
    (output / "resource-summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    mib = 1024 * 1024
    times = [r["elapsedMs"] / 60000 for r in rows]
    fig, axes = plt.subplots(2, 1, figsize=(10, 7), sharex=True, constrained_layout=True)
    for group, color in [("total", "#183650"), ("browser", "#007d87"), ("native", "#a75414"), ("node", "#6958a6")]:
        for axis, suffix in zip(axes, ["WorkingSetBytes", "PrivateBytes"]):
            axis.plot(times, [r[group + suffix] / mib for r in rows], label=group, color=color, linewidth=1.6)
    limit = report.get("resourceBounds", {}).get("limits", {}).get("ownedTreeRssBytes")
    if limit:
        axes[0].axhline(limit / mib, linestyle="--", color="#bd3737", label="owned-tree WS limit")
    for axis in axes:
        for index, fault in enumerate(report.get("faults", [])):
            axis.axvline(fault["at"] / 60000, color="#737373", alpha=0.45, linestyle=":", label="helper termination" if index == 0 else None)
        axis.grid(alpha=0.22)
        axis.set_ylim(bottom=0)
    axes[0].set_ylabel("Working set (MiB)")
    axes[1].set_ylabel("Private bytes (MiB), diagnostic")
    axes[1].set_xlabel("Elapsed measurement time (minutes)")
    axes[0].legend(ncol=3, fontsize=8, loc="upper right")
    axes[0].set_title(f"Windows preview renderer resource snapshots — runner: {report['status']}")
    if report.get("kind") == "real-native-WebView2-production-preview-720p-endurance":
        pixels = report.get("sourcePixels", {})
        label = f"{pixels.get('width', '?')} × {pixels.get('height', '?')} source / actual native WebView2 / production preview canvas"
    else:
        label = "640 × 360 / installed Edge / production preview canvas; not native WebView2 endurance"
    fig.suptitle(label, fontsize=10)
    fig.savefig(output / "resource-trend.png", dpi=160)
    plt.close(fig)
    print(json.dumps({"summary": str(output / "resource-summary.json"), "chart": str(output / "resource-trend.png"), "runnerStatus": report["status"]}))


if __name__ == "__main__":
    main()
