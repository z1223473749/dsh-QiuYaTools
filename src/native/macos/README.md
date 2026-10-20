# macOS computer companion

Build with `node scripts/build-macos-computer.mjs --universal`. The generated app is
`lib/QiuYaTools Computer.app`, with stable bundle identifier
`com.qiuya.tools.computer-use`. Source compilation targets macOS 13. This is an
unsigned local build; a production signing/notarization identity is still needed
for a stable public distribution and permission continuity across updates.

The JSONL stdin/stdout protocol accepts bounded integer or string `requestId`
values and echoes them unchanged. Supported operations are `status`, `targets`,
`observe`, `lease`, `release`, `act`, `openPreview`, and `closePreview`.
`observe` with `preview: true` skips accessibility traversal, keeps the normal
coordinate cache, and never obtains an input lease. ScreenCaptureKit keeps at
most the latest JPEG frame in memory; an unused stream stops after three
seconds. No screen recording or accessibility permission is requested or granted
by the helper.

Coordinates in actions refer to the returned screenshot pixels. The helper maps
these through the actual raster dimensions and the selected window's Quartz
frame, so Retina, reduced rasters and negative display origins do not assume a
fixed pixel scale. `geometry.scale` denotes the display backing scale, matching
the target list. Every injected event rechecks the epoch, target geometry and
foreground application. Lease replacement, release, shutdown and handled
SIGTERM/SIGINT release held inputs. A release at an older epoch cannot revoke a
newer lease.

The floating WebKit preview accepts only HTTP loopback URLs with explicit ports,
blocks navigation to another origin, and uses an ephemeral data store. It stays
interactive during actions and accepts the first click while another app has
focus. Harness launch URLs first exchange their token at the root index. Once
the clean root document commits, it navigates to the preview from that document
so the API receives the same private store's owner cookie. The token is removed
from the destination URL. Status exposes only navigation paths, HTTP status and
cookie count for diagnosis, never credential values.

If the preview overlaps a requested click or drag path it
moves to an available display corner; if necessary it uses a smaller preview
size. If no placement avoids the path, the action fails with `PREVIEW_OVERLAP`.
Keyboard input is delivered to the target process, with Unicode/modifier state
explicitly set. Mouse input follows the actual desktop pointer.

macOS drag tracking may capture a user's click before it reaches a preview
button. The native local/global input monitors therefore revoke the lease when
a non-helper mouse-down occurs inside the preview during an action, or when the
user presses Escape. They emit `humanInput` with the epoch, optional preview
session identity and reason. The Host must mirror that event to a paused state.
The monitors inspect event type, key code, source PID and pointer position; they
do not record user keystroke text. Closing the preview emits `previewClosed`.

Run `node scripts/test-macos-computer.mjs` for native geometry, epoch, shortcut,
origin and wire validation. Run
`node scripts/e2e-macos-computer.mjs --evidence-dir /tmp/qiuya-macos-evidence`
for a disposable AppKit fixture, real ScreenCaptureKit/AX observation, real mouse
and keyboard input, overlap relocation, live WebKit preview, drag cancellation,
physical preview intervention, held-button release and stale-input rejection.
The E2E script reports missing permissions without changing them. It never uses
normal Harness profiles or existing account credentials.

`scripts/e2e-harness.mjs` additionally runs the installed Harness CLI with a fresh
`DSH_HOME`, the candidate plugin, a deterministic local model and a disposable
Chrome profile. It verifies the main Agent's actual observe/action/observe tool
receipts and incoming adapter image blocks. Its floating-window evidence uses
ScreenCaptureKit, Vision OCR and physical pointer clicks on the preview's own
controls; `HarnessWindowEvidence.swift` is a test fixture, not a shipped helper.
This proves local transport and Host/UI integration, without claiming external
vision-model reasoning or access to a user's existing model credentials.

The real fixture was exercised on macOS 26 / Apple Silicon. Intel was compiled,
not executed on Intel hardware. macOS 13 runtime behavior, particularly the
older ScreenCaptureKit window-shadow/content geometry, still needs a dedicated
machine check before claiming complete compatibility with that OS.

API references: [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit/scstream),
[CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent),
[accessibility trust](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrusted).
