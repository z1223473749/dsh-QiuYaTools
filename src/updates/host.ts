import type { Context } from '@deepseek-ai/cordis'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GitHubReleaseChecker, type GitHubCheckResult } from './check.ts'
import { validateUpdateArchive } from './archive.ts'
import type { ReleaseAsset } from './release.ts'
import { parseSemanticVersion } from './version.ts'
import { UPDATES_CHANNEL, UPDATES_CHECK_ENDPOINT, UPDATES_INSTALL_ENDPOINT, type UpdateCheckResult, type UpdateInstallResult, type UpdateProblem } from './contract.ts'

interface ChangeResult {
  application: 'applied' | 'restart-required' | 'failed' | 'cancelled' | 'overridden'
  changed: boolean
  bundle?: string
  version?: string
  error?: { code?: string }
}
interface PluginManager {
  installBundle(spec: string, options: { enabled: boolean; requestId: string; saveExact: boolean }): Promise<ChangeResult>
  cancelInstall?(requestId: string): Promise<unknown>
}
interface HostServices {
  connection: {
    browserPeer?: { principal: { kind: string } }
    fetch: { register(route: { path: string; methods: readonly ['POST']; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): () => Promise<void> }
  }
  get?(name: string): unknown
}
export interface PluginUpdateHostOptions {
  repository?: unknown
  version: string
  packageName: string
  /** Injectable for bounded network tests; production uses the Host's standard Fetch implementation. */
  fetch?: typeof fetch
}
class UpdateFailure extends Error {
  constructor(readonly problem: UpdateProblem) { super(problem.message) }
}
function fail(code: UpdateProblem['code'], message: string): never { throw new UpdateFailure({ code, message }) }
const MAX_ASSET_BYTES = 64 * 1024 * 1024

/** Only GitHub's own release CDN may follow the already repository-bound download URL. */
export function isGitHubAssetRedirect(value: string): boolean {
  if (/[\s\\]/u.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
      && ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)
  } catch { return false }
}

async function downloadAsset(asset: ReleaseAsset, request: typeof fetch, lifetime: AbortSignal): Promise<Uint8Array> {
  const deadline = AbortSignal.timeout(60_000)
  const abort = new AbortController()
  const signal = AbortSignal.any([lifetime, deadline, abort.signal])
  try {
    let url = asset.url
    let response: Response | undefined
    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await request(url, { method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { Accept: 'application/octet-stream' }, signal })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get('location')
      if (location === null || !isGitHubAssetRedirect(location) || redirects === 3) fail('download-failed', 'GitHub 安装包的下载地址异常，请稍后重试。')
      await response.body?.cancel()
      url = location
      response = undefined
    }
    if (response === undefined || !response.ok) fail('download-failed', '无法下载 GitHub 安装包，请检查网络或代理后重试。')
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== asset.size)) fail('integrity-failed', '安装包大小与 GitHub 发布信息不一致，已停止更新。')
    const reader = response.body?.getReader()
    if (reader === undefined) fail('download-failed', 'GitHub 没有返回安装包，请稍后重试。')
    const chunks: Uint8Array[] = []
    let size = 0
    const digest = createHash('sha256')
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > asset.size || size > MAX_ASSET_BYTES) fail('integrity-failed', '安装包大小异常，已停止更新。')
        digest.update(chunk.value)
        chunks.push(chunk.value)
      }
    } finally { reader.releaseLock() }
    if (size !== asset.size || digest.digest('hex') !== asset.sha256) fail('integrity-failed', '安装包完整性校验失败，已停止更新，请重试。')
    return Buffer.concat(chunks)
  } catch (error) {
    if (error instanceof UpdateFailure) throw error
    if (lifetime.aborted) fail('disposed', '插件已停止，更新没有继续。')
    if (deadline.aborted) fail('timeout', '下载 GitHub 安装包超时，请检查网络或代理后重试。')
    fail('download-failed', '无法下载 GitHub 安装包，请检查网络或代理后重试。')
  } finally { abort.abort() }
}

/** Keep immutable content-addressed packages in the profile, never in pnpm's shared store. */
async function cacheArchive(profileDirectory: string, asset: ReleaseAsset, bytes: Uint8Array): Promise<string> {
  const profile = await realpath(profileDirectory)
  const cache = join(profile, 'qiuya-tools-updates')
  await mkdir(cache, { recursive: true, mode: 0o700 })
  if (await realpath(cache) !== cache || !(await lstat(cache)).isDirectory()) fail('profile-unavailable', '更新缓存目录异常，已停止更新。')
  const destination = join(cache, `${asset.sha256}.tgz`)
  try {
    const stat = await lstat(destination)
    if (!stat.isFile() || stat.isSymbolicLink()) fail('profile-unavailable', '更新缓存文件异常，已停止更新。')
    if (stat.size === bytes.byteLength && createHash('sha256').update(await readFile(destination)).digest('hex') === asset.sha256) return destination
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = await mkdtemp(join(cache, '.download-'))
  try {
    const file = join(temporary, 'package.tgz')
    const handle = await open(file, 'wx', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await rename(file, destination)
    return destination
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

/** Authenticated update checks and explicit installs; configuration and package ownership stay with Harness. */
export function installPluginUpdatesHost(ctx: Context, options: PluginUpdateHostOptions): () => void {
  const services = ctx as unknown as HostServices
  const request = options.fetch ?? globalThis.fetch.bind(globalThis)
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
  const checker = new GitHubReleaseChecker({ repository: options.repository, currentVersion: options.version, packageName: options.packageName, architecture, fetch: request })
  const lifetime = new AbortController()
  let disposed = false
  let pendingVersion: string | undefined
  let installing: { version: string; promise: Promise<UpdateInstallResult> } | undefined
  let requestId: string | undefined
  const manager = (): PluginManager | undefined => services.get?.('pluginManager') as PluginManager | undefined
  const profile = (): { dir?: unknown } | undefined => services.get?.('profileContext') as { dir?: unknown } | undefined
  const eligibility = (result: GitHubCheckResult): UpdateProblem | undefined => {
    if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) return { code: 'platform-unsupported', message: '当前自动更新安装包仅支持 macOS。' }
    if (manager()?.installBundle === undefined) return { code: 'manager-unavailable', message: 'Harness 插件管理服务尚未就绪，请稍后重试。' }
    if (typeof profile()?.dir !== 'string') return { code: 'profile-unavailable', message: '当前 Harness 配置不支持自动更新安装。' }
    if (result.release?.asset === undefined) return { code: 'asset-unavailable', message: '此版本尚未发布可用的 macOS 安装包，请稍后重试。' }
    return undefined
  }
  const check = async (force = false): Promise<UpdateCheckResult> => {
    const checked = await checker.check({ force })
    const problem = checked.status === 'available' ? eligibility(checked) : checked.problem
    const release = checked.release === undefined ? undefined : {
      version: checked.release.version, tag: checked.release.tag, url: checked.release.url,
      title: checked.release.title, notes: checked.release.notes, publishedAt: checked.release.publishedAt,
    }
    return { ...checked, release, canInstall: checked.status === 'available' && problem === undefined && pendingVersion === undefined, problem, ...pendingVersion === undefined ? {} : { pendingVersion } }
  }
  const install = (version: string): Promise<UpdateInstallResult> => {
    if (pendingVersion !== undefined) return Promise.resolve({ status: 'restart-required', currentVersion: checker.currentVersion, version: pendingVersion })
    if (installing !== undefined) return installing.version === version ? installing.promise : Promise.resolve({ status: 'failed', currentVersion: checker.currentVersion, problem: { code: 'install-failed', message: '另一项更新正在安装，请等待完成。' } })
    const operation = (async (): Promise<UpdateInstallResult> => {
      try {
        if (disposed) fail('disposed', '插件已停止，请重新打开设置后重试。')
        const fresh = await checker.check({ force: true })
        if (fresh.status === 'error') throw new UpdateFailure(fresh.problem!)
        if (fresh.status === 'up-to-date') return { status: 'already-current', currentVersion: checker.currentVersion, version: fresh.release?.version }
        if (fresh.status !== 'available' || fresh.release?.version !== version) fail('version-changed', '发布版本已变化，请重新检查更新。')
        const problem = eligibility(fresh)
        if (problem !== undefined) throw new UpdateFailure(problem)
        const asset = fresh.release.asset!
        const bytes = await downloadAsset(asset, request, lifetime.signal)
        try { validateUpdateArchive(bytes, { packageName: options.packageName, version, architecture }) }
        catch { fail('archive-invalid', '安装包内容或系统架构不匹配，已停止更新。') }
        if (disposed) fail('disposed', '插件已停止，更新没有继续。')
        const directory = profile()?.dir
        if (typeof directory !== 'string') fail('profile-unavailable', '当前 Harness 配置不支持自动更新安装。')
        const path = await cacheArchive(directory, asset, bytes)
        if (disposed) fail('disposed', '插件已停止，更新没有继续。')
        const pluginManager = manager()
        if (pluginManager?.installBundle === undefined) fail('manager-unavailable', 'Harness 插件管理服务尚未就绪，请稍后重试。')
        requestId = randomUUID()
        const result = await pluginManager.installBundle(`file:${path}`, { enabled: true, requestId, saveExact: true })
        if (!['applied', 'restart-required'].includes(result.application) || result.bundle !== options.packageName || result.version !== version) fail('install-failed', 'Harness 未能完成插件更新，原有功能设置已保留，请重试。')
        pendingVersion = version
        // Native helper and Host modules may still be resident even after a Client refresh.
        return { status: 'restart-required', currentVersion: checker.currentVersion, version }
      } catch (error) {
        return { status: 'failed', currentVersion: checker.currentVersion, version, problem: error instanceof UpdateFailure ? error.problem : { code: 'install-failed', message: '更新没有完成，原有插件设置已保留，请检查网络后重试。' } }
      } finally { requestId = undefined }
    })()
    const promise = operation.finally(() => { if (installing?.promise === promise) installing = undefined })
    installing = { version, promise }
    return promise
  }
  const unregister = ([UPDATES_CHECK_ENDPOINT, UPDATES_INSTALL_ENDPOINT] as const).map(endpoint => services.connection.fetch.register({
    path: `${UPDATES_CHANNEL}/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
    fetch: async incoming => {
      if (services.connection.browserPeer?.principal.kind !== 'owner') return new Response('Forbidden', { status: 403 })
      let input: unknown
      try { input = await incoming.json() } catch { return new Response('Invalid update request', { status: 400 }) }
      if (input === null || typeof input !== 'object') return new Response('Invalid update request', { status: 400 })
      const envelope = input as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
      if (envelope.type !== 'client-request' || typeof envelope.rpcId !== 'string' || !envelope.rpcId || envelope.rpcId.length > 256
        || /[\x00-\x1f\x7f]/u.test(envelope.rpcId) || envelope.method !== endpoint || envelope.payload === null || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) return new Response('Invalid update envelope', { status: 400 })
      const payload = envelope.payload as Record<string, unknown>
      if (endpoint === UPDATES_CHECK_ENDPOINT && (Object.keys(payload).some(key => key !== 'force') || payload.force !== undefined && typeof payload.force !== 'boolean')) return new Response('Invalid check request', { status: 400 })
      if (endpoint === UPDATES_INSTALL_ENDPOINT && (Object.keys(payload).some(key => key !== 'version') || typeof payload.version !== 'string' || parseSemanticVersion(payload.version) === undefined)) return new Response('Invalid install request', { status: 400 })
      const value = endpoint === UPDATES_CHECK_ENDPOINT ? await check(payload.force === true) : await install(payload.version as string)
      return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } })
    },
  }))
  return () => {
    if (disposed) return
    disposed = true
    lifetime.abort()
    checker.dispose()
    const id = requestId
    if (id !== undefined) void manager()?.cancelInstall?.(id).catch(() => {})
    for (const stop of unregister) void stop()
  }
}
