import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const digest = value => createHash('sha256').update(value).digest('hex')
const root = fileURLToPath(new URL('../', import.meta.url))
const inputs = ['src/native/windows/ForegroundHandoffCore.cs', 'tests/fixtures/windows-foreground-handoff-core.cs']
const snapshot = async () => Promise.all(inputs.map(async path => { const bytes = await readFile(join(root, path)); return { path, sha256: digest(bytes), bytes: bytes.length } }))
const execute = (command, args, options) => new Promise((done, reject) => {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  let exceeded = false
  const collect = (name, value) => {
    if (name === 'stdout') stdout += value
    else stderr += value
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 4 * 1024 * 1024) { exceeded = true; child.kill('SIGTERM') }
  }
  child.stdout.on('data', value => collect('stdout', value))
  child.stderr.on('data', value => collect('stderr', value))
  child.once('error', reject)
  child.once('exit', (code, signal) => done({ code, signal, exceeded, stdout, stderr }))
})

// Compile the exact production state machine into a portable test executable.
// NativeFailure is only the transport exception stub; no Win32 adapter is linked.
export async function testWindowsForegroundHandoffCore({ dotnet = process.env.QIUYA_DOTNET || 'dotnet', output = join(tmpdir(), 'qiuya-foreground-core-' + randomUUID()) } = {}) {
  output = resolve(output)
  await mkdir(output, { recursive: false })
  const before = await snapshot()
  await writeFile(join(output, 'ForegroundHandoffCore.cs'), await readFile(join(root, inputs[0])))
  await writeFile(join(output, 'Program.cs'), await readFile(join(root, inputs[1])))
  await writeFile(join(output, 'test.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings><TreatWarningsAsErrors>true</TreatWarningsAsErrors><NuGetAudit>false</NuGetAudit></PropertyGroup></Project>\n')
  await writeFile(join(output, 'NuGet.Config'), '<configuration><packageSources><clear /></packageSources></configuration>\n')
  const copied = [await readFile(join(output, 'ForegroundHandoffCore.cs')), await readFile(join(output, 'Program.cs'))]
  copied.forEach((bytes, index) => assert.equal(digest(bytes), before[index].sha256, 'Copied test input changed'))
  const env = { ...process.env, DOTNET_CLI_HOME: join(output, 'cli'), DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' }
  const startedAt = new Date().toISOString()
  const build = await execute(dotnet, ['build', join(output, 'test.csproj'), '--nologo', '--verbosity', 'quiet', '--configfile', join(output, 'NuGet.Config'), '-o', join(output, 'bin')], { cwd: output, env })
  await writeFile(join(output, 'build-stdout.log'), build.stdout); await writeFile(join(output, 'build-stderr.log'), build.stderr)
  assert.equal(build.code, 0, 'Foreground core build failed; see ' + output)
  assert.equal(build.signal, null); assert.equal(build.exceeded, false)
  const run = await execute(dotnet, [join(output, 'bin', 'test.dll')], { cwd: output, env })
  await writeFile(join(output, 'run-stdout.json'), run.stdout); await writeFile(join(output, 'run-stderr.log'), run.stderr)
  assert.equal(run.code, 0, 'Foreground core behavior failed; see ' + output)
  assert.equal(run.signal, null); assert.equal(run.exceeded, false)
  const result = JSON.parse(run.stdout)
  assert.equal(result.kind, 'production-foreground-handoff-core-behavior')
  assert.equal(result.passed, true); assert.equal(result.failed, 0); assert.equal(result.checks, 71)
  assert.equal(result.actualOsInput, false); assert.equal(result.win32Calls, 0)
  assert.equal(result.tests.length, result.checks); assert(result.tests.every(test => test.passed))
  const after = await snapshot(); assert.deepEqual(after, before, 'Production core/test fixture changed during execution')
  const report = { version: 1, kind: 'exact-production-foreground-core-portable-acceptance', status: 'passed', startedAt, finishedAt: new Date().toISOString(), dotnet, sourceBefore: before, sourceAfter: after, build: { code: build.code, signal: build.signal, stdoutSHA256: digest(build.stdout), stderrSHA256: digest(build.stderr) }, run: { code: run.code, signal: run.signal, stdoutSHA256: digest(run.stdout), stderrSHA256: digest(run.stderr) }, result }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  return { status: report.status, checks: result.checks, actualOsInput: false, win32Calls: 0, output, report: join(output, 'report.json') }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  assert(args.length === 0 || (args.length === 2 && args[0] === '--output'), 'Use --output <fresh directory>')
  console.log(JSON.stringify(await testWindowsForegroundHandoffCore(args.length ? { output: args[1] } : {}), null, 2))
}
