import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

test('real visual fixture preserves exact whitespace and shows failed submission without revealing its answer', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qiuya-visual-fixture-feedback-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const binary = join(directory, 'fixture'), execute = promisify(execFile)
  await execute('/usr/bin/swiftc', ['-swift-version', '5', '-framework', 'AppKit', '-module-cache-path', '/private/tmp/qiuya-live-vision-swift-cache', fileURLToPath(new URL('../src/native/macos/fixtures/LiveVisionFixture.swift', import.meta.url)), '-o', binary], { timeout: 90000 })
  const { stdout } = await execute(binary, ['--self-test'], { timeout: 10000 })
  assert.match(stdout, /exact whitespace, visible mismatch and success feedback; zero windows and input/u)
})
