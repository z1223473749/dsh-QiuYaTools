import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Only injected read backends run. This starts no application/GUI, permission
// request, real AX query, cursor mutation or injected native input.
test('macOS detached AX reads leave MainActor release/restore responsive and preserve privacy/budgets', { skip: process.platform !== 'darwin', timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qiuya-ax-worker-selftest-'))
  const source = fileURLToPath(new URL('../src/native/macos/', import.meta.url))
  const execute = promisify(execFile)
  try {
    const binary = join(directory, 'ax-worker-selftest')
    await execute('/usr/bin/swiftc', ['-O', '-swift-version', '5', '-parse-as-library', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
      '-framework', 'AppKit', '-framework', 'ScreenCaptureKit', '-framework', 'ApplicationServices', '-framework', 'CoreImage', '-framework', 'CoreMedia',
      '-module-cache-path', join(directory, 'module-cache'), ...['Protocol.swift', 'Capture.swift', 'LeaseGuard.swift', 'CursorOverlay.swift', 'Input.swift', 'fixtures/AccessibilityWorkerSelfTest.swift'].map(name => join(source, name)), '-o', binary], { timeout: 90_000 })
    const { stdout } = await execute(binary, [], { timeout: 15_000 })
    const report = JSON.parse(stdout)
    assert.equal(report.passed, true)
    assert.equal(report.checks.length, 6)
    assert.equal(report.gui, false)
    assert.equal(report.nativeInput, false)
    assert.equal(report.realAX, false)
    t.diagnostic(JSON.stringify(report))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
