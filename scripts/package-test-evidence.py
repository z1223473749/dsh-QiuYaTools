#!/usr/bin/env python3
"""Package the final report and its local evidence without installers or profiles."""

import argparse
import hashlib
import json
import re
import subprocess
import zipfile
from pathlib import Path


def main():
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=root / "artifacts/qiuya-tools-0.6.0-beta.1-test-evidence.zip")
    args = parser.parse_args()
    required = root / "artifacts/computer-use/windows-renderer-canvas-final/report.json"
    if not required.is_file():
        raise SystemExit("The final 30-minute run has not produced its report yet")
    selected, visited = set(), set()
    pending = [root / "docs" / name for name in [
        "computer-use-test-report.md", "implementation-progress.md", "computer-use-guide.md",
        "windows-and-computer-use-development-plan.md", "windows-test-runtime.md",
    ]]
    while pending:
        path = pending.pop()
        if path in visited:
            continue
        visited.add(path)
        if not path.is_file() or not path.is_relative_to(root):
            raise SystemExit(f"Missing or outside-workspace report reference: {path}")
        selected.add(path)
        if path.suffix != ".md":
            continue
        for link in re.findall(r"\]\(([^)]+)\)", path.read_text(encoding="utf-8")):
            if "://" in link or link.startswith("#"):
                continue
            pending.append((path.parent / link.split("#")[0]).resolve())
    selected.update([required, Path(__file__).resolve(), root / "scripts/summarize-renderer-soak.py"])
    evidence_roots = [root / "artifacts" / name for name in ["computer-use", "harness-e2e", "install-e2e"]]
    for path in list(selected):
        if any(path.is_relative_to(base) for base in evidence_roots):
            selected.update(p for p in path.parent.iterdir() if p.is_file()
                            and not p.is_symlink() and p.suffix in {".json", ".jsonl", ".log", ".err", ".jpg", ".png"}
                            and p.stat().st_size <= 16 * 1024 * 1024)
    records = []
    for path in sorted(selected):
        if not path.is_file() or path.is_symlink() or not path.is_relative_to(root):
            raise SystemExit(f"Invalid evidence file: {path}")
        records.append({"file": str(path.relative_to(root)), "bytes": path.stat().st_size,
                        "sha256": hashlib.file_digest(path.open("rb"), "sha256").hexdigest()})
    manifest = {
        "kind": "local-test-evidence-not-an-installer",
        "reportCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
        "productionReceipt": json.loads((root / "artifacts/delivery-manifest.json").read_text())["sourceCommit"],
        "finalWindowsRendererVerdict": json.loads(required.read_text())["status"],
        "files": records,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for record in records:
            archive.write(root / record["file"], record["file"])
        archive.writestr("EVIDENCE-MANIFEST.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    with zipfile.ZipFile(args.output) as archive:
        for record in records:
            if hashlib.sha256(archive.read(record["file"])).hexdigest() != record["sha256"]:
                raise SystemExit(f"Archive verification failed: {record['file']}")
    digest = hashlib.file_digest(args.output.open("rb"), "sha256").hexdigest()
    args.output.with_suffix(".zip.sha256").write_text(f"{digest}  {args.output.name}\n", encoding="utf-8")
    print(json.dumps({"archive": str(args.output), "files": len(records), "bytes": args.output.stat().st_size,
                      "sha256": digest, "finalWindowsRendererVerdict": manifest["finalWindowsRendererVerdict"]}))


if __name__ == "__main__":
    main()
