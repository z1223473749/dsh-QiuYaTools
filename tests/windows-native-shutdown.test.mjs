import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const hash = value => createHash('sha256').update(value).digest('hex')
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
function block(source, anchor) {
  assert.equal(source.split(anchor).length - 1, 1, `Actual source anchor must be unique: ${anchor}`)
  const start = source.indexOf(anchor), open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1)
  }
  assert.fail(`Actual source block is incomplete: ${anchor}`)
}
async function execute(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', errors = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { errors += value })
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }))
  })
  assert.equal(result.signal, null, `Pure C# regression must finish naturally\n${errors}\n${output}`)
  assert.equal(result.code, 0, `${errors}\n${output}`)
  return output
}

test('actual Windows shutdown separates confirmed input release from bounded browser retirement without GUI', { timeout: 90_000 }, async t => {
  const dotnet = process.env.QIUYA_DOTNET
  assert(dotnet, 'Set QIUYA_DOTNET to the explicit .NET8 SDK; this required regression never skips')
  const paths = [
    '../src/native/windows/Program.cs', '../src/native/windows/BrowserWindows.cs',
    '../src/native/windows/BrowserExitState.cs', './fixtures/windows-native-shutdown/Program.cs',
  ].map(path => fileURLToPath(new URL(path, import.meta.url)))
  const inputs = await Promise.all(paths.map(path => readFile(path)))
  const before = inputs.map(hash)
  const program = inputs[0].toString(), windows = inputs[1].toString()
  const shutdown = block(program, '    private async void Shutdown()')
  const barrier = block(windows, '    internal async Task ShutdownAsync(int remainingMilliseconds)')
  assert.match(shutdown, /await windows\.ShutdownAsync\(WindowManager\.BrowserShutdownMilliseconds\)/u, 'The actual entry must use the independently declared browser bound')
  const bounds = windows.match(/^    internal const int BrowserShutdownMilliseconds = 5_000;$/gmu)
  assert.equal(bounds?.length, 1, 'The real product must own exactly one explicit browser drain bound')
  const temporary = await mkdtemp(join(tmpdir(), 'qiuya-native-two-phase-shutdown-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const extracted = join(temporary, 'ActualShutdown.cs')
  await writeFile(extracted, `using System.Diagnostics;namespace QiuYaTools.Windows;internal sealed partial class NativeContext{${shutdown}}internal sealed partial class WindowManager{${bounds[0]}${barrier}}\n`)
  const project = join(temporary, 'NativeShutdown.csproj'), config = join(temporary, 'NuGet.Config')
  await writeFile(config, '<configuration><packageSources><clear /></packageSources></configuration>\n')
  await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><TreatWarningsAsErrors>true</TreatWarningsAsErrors><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup><Compile Include="${xml(extracted)}"/><Compile Include="${xml(paths[2])}" Link="BrowserExitState.cs"/><Compile Include="${xml(paths[3])}" Link="Program.cs"/></ItemGroup></Project>\n`)
  const options = { cwd: temporary, env: { ...process.env, DOTNET_CLI_HOME: join(temporary, 'dotnet-home'), DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } }
  const compilerOutput = await execute(dotnet, ['build', project, '--configuration', 'Release', '--configfile', config, '--disable-build-servers', '--nologo'], options)
  const controlOutput = await execute(dotnet, [join(temporary, 'bin/Release/net8.0/NativeShutdown.dll')], options)
  const result = JSON.parse(controlOutput.trim())
  assert.equal(result.passed, true)
  assert.equal(result.tests.length, 19)
  assert(result.tests.every(row => row.passed === true))
  assert.equal(new Set(result.tests.map(row => row.name)).size, result.tests.length)
  for (const key of ['GUI', 'Host', 'PD', 'model', 'input', 'nativeWindows']) assert.equal(result[key], 0)
  assert.deepEqual(await Promise.all(paths.map(async path => hash(await readFile(path)))), before, 'All real product and fixture bytes remain unchanged')
  if (process.env.QIUYA_NATIVE_SHUTDOWN_EVIDENCE) {
    const evidence = process.env.QIUYA_NATIVE_SHUTDOWN_EVIDENCE
    await mkdir(evidence, { recursive: true })
    await Promise.all([
      writeFile(join(evidence, 'actual-extracted-shutdown.cs'), await readFile(extracted)),
      writeFile(join(evidence, 'compiler.stdout'), compilerOutput),
      writeFile(join(evidence, 'csharp-control.stdout'), controlOutput),
      writeFile(join(evidence, 'source-pins.json'), JSON.stringify(paths.map((path, index) => ({ path, sha256: before[index] })), null, 2) + '\n'),
    ])
  }
})
