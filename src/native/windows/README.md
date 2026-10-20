# Windows native companion

The same self-contained executable has independent process modes:

- no arguments: session windows using the existing `open` / `prepare` / `cancel` protocol;
- `--computer`: target enumeration, JPEG + UI Automation observations, fenced input and floating WebView2 previews;
- `--release-input`: a separate cleanup process accepting a bounded `{ownerId,keys:[VK...],mouseButtons:["left"|"right"|"middle"],unicodeUnits?:[UTF16...]}` line and recovering only the matching durable owner journal; stale snapshots never inject into a newer lease. Exit 0 confirms matching recovery or a safe obsolete-owner skip, exit 1 means recovery failure, exit 2 means rejected input;
- `--input-guardian`: a private child mode that waits for its owning process to close stdin, then recovers an abandoned journal under the same desktop lock;
- `--self-test-input`: deterministic rejected-input state checks using an injected writer; these send no OS input and are identified separately in reports;
- `--fixture`: an isolated test application with event counters and a local fixture website.

Each line on stdin is JSON. Replies preserve a bounded string or nonnegative integer `requestId` and use `{ requestId, ok, result?, error? }`. Uncorrelated output uses `event`. Authenticated page URLs are accepted only through stdin, never process arguments or logs. Closing stdin and the optional `QIUYA_TOOLS_PARENT_PID` watchdog clean up the process and release held input.

Capture currently uses `PrintWindow` with a visible-desktop GDI fallback, rather than Windows Graphics Capture. A single capture worker has a 2.5-second response deadline; retries do not create new workers while a previous renderer is stuck. GPU/protected/occluded applications still need separate compatibility validation. UI Automation waits are bounded and may return a diagnostic string when the target provider cannot respond.

Floating previews exchange a Harness owner token at the authenticated root, then navigate from the committed document to preserve SameSite cookies. The private preview profile does not reuse the user's Edge profile.

A file lock scoped to the interactive Windows desktop enforces one lease across local Hosts, profiles and paired agents. Each lease has a new owner identity and a durable write-ahead input journal. A separate guardian starts at the first lease and recovers abandoned owned input after process death. New owners recover the journal before acquiring; late cleanup from an old owner skips a newer lease. This uses only the bundled runtime.

Computer leases use strictly increasing positive safe-integer epochs. `release` affects only the active matching epoch. Every input injection checks the active lease under the same lock used by release. Actions cannot overlap. Before an action, an overlapping native preview moves outside the target or hides temporarily and restores without activation. Noninjected physical input revokes the native lease immediately; the preview is ignored while idle, but busy preview input and Escape always interrupt. The companion emits `inputHeld` before key/button down and after confirmed release, including Unicode scan units. A rejected release retains the owned snapshot, revokes the lease and fences the process until retirement. It emits the snapshot so the Host can run separate cleanup even if the primary worker is stuck. Input is foreground-only; secure desktops and higher-integrity applications are outside this companion's permissions. Targets include HWND, PID and process start ticks; input requires an observation of unchanged target geometry.

Build with the Microsoft .NET SDK **8.0.426** (`global.json`) and the locked **Microsoft.Web.WebView2 1.0.3912.50** package. The executable includes the .NET runtime; end users need the Microsoft Edge WebView2 Evergreen Runtime, not the SDK. Missing WebView2 reports `webview2-runtime-missing`. No bootstrapper silently installs system software.

```sh
QIUYA_DOTNET=/path/to/dotnet node scripts/build-windows-native.mjs arm64 x64
```

Artifacts are `lib/native/win32-{arm64,x64}/qiuya-windows.exe` and `lib/native/windows-manifest.json`; the latter binds protocol, architecture, length and SHA256. Platform packages must include only their matching executable. This project intentionally does not use trimming because WinForms, WPF UI Automation and WebView2 require reflection/native assets. Original licenses for the WebView2 SDK and bundled .NET runtime must travel with redistributed binaries.

The PD E2E runner requires an already selected, running Windows guest and a logged-on interactive user. It transfers only the local executable and test script over a random, temporary route bound to the specified host-only address; verifies SHA256; creates a temporary InteractiveToken scheduled task; and unregisters it after the test. It uses no account password, does not alter ExecutionPolicy or OS settings, and does not restart the guest. Test artifacts remain only in a unique temporary guest directory and the requested local output directory.

```sh
QIUYA_PD_VM=<selected-uuid> QIUYA_PD_HOST_IP=<host-only-Mac-IP> \
QIUYA_WINDOWS_TEST_OUTPUT=/tmp/qiuya-windows-native-e2e \
node scripts/test-windows-native-pd.mjs
```

The runner checks its actual interactive session, target identity, nonblank JPEG capture, real UIA, click/text/key effects observed independently by the fixture, revoked leases, coordinates, session-window handshake/reuse/validation, and preview lifecycle. A build for another architecture is not evidence of a native desktop runtime test. Real Harness feature tests run separately from this companion fixture.

For the 30-minute native capture-only memory test, set `QIUYA_WINDOWS_TEST_KIND=endurance` when running the PD runner. This benchmark deliberately captures no input lease and saves no frame images. Its PowerShell/JSON round trip is reported separately from video encoding or UI rendering.

`scripts/e2e-windows-remote-pd.mjs` adds an actual Node agent in the Windows interactive desktop, a test-only authenticated private reverse tunnel (no inbound firewall changes), and the Mac public `RemoteComputerDriver`. It checks real target/capture/input, pairing/version/origin checks, input exclusivity, release/resume, preview frames, and heartbeat revocation after tunnel loss. Guest tokens remain temporary test files and are never logged.

The current native evidence is `artifacts/computer-use/windows-native-final/`: 45 checks passed on Windows 11 ARM64 in the logged-on Session 1. This includes a real PD keyboard Escape during drag, actual OS button state after worker termination, cross-helper exclusivity and late-owner cleanup preserving a newer owner's button-down. The rejected-release check is a deterministic state-machine test, explicitly not a real Windows rejection. A physical HID click on the helper's own preview during an in-flight drag is still unverified; the SetCursorPos diagnostic is not counted as physical input. Native Windows x64 execution is also unverified: its build succeeded, while a preliminary x64-on-ARM64 emulation run reached a WebView2 handshake timeout. The earlier capture endurance run timed out after its 60-second sample; a new bounded-capture 30-minute run is tracked separately and must not be represented as passed before completion.

The separate `scripts/test-windows-node-windows-hide.mjs` regression uses real Node/libuv `spawn({windowsHide:true})`, matching the production Host. It verified five cases on Windows ARM64: preparation stays hidden; a ready Session becomes OS-visible; reuse keeps one window; a floating preview becomes OS-visible and can be captured; closing removes it. `BrowserWindow.Present` explicitly sets `SWP_SHOWWINDOW` for a requested GUI while preserving the hidden companion console. This addresses a real Harness integration failure where startup `SW_HIDE` hid the native window despite a successful page-ready receipt. Its evidence is `artifacts/computer-use/windows-node-hidden/`.

The final cursor/journal regression adds two live-pointer checks to the baseline and passed 47 cases in `artifacts/computer-use/windows-native-cursor-final/`. Preview observations include target-local cursor coordinates and hide the cursor when it is outside the target. Late-owner cleanup reads the bounded journal with delete sharing so it cannot prevent the current owner's atomic journal replacement. The Node windowsHide five-case regression was repeated against this same binary, including the cursor payload.
