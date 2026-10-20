import { spawn } from 'node:child_process'
import { access, mkdir, stat, writeFile, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve, join, dirname } from 'node:path'

export const WINDOWS_NATIVE_SDK_VERSION = '8.0.426'
export async function buildWindowsNative({ architectures = ['arm64', 'x64'], dotnet = process.env.QIUYA_DOTNET || 'dotnet', outputRoot = fileURLToPath(new URL('../lib/native/', import.meta.url)), intermediateRoot = process.env.QIUYA_NATIVE_INTERMEDIATE || fileURLToPath(new URL('../.native-build/windows/', import.meta.url)) } = {}) {
  if (architectures.some(arch => !['arm64', 'x64'].includes(arch))) throw new Error('Unsupported Windows architecture')
  const project = fileURLToPath(new URL('../src/native/windows/QiuYaTools.Windows.csproj', import.meta.url))
  const sdkVersion = await new Promise((done, reject) => {
    const child = spawn(dotnet, ['--version'], { cwd: dirname(project), stdio: ['ignore', 'pipe', 'pipe'] })
    let value = ''; child.stdout.on('data', chunk => { value += chunk }); child.stderr.resume()
    child.once('error', reject); child.once('exit', code => code === 0 ? done(value.trim()) : reject(new Error('The pinned Windows native SDK is unavailable')))
  })
  if (sdkVersion !== WINDOWS_NATIVE_SDK_VERSION) throw new Error(`Windows native builds require .NET SDK ${WINDOWS_NATIVE_SDK_VERSION}`)
  const manifests = []
  for (const architecture of architectures) {
    const output = join(outputRoot, `win32-${architecture}`)
    await mkdir(output, { recursive: true })
    const args = ['publish', project, '-c', 'Release', '-r', `win-${architecture}`, '--self-contained', 'true', '-o', output, '-p:EnableWindowsTargeting=true', `-p:BaseIntermediateOutputPath=${join(intermediateRoot, architecture)}/`, '-p:ContinuousIntegrationBuild=true', '--nologo']
    await new Promise((done, reject) => {
      const child = spawn(dotnet, args, { cwd: dirname(project), stdio: 'inherit', env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? done() : reject(new Error(`Windows native publish failed (${code})`)))
    })
    const path = join(output, 'qiuya-windows.exe')
    await access(path)
    for (const notice of ['WEBVIEW2-LICENSE.txt', 'WEBVIEW2-NOTICE.txt', 'DOTNET-LICENSE.txt', 'DOTNET-THIRD-PARTY-NOTICES.txt']) await copyFile(new URL(`../src/native/windows/${notice}`, import.meta.url), join(output, notice))
    const bytes = await readFile(path)
    const machine = bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4)
    if (bytes.subarray(0, 2).toString() !== 'MZ' || machine !== (architecture === 'arm64' ? 0xaa64 : 0x8664)) throw new Error('Wrong Windows executable architecture')
    manifests.push({ platform: 'win32', architecture, protocolVersion: 1, file: `win32-${architecture}/qiuya-windows.exe`, bytes: (await stat(path)).size, sha256: createHash('sha256').update(bytes).digest('hex'), selfContained: true })
  }
  await writeFile(join(outputRoot, 'windows-manifest.json'), JSON.stringify({ sdk: WINDOWS_NATIVE_SDK_VERSION, artifacts: manifests }, null, 2) + '\n')
  return manifests
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const requested = process.argv.slice(2)
  await buildWindowsNative({ ...(requested.length ? { architectures: requested } : {}) })
}
