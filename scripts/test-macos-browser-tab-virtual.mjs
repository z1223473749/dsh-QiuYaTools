/** Opt-in: switch exactly one already-open tab through NativeInput's virtual path. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
const execute = promisify(execFile)
if (process.platform !== 'darwin') throw Error('macOS acceptance requires macOS')
const [appId, title, report] = process.argv.slice(2)
if (!appId || !title || !report) throw Error('Usage: node scripts/test-macos-browser-tab-virtual.mjs BROWSER_BUNDLE_ID EXACT_TAB_TITLE REPORT_PATH')
const directory = await mkdtemp('/tmp/qiuya-browser-virtual-'), source = fileURLToPath(new URL('../src/native/macos/', import.meta.url))
try {
  const files = ['Protocol.swift', 'LeaseGuard.swift', 'Applications.swift', 'MacTransport.swift', 'PermissionGuide.swift', 'OperationBadge.swift', 'CursorOverlay.swift', 'FocusPreparation.swift', 'VirtualInput.swift', 'Input.swift', 'Preview.swift', 'fixtures/BrowserTabVirtualAcceptance.swift']
  await execute('/usr/bin/swiftc', ['-swift-version', '5', '-parse-as-library', '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'ApplicationServices', '-module-cache-path', '/tmp/qiuya-computer-swift-cache', ...files.map(file => join(source, file)), '-o', join(directory, 'acceptance')], { timeout: 90_000 })
  const result = await execute(join(directory, 'acceptance'), [appId, title, resolve(report)], { timeout: 20_000 })
  process.stdout.write(result.stdout)
} finally { await rm(directory, { recursive: true, force: true }) }
