import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const execute = promisify(execFile)

test('WK soak read-only getters refuse wrong ABI and do not create a network process when none exists', { skip: process.platform !== 'darwin' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qiuya-wk-assoc-pure-'))
  try {
    const binary = join(directory, 'fake-getters')
    await execute('/usr/bin/clang', ['-O2', '-fobjc-arc', '-fblocks', '-mmacosx-version-min=13.0', '-framework', 'AppKit', '-framework', 'WebKit', '-DQIUYA_WK_ASSOC_SELFTEST=1', 'src/native/macos/fixtures/WKSoakAssociationProbe.m', '-o', binary], { timeout: 30000 })
    const receipt = JSON.parse((await execute(binary, [], { timeout: 10000 })).stdout)
    assert.deepEqual(receipt, { passed: true, checks: 7, gui: false, realWK: false, productionHelperSpawned: false })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
