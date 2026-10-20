import type { UpdateCheckResult, UpdateProblem } from './contract.ts'
import { compareVersions, parseSemanticVersion } from './version.ts'
import { resolveGitHubRepository, validateReleaseMetadata, type GitHubRepository, type ValidatedRelease } from './release.ts'

export interface GitHubCheckResult extends Omit<UpdateCheckResult, 'release'> { release?: ValidatedRelease }
export interface GitHubReleaseCheckerOptions {
  repository?: unknown
  currentVersion: string
  packageName: string
  architecture?: 'arm64' | 'x64'
  fetch?: typeof fetch
  timeoutMs?: number
  cacheMs?: number
  now?: () => number
}

class CheckFailure extends Error {
  constructor(readonly problem: UpdateProblem) { super(problem.message) }
}

/** Read bounded JSON without accepting an arbitrarily large GitHub response. */
async function releaseJson(response: Response): Promise<unknown> {
  const maximum = 2 * 1024 * 1024
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new CheckFailure({ code: 'invalid-release', message: 'GitHub 返回的版本信息不完整，请稍后重试。' })
  const reader = response.body?.getReader()
  if (reader === undefined) throw new CheckFailure({ code: 'invalid-release', message: 'GitHub 没有返回版本信息，请稍后重试。' })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maximum) throw new CheckFailure({ code: 'invalid-release', message: 'GitHub 返回的版本信息过大，请稍后重试。' })
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    return JSON.parse(text) as unknown
  } finally { reader.releaseLock() }
}

/** Public stable-Release checks share one bounded request and never write local files. */
export class GitHubReleaseChecker {
  readonly repository: GitHubRepository | undefined
  readonly currentVersion: string
  private readonly request: typeof fetch
  private readonly timeoutMs: number
  private readonly cacheMs: number
  private readonly now: () => number
  private cached: { time: number; result: GitHubCheckResult } | undefined
  private pending: Promise<GitHubCheckResult> | undefined
  private controller: AbortController | undefined
  private closed = false

  constructor(private readonly options: GitHubReleaseCheckerOptions) {
    const version = parseSemanticVersion(options.currentVersion)
    if (version === undefined) throw new Error('Invalid installed plugin version')
    this.currentVersion = version.version
    this.repository = resolveGitHubRepository(options.repository)
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? 12_000
    this.cacheMs = options.cacheMs ?? 5 * 60_000
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000 || !Number.isInteger(this.cacheMs) || this.cacheMs < 0 || this.cacheMs > 24 * 60 * 60_000) throw new Error('Invalid update request limits')
    this.now = options.now ?? Date.now
  }

  check(options: { force?: boolean } = {}): Promise<GitHubCheckResult> {
    if (this.closed) return Promise.resolve(this.failure('disposed', '更新检查已停止，请重新打开插件设置。'))
    if (this.repository === undefined) return Promise.resolve({ status: 'not-configured', currentVersion: this.currentVersion, canInstall: false })
    if (this.pending !== undefined) return this.pending
    if (!options.force && this.cached !== undefined && this.now() - this.cached.time < this.cacheMs) return Promise.resolve(this.cached.result)
    const pending = this.read().then(result => {
      if (!this.closed && result.status !== 'error') this.cached = { time: this.now(), result }
      return result
    }).finally(() => { if (this.pending === pending) this.pending = undefined })
    this.pending = pending
    return pending
  }

  dispose(): void { this.closed = true; this.cached = undefined; this.controller?.abort() }

  private failure(code: UpdateProblem['code'], message: string): GitHubCheckResult {
    return { status: 'error', currentVersion: this.currentVersion, repository: this.repository?.url, canInstall: false, problem: { code, message } }
  }

  private async read(): Promise<GitHubCheckResult> {
    const repository = this.repository!
    const controller = new AbortController()
    this.controller = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    const base = { currentVersion: this.currentVersion, repository: repository.url }
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new CheckFailure({ code: 'timeout', message: '连接 GitHub 超时，请检查网络或代理后重试。' }))
        }, this.timeoutMs)
      })
      const operation = (async (): Promise<GitHubCheckResult> => {
        const response = await this.request(`https://api.github.com/repos/${repository.owner}/${repository.repo}/releases/latest`, {
          method: 'GET', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: controller.signal,
        })
        if (response.status === 404) return { ...base, status: 'no-release', canInstall: false }
        if (response.status === 403 || response.status === 429) throw new CheckFailure({ code: 'rate-limited', message: 'GitHub 暂时限制了版本检查，请稍后重试。' })
        if (!response.ok) throw new CheckFailure({ code: 'network', message: '暂时无法连接 GitHub，请检查网络或代理后重试。' })
        let release: ValidatedRelease
        try { release = validateReleaseMetadata(await releaseJson(response), repository, this.options.packageName, this.options.architecture ?? 'arm64') }
        catch (error) {
          if (error instanceof CheckFailure) throw error
          throw new CheckFailure({ code: 'invalid-release', message: 'GitHub 的版本或安装包信息不完整，暂时无法更新。' })
        }
        const available = compareVersions(this.currentVersion, release.version) < 0
        return { ...base, status: available ? 'available' : 'up-to-date', release, canInstall: available && release.asset !== undefined }
      })()
      return await Promise.race([operation, deadline])
    } catch (error) {
      if (this.closed) return this.failure('disposed', '更新检查已停止，请重新打开插件设置。')
      if (error instanceof CheckFailure) return this.failure(error.problem.code, error.problem.message)
      if (controller.signal.aborted) return this.failure('timeout', '连接 GitHub 超时，请检查网络或代理后重试。')
      return this.failure('network', '暂时无法连接 GitHub，请检查网络或代理后重试。')
    } finally {
      clearTimeout(timer)
      controller.abort()
      if (this.controller === controller) this.controller = undefined
    }
  }
}
