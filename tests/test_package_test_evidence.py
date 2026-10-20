"""Small offline packaging regressions; no native process, browser or large archive."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
SOURCE = REPO / "scripts/package-test-evidence.py"
spec = importlib.util.spec_from_file_location("qyt_package_evidence", SOURCE)
pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack)
HELPER, RUNTIME = "a" * 64, "b" * 64


class EvidencePackagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="qyt-evidence-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.production = {"sourceCommit": "test-production-receipt", "nativeManifests": {
            "windows": {"artifacts": [{"architecture": "arm64", "sha256": HELPER}]}}}
        self.write(pack.LEGACY_EDGE_REPORT, {"status": "passed"})

    def write(self, relative, value):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def complete_native(self):
        launcher = {"passed": True, "exitCode": 0, "stdoutCopied": True, "stderrCopied": True}
        values = {
            "runner": {"status": "passed", "kind": "real-native-WebView2-production-preview-720p-endurance",
                       "platform": "win32", "architecture": "arm64", "sourcePixels": {"width": 1280, "height": 720},
                       "minutes": 30, "elapsedMs": 1_800_001, "faults": [{}] * 5,
                       "cleanup": {"passed": True}, "nativeArtifacts": [{"sha256": HELPER}]},
            "delivery": {"status": "passed", "runnerStatus": "passed", "exitCode": 0,
                         "naturalCleanupPassed": True, "helperSha256": HELPER, "runtimeSha256": RUNTIME,
                         "launcher": launcher},
            "outerCleanup": {"passed": True, "naturallyClean": True, "forcedRequired": False,
                             "errors": [], "remaining": []},
            "innerCleanup": {"passed": True, "retirementVerified": True, "naturallyRemaining": [], "remaining": []},
            "postNodeCleanup": {"passed": True, "remaining": []},
            "completion": {"exitCode": 0}, "launcher": launcher,
            "environment": {"minutes": 30, "faults": 5, "sourcePixels": {"width": 1280, "height": 720},
                            "helperSha256": HELPER, "inputHashes": {"runtime.mjs": RUNTIME}},
        }
        for key, value in values.items():
            self.write(f"{pack.NATIVE_FINAL_ROOT}/{pack.NATIVE_COMPONENTS[key]}", value)
        return values

    def result(self):
        return pack.renderer_evidence(self.root, self.production)

    def test_legacy_green_never_becomes_missing_native_green(self):
        result = self.result()
        self.assertEqual(result["legacySharedEdge"]["runnerStatus"], "passed")
        self.assertEqual(result["nativeWebView2_720p"]["status"], "not-run")
        self.assertTrue(all(not item["present"] for item in result["nativeWebView2_720p"]["components"].values()))
        # A complete passing smoke under another directory is deliberately ignored.
        self.write("artifacts/computer-use/windows-webview2-720p-lifecycle-smoke/report.json", {"status": "passed"})
        self.assertEqual(self.result()["nativeWebView2_720p"]["status"], "not-run")
        self.write(f"{pack.NATIVE_FINAL_ROOT}/environment.json", {"minutes": 30})
        self.assertEqual(self.result()["nativeWebView2_720p"]["status"], "not-run", "Starting measurement is not a final verdict")

    def test_partial_or_failed_native_is_not_masked_by_legacy_or_delivery(self):
        self.write(f"{pack.NATIVE_FINAL_ROOT}/report.json", {"status": "passed"})
        partial = self.result()["nativeWebView2_720p"]
        self.assertEqual(partial["status"], "failed")
        self.assertIn("missing:delivery", partial["validationErrors"])
        values = self.complete_native()
        values["runner"]["status"] = "failed"
        self.write(f"{pack.NATIVE_FINAL_ROOT}/report.json", values["runner"])
        result = self.result()
        self.assertEqual(result["legacySharedEdge"]["runnerStatus"], "passed")
        self.assertEqual(result["nativeWebView2_720p"]["status"], "failed")
        self.assertIn("runner-not-passed", result["nativeWebView2_720p"]["validationErrors"])

    def test_natural_cleanup_input_binding_and_real_final_scope_are_required(self):
        cases = [
            ("outerCleanup", {"naturallyClean": False, "forcedRequired": True}, "outer-cleanup-not-natural"),
            ("outerCleanup", {"remaining": None}, "outer-cleanup-not-natural"),
            ("innerCleanup", {"naturallyRemaining": [{"pid": 123}]}, "inner-cleanup-not-natural"),
            ("delivery", {"runtimeSha256": "c" * 64}, "delivery-input-hash-mismatch"),
            ("runner", {"minutes": 1, "elapsedMs": 60_001}, "not-a-complete-30min-5fault-run"),
            ("runner", {"sourcePixels": {"width": 640, "height": 360}}, "native-renderer-scope-mismatch"),
        ]
        for component, changes, reason in cases:
            with self.subTest(component=component, reason=reason):
                values = self.complete_native()
                values[component].update(changes)
                self.write(f"{pack.NATIVE_FINAL_ROOT}/{pack.NATIVE_COMPONENTS[component]}", values[component])
                result = self.result()["nativeWebView2_720p"]
                self.assertEqual(result["status"], "failed")
                self.assertIn(reason, result["validationErrors"])
        self.complete_native()
        changed = copy.deepcopy(self.production)
        changed["nativeManifests"]["windows"]["artifacts"][0]["sha256"] = "d" * 64
        self.assertIn("production-native-hash-mismatch", pack.renderer_evidence(self.root, changed)["nativeWebView2_720p"]["validationErrors"])

    def test_zip_is_self_contained_and_binds_all_final_receipts_without_doc_links(self):
        self.complete_native()
        self.write("artifacts/delivery-manifest.json", self.production)
        for name in ["computer-use-test-report.md", "implementation-progress.md", "computer-use-guide.md",
                     "windows-and-computer-use-development-plan.md", "windows-test-runtime.md"]:
            path = self.root / "docs" / name
            path.parent.mkdir(exist_ok=True)
            path.write_text("Offline fixture, intentionally without evidence links.\n", encoding="utf-8")
        script = self.root / "scripts/package-test-evidence.py"
        script.parent.mkdir()
        script.write_bytes(SOURCE.read_bytes())
        (script.parent / "summarize-renderer-soak.py").write_text("# test fixture\n", encoding="utf-8")
        output = self.root / "evidence.zip"
        with patch.object(pack, "__file__", str(script)), patch("sys.argv", [str(script), "--output", str(output)]), \
                patch.object(pack.subprocess, "check_output", return_value="test-report-head\n"), contextlib.redirect_stdout(io.StringIO()):
            pack.main()
        with zipfile.ZipFile(output) as archive:
            manifest = json.loads(archive.read("EVIDENCE-MANIFEST.json"))
            self.assertNotIn("finalWindowsRendererVerdict", manifest)
            result = manifest["windowsRendererEvidence"]
            self.assertEqual(result["legacySharedEdge"]["runnerStatus"], "passed")
            self.assertEqual(result["nativeWebView2_720p"]["status"], "passed")
            for receipt in result["nativeWebView2_720p"]["components"].values():
                self.assertEqual(hashlib.sha256(archive.read(receipt["source"])).hexdigest(), receipt["sha256"])
            self.assertEqual(set(archive.namelist()), {item["file"] for item in manifest["files"]} | {"EVIDENCE-MANIFEST.json"})


if __name__ == "__main__":
    unittest.main()
