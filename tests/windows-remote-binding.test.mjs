import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const execute = promisify(execFile)
test('actual C# binding policy waits only for missing loader metadata and rejects foreign identities', { timeout: 60000 }, async context => {
  const dotnet = process.env.QIUYA_DOTNET || 'dotnet'
  try { await execute(dotnet, ['--version'], { timeout: 5000 }) } catch (error) { if (error.code === 'ENOENT') { context.skip('Use QIUYA_DOTNET to run the C# metadata policy self-test'); return } throw error }
  const directory = await mkdtemp(join(tmpdir(), 'qiuya-remote-binding-'))
  try {
    const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_HOME: directory }
    await execute(dotnet, ['build', 'tests/fixtures/windows-remote-binding.csproj', '--nologo', '-o', join(directory, 'bin'), '-p:BaseIntermediateOutputPath=' + join(directory, 'obj') + '/', '--ignore-failed-sources'], { env, timeout: 45000, maxBuffer: 1024 * 1024 })
    const receipt = JSON.parse((await execute(dotnet, [join(directory, 'bin/windows-remote-binding.dll')], { env, timeout: 10000 })).stdout)
    assert.deepEqual(receipt, { passed: true, checks: 11, gui: false, osReads: false, nativeInputEvents: 0 })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
