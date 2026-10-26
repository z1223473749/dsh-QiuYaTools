import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '../../package.json' with { type: 'json' }
import { ComputerError } from '../features/computer-use/contract.ts'
import { helperArchitectures, windowsExecutableArchitecture } from '../updates/archive.ts'

export type NativeComponent = 'computer' | 'session-window'
export interface NativeRuntimeOptions {
  platform?: NodeJS.Platform
  architecture?: string
  /** Directory containing the installed Host bundle, never the source tree. */
  base?: URL
  version?: string
}

export function nativePackageName(platform: NodeJS.Platform, architecture: string): string {
  if (!['arm64', 'x64'].includes(architecture)) throw new ComputerError('PLATFORM_UNSUPPORTED', '此系统架构暂无原生组件。')
  if (platform === 'darwin') return 'dsh-qiuya-tools-native-darwin-universal'
  if (platform === 'win32') return `dsh-qiuya-tools-native-win32-${architecture}`
  throw new ComputerError('PLATFORM_UNSUPPORTED', '此系统暂无原生组件。')
}

/** Existing complete platform archives keep their original on-disk layout. */
export function bundledNativePath(component: NativeComponent, platform: NodeJS.Platform, architecture: string, base: URL): string {
  nativePackageName(platform, architecture)
  if (platform === 'win32') return fileURLToPath(new URL(`./native/win32-${architecture}/qiuya-windows.exe`, base))
  const file = component === 'computer' ? 'QiuYaTools Computer.app/Contents/MacOS/qiuya-computer' : 'QiuYaTools Sessions.app/Contents/MacOS/qiuya-session-window'
  return fileURLToPath(new URL(file, base))
}

const verified = new Map<string, string>()
function verify(root: string, component: NativeComponent, platform: NodeJS.Platform, architecture: string, version: string): string {
  const library = join(root, 'lib')
  const relative = platform === 'win32' ? `win32-${architecture}/qiuya-windows.exe`
    : component === 'computer' ? 'QiuYaTools Computer.app/Contents/MacOS/qiuya-computer' : 'QiuYaTools Sessions.app/Contents/MacOS/qiuya-session-window'
  const manifestPath = platform === 'win32' ? join(library, 'native/windows-manifest.json') : join(library, 'macos-manifest.json')
  const executable = platform === 'win32' ? join(library, 'native', relative) : join(library, relative)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.version !== version || manifest.protocolVersion !== 1 || !Array.isArray(manifest.artifacts)) throw new Error('version')
  const matches = manifest.artifacts.filter((entry: Record<string, unknown>) => entry?.file === relative)
  if (matches.length !== 1) throw new Error('manifest')
  const artifact = matches[0]
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) throw new Error('manifest')
  if (platform === 'win32' && (artifact.platform !== 'win32' || artifact.architecture !== architecture || artifact.protocolVersion !== 1 || artifact.selfContained !== true)) throw new Error('architecture')
  const file = statSync(executable)
  if (!file.isFile() || file.size !== artifact.bytes) throw new Error('size')
  accessSync(executable, constants.X_OK)
  const signature = `${version}|${platform}|${architecture}|${artifact.sha256}|${file.size}|${file.mtimeMs}|${file.ctimeMs}`
  if (verified.get(executable) !== signature) {
    const bytes = readFileSync(executable)
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('digest')
    if (platform === 'win32' ? windowsExecutableArchitecture(bytes) !== architecture : !helperArchitectures(bytes).includes(architecture as 'arm64' | 'x64')) throw new Error('architecture')
    verified.set(executable, signature)
  }
  return executable
}

/**
 * Git/npm installs receive script-free, platform-filtered optional packages.
 * Resolve those alongside the installed plugin; never download, compile, or
 * mutate pnpm's store at runtime. Complete .tgz installs remain self-contained.
 */
export function resolveNativeExecutable(component: NativeComponent, options: NativeRuntimeOptions = {}): string {
  const platform = options.platform ?? process.platform, architecture = options.architecture ?? process.arch
  const name = nativePackageName(platform, architecture)
  const base = options.base ?? new URL('./', import.meta.url), version = options.version ?? pkg.version
  const bundledRoot = dirname(fileURLToPath(base))
  try { return verify(bundledRoot, component, platform, architecture, version) } catch { /* Git trees may contain only the older session helper. */ }
  try {
    const dependency = createRequire(new URL('index.js', base)).resolve(`${name}/package.json`)
    const metadata = JSON.parse(readFileSync(dependency, 'utf8'))
    if (metadata.name !== name || metadata.version !== version || !metadata.os?.includes(platform) || !metadata.cpu?.includes(architecture)) throw new Error('package')
    return verify(dirname(dependency), component, platform, architecture, version)
  } catch {
    const label = platform === 'win32' ? `Windows ${architecture}` : 'macOS'
    throw new ComputerError('NATIVE_INSTALLATION_INCOMPLETE', `${label} 原生组件未完整安装或与插件版本不匹配。请在 Harness 插件管理中重新安装 QiuYaTools，并确认安装未跳过可选依赖；也可安装同版本的对应系统 .tgz 完整包。无需单独启动执行器或安装开发工具。`)
  }
}
