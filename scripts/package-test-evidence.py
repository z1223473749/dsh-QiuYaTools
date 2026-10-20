#!/usr/bin/env python3
"""Package the final report and its local evidence without installers or profiles."""

import argparse
import hashlib
import json
import re
import subprocess
import zipfile
from pathlib import Path


LEGACY_EDGE_REPORT = "artifacts/computer-use/windows-renderer-canvas-final/report.json"
NATIVE_FINAL_ROOT = "artifacts/computer-use/windows-webview2-720p-final"
NATIVE_COMPONENTS = {
    "runner": "report.json",
    "delivery": "delivery-verdict.json",
    "outerCleanup": "outer-cleanup-verdict.json",
    "innerCleanup": "cleanup-verification.json",
    "postNodeCleanup": "post-run-cleanup-verification.json",
    "completion": "completed.json",
    "launcher": "launcher-completed.json",
    "environment": "environment.json",
}


def file_sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_component(root, relative):
    path = root / relative
    if not path.exists():
        return {"source": relative, "present": False}, None
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
        raise SystemExit(f"Invalid renderer evidence file: {relative}")
    data = path.read_bytes()
    try:
        value = json.loads(data.decode("utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError):
        raise SystemExit(f"Invalid renderer evidence JSON: {relative}") from None
    if not isinstance(value, dict):
        raise SystemExit(f"Renderer evidence must be an object: {relative}")
    return {"source": relative, "present": True, "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest()}, value


def renderer_evidence(root, production):
    """Describe independent scopes; missing/failed native receipts never inherit Edge green."""
    legacy_source, legacy = read_component(root, LEGACY_EDGE_REPORT)
    legacy_status = legacy.get("status") if legacy is not None else "not-run"
    legacy_entry = {"scope": "historical-640x360-shared-Edge-frontend",
                    "runnerStatus": legacy_status if isinstance(legacy_status, str) and legacy_status in {"passed", "failed", "not-run"} else "failed",
                    "report": legacy_source}
    components, values = {}, {}
    for key, name in NATIVE_COMPONENTS.items():
        components[key], values[key] = read_component(root, f"{NATIVE_FINAL_ROOT}/{name}")
    native = {"scope": "final-native-WinForms-WebView2-1280x720-source-canvas-30min-5faults",
              "status": "not-run", "components": components,
              "limits": "720p is source/JPEG/canvas backing; no physical 720p viewport or scroll/drag workload claim"}
    errors = [f"missing:{key}" for key, value in values.items() if value is None]
    # Only compact status/identity fields enter the manifest, never full environment or auth data.
    r, d, outer, inner, post, completed, launcher, env = (values[key] or {} for key in NATIVE_COMPONENTS)
    native.update({"runnerStatus": r.get("status", "not-run"),
                   "deliveryStatus": d.get("status", "not-run"),
                   "innerCleanupPassed": inner.get("passed") is True,
                   "postNodeCleanupPassed": post.get("passed") is True,
                   "outerCleanupPassed": outer.get("passed") is True,
                   "naturalCleanupPassed": outer.get("naturallyClean") is True,
                   "completionExitCode": completed.get("exitCode"),
                   "launcherPassed": launcher.get("passed") is True,
                   "helperSha256": d.get("helperSha256"), "runtimeSha256": d.get("runtimeSha256")})
    if values["runner"] is None:
        # An environment/progress receipt may already exist while the run is
        # still measuring. Preserve any component results without inventing a
        # final runner verdict or inheriting the historical Edge verdict.
        native["unavailableReason"] = "final-runner-report-not-produced"
        return {"legacySharedEdge": legacy_entry, "nativeWebView2_720p": native}

    def require(ok, reason):
        if not ok:
            errors.append(reason)

    def exit_zero(value):
        return type(value) is int and value == 0

    def as_object(value):
        return value if isinstance(value, dict) else {}

    require(r.get("status") == "passed", "runner-not-passed")
    require(r.get("kind") == "real-native-WebView2-production-preview-720p-endurance"
            and r.get("platform") == "win32" and r.get("sourcePixels") == {"width": 1280, "height": 720},
            "native-renderer-scope-mismatch")
    require(r.get("minutes") == 30 and isinstance(r.get("elapsedMs"), (int, float))
            and r["elapsedMs"] >= 1_800_000 and isinstance(r.get("faults"), list) and len(r["faults"]) == 5,
            "not-a-complete-30min-5fault-run")
    require(d.get("status") == "passed" and d.get("runnerStatus") == r.get("status")
            and exit_zero(d.get("exitCode")) and d.get("naturalCleanupPassed") is True
            and (d.get("emergencyCleanupRequired") is None or d.get("emergencyCleanupRequired") is False), "delivery-not-passed")
    require(as_object(r.get("cleanup")).get("passed") is True and inner.get("passed") is True
            and inner.get("retirementVerified") is True and inner.get("naturallyRemaining") == []
            and inner.get("remaining") == [], "inner-cleanup-not-natural")
    require(post.get("passed") is True and post.get("remaining") == [], "post-node-cleanup-not-passed")
    require(outer.get("passed") is True and outer.get("naturallyClean") is True
            and outer.get("forcedRequired") is False and outer.get("errors") == [] and outer.get("remaining") == [],
            "outer-cleanup-not-natural")
    require(exit_zero(completed.get("exitCode")), "runner-exit-not-zero")
    require(launcher.get("passed") is True and exit_zero(launcher.get("exitCode"))
            and launcher.get("stdoutCopied") is True and launcher.get("stderrCopied") is True
            and d.get("launcher") == launcher, "launcher-receipt-mismatch")
    helper = env.get("helperSha256")
    runtime = as_object(env.get("inputHashes")).get("runtime.mjs")
    hashes_valid = all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value)
                       for value in [helper, runtime])
    require(hashes_valid and d.get("helperSha256") == helper and d.get("runtimeSha256") == runtime,
            "delivery-input-hash-mismatch")
    native_runs = r.get("nativeArtifacts")
    require(isinstance(native_runs, list) and len(native_runs) > 0
            and all(isinstance(item, dict) and item.get("sha256") == helper for item in native_runs),
            "native-generation-hash-mismatch")
    artifacts = as_object(as_object(production.get("nativeManifests")).get("windows")).get("artifacts", [])
    if not isinstance(artifacts, list):
        artifacts = []
    require(any(item.get("architecture") == r.get("architecture") and item.get("sha256") == helper
                for item in artifacts if isinstance(item, dict)), "production-native-hash-mismatch")
    require(env.get("minutes") == 30 and env.get("faults") == 5
            and env.get("sourcePixels") == r.get("sourcePixels"), "environment-run-scope-mismatch")
    native["status"] = "failed" if errors else "passed"
    native["validationErrors"] = errors
    return {"legacySharedEdge": legacy_entry, "nativeWebView2_720p": native}


def main():
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=root / "artifacts/qiuya-tools-0.6.0-beta.1-test-evidence.zip")
    args = parser.parse_args()
    receipt = root / "artifacts/delivery-manifest.json"
    production = json.loads(receipt.read_text(encoding="utf-8-sig"))
    renderer = renderer_evidence(root, production)
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
    selected.update([receipt, Path(__file__).resolve(), root / "scripts/summarize-renderer-soak.py"])
    sources = [renderer["legacySharedEdge"]["report"], *renderer["nativeWebView2_720p"]["components"].values()]
    selected.update(root / item["source"] for item in sources if item["present"])
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
                        "sha256": file_sha256(path)})
    manifest = {
        "kind": "local-test-evidence-not-an-installer",
        "reportCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
        "productionReceipt": production["sourceCommit"],
        "windowsRendererEvidence": renderer,
        "files": records,
    }
    by_path = {record["file"]: record for record in records}
    for item in sources:
        if item["present"] and any(by_path[item["source"]][key] != item[key] for key in ["bytes", "sha256"]):
            raise SystemExit(f"Renderer receipt changed while packaging: {item['source']}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for record in records:
            archive.write(root / record["file"], record["file"])
        archive.writestr("EVIDENCE-MANIFEST.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    with zipfile.ZipFile(args.output) as archive:
        for record in records:
            if hashlib.sha256(archive.read(record["file"])).hexdigest() != record["sha256"]:
                raise SystemExit(f"Archive verification failed: {record['file']}")
    digest = file_sha256(args.output)
    args.output.with_suffix(".zip.sha256").write_text(f"{digest}  {args.output.name}\n", encoding="utf-8")
    print(json.dumps({"archive": str(args.output), "files": len(records), "bytes": args.output.stat().st_size,
                      "sha256": digest, "legacyEdgeRendererVerdict": renderer["legacySharedEdge"]["runnerStatus"],
                      "finalNativeWebView2Verdict": renderer["nativeWebView2_720p"]["status"]}))


if __name__ == "__main__":
    main()
