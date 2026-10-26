import { GitError, type GitProvider, type GitPullRequest, type GitPullRequestInput, type GitRemoteRepository } from './contract.ts'

const hosts: Record<string, GitProvider> = { 'github.com': 'github', 'gitlab.com': 'gitlab', 'gitee.com': 'gitee' }
const apiBases: Record<GitProvider, string> = { github: 'https://api.github.com', gitlab: 'https://gitlab.com/api/v4', gitee: 'https://gitee.com/api/v5' }
const RESPONSE_LIMIT = 2 * 1024 * 1024
type JSONRecord = Record<string, unknown>
const record = (value: unknown): JSONRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JSONRecord : {}
const string = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback
const segment = (value: string): boolean => !!value && value !== '.' && value !== '..' && !/[\s\u0000-\u001f\u007f/:\\?#%]/u.test(value)

/** Interpret Git remotes without returning embedded credentials or accepting an API destination from them. */
export function parseGitRemote(raw: string): GitRemoteRepository | undefined {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\u0000-\u001f\u007f]/u.test(raw)) return
  let host: string, path: string
  try {
    if (/^[^/@:\s]+@[^/:\s]+:/u.test(raw)) {
      const match = /^[^/@:\s]+@([^/:\s]+):(.+)$/u.exec(raw)!
      host = match[1].toLowerCase(); path = match[2]
    } else {
      const url = new URL(raw)
      if (!['https:', 'ssh:', 'git:'].includes(url.protocol) || url.search || url.hash || url.port && !(url.protocol === 'ssh:' && url.port === '22')) return
      host = url.hostname.toLowerCase(); path = decodeURIComponent(url.pathname)
    }
    path = path.replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '')
    const provider = hosts[host], parts = path.split('/')
    if (!provider || parts.some(part => !segment(part)) || parts.length < 2 || provider !== 'gitlab' && parts.length !== 2) return
    const repository = parts.at(-1)!, owner = parts.slice(0, -1).join('/'), fullName = `${owner}/${repository}`
    return { provider, hostname: host, owner, repository, fullName, webUrl: `https://${host}/${parts.map(encodeURIComponent).join('/')}`, apiBase: apiBases[provider] }
  } catch { return }
}

/** Capabilities are based on the documented public APIs; Gitee cannot retarget an existing PR. */
export function gitProviderCapabilities(repo: GitRemoteRepository) { return { draft: true, retarget: repo.provider !== 'gitee' } }

function branchName(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\u0000-\u0020\u007f~^:?*\[\\]/u.test(value) || value.includes('..') || value.includes('@{') || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) throw new GitError('PR_INVALID_BRANCH', 'PR 分支名称无效。')
  return value
}

function inputText(value: unknown, max: number, required: boolean): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || required && !value.trim()) throw new GitError('PR_INVALID_INPUT', 'PR 标题或说明无效。')
  return value
}

/** Bound even an injected transport/body reader that does not implement AbortSignal itself. */
function untilSignal<T>(pending: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = () => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); reject(new GitError('PR_NETWORK', '代码托管平台连接中断或超时，请刷新状态后重试。')) }
    signal.addEventListener('abort', abort, { once: true })
    pending.then(value => { if (settled) { late?.(value); return }; settled = true; signal.removeEventListener('abort', abort); resolve(value) }, error => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) abort()
  })
}

function checkStatus(raw: JSONRecord): GitPullRequest['checkStatus'] {
  const pipeline = record(raw.head_pipeline), status = string(pipeline.status || raw.check_status)
  if (['success', 'passed'].includes(status)) return 'success'
  if (['failed', 'failure', 'canceled', 'cancelled', 'error'].includes(status)) return 'failure'
  if (['pending', 'running', 'created', 'preparing', 'waiting_for_resource', 'scheduled'].includes(status)) return 'pending'
  return 'unknown'
}

/** Three provider dialects over bounded, cancellable HTTPS requests; never shells out or pushes branches. */
export class GitProviderClient {
  readonly repo: GitRemoteRepository
  readonly draftSupported = true
  readonly targetBranchEditable: boolean
  private readonly requestFetch: typeof fetch
  private readonly token: string
  private readonly assertCurrent: () => void
  constructor(repo: GitRemoteRepository, token: string, options: { fetch?: typeof fetch; assertCurrent?: () => void } = {}) {
    const actual = parseGitRemote(repo.webUrl)
    if (!actual || actual.provider !== repo.provider || actual.hostname !== repo.hostname || actual.fullName !== repo.fullName || actual.apiBase !== repo.apiBase || actual.owner !== repo.owner || actual.repository !== repo.repository) throw new GitError('PR_INVALID_REPOSITORY', '代码托管仓库地址无效。')
    if (typeof token !== 'string' || token.length > 8192 || /[\u0000-\u0020\u007f]/u.test(token)) throw new GitError('PR_INVALID_CREDENTIAL', '访问令牌无效。')
    this.repo = Object.freeze({ ...actual }); this.token = token; this.requestFetch = options.fetch ?? fetch; this.targetBranchEditable = gitProviderCapabilities(actual).retarget; this.assertCurrent = options.assertCurrent ?? (() => {})
  }

  private get collection(): string {
    return this.repo.provider === 'gitlab' ? `/projects/${encodeURIComponent(this.repo.fullName)}/merge_requests` : `/repos/${encodeURIComponent(this.repo.owner)}/${encodeURIComponent(this.repo.repository)}/pulls`
  }

  private async request(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, query: Record<string, string>, data: JSONRecord | undefined, ownerSignal: AbortSignal): Promise<unknown> {
    this.assertCurrent()
    ownerSignal.throwIfAborted()
    if (method !== 'GET' && !this.token) throw new GitError('PR_AUTH_REQUIRED', '请先配置当前代码托管平台的访问令牌。')
    const url = new URL(this.repo.apiBase + path)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'QiuYaTools-Git' }
    if (this.token) headers[this.repo.provider === 'gitlab' ? 'PRIVATE-TOKEN' : 'Authorization'] = this.repo.provider === 'gitlab' ? this.token : `Bearer ${this.token}`
    if (this.repo.provider === 'github') { headers.Accept = 'application/vnd.github+json'; headers['X-GitHub-Api-Version'] = '2022-11-28' }
    let body: string | undefined
    if (data) {
      // Gitee's v5 Swagger declares formData parameters. Bearer auth keeps the token out of URLs and bodies.
      headers['Content-Type'] = this.repo.provider === 'gitee' ? 'application/x-www-form-urlencoded' : 'application/json'
      body = this.repo.provider === 'gitee' ? new URLSearchParams(Object.entries(data).map(([key, value]) => [key, String(value)])).toString() : JSON.stringify(data)
    }
    const signal = AbortSignal.any([ownerSignal, AbortSignal.timeout(15_000)])
    let response: Response
    this.assertCurrent()
    try { response = await untilSignal(this.requestFetch(url.href, { method, headers, ...(body === undefined ? {} : { body }), redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal }), signal, value => { void value.body?.cancel().catch(() => {}) }) }
    catch { throw new GitError('PR_NETWORK', '代码托管平台连接中断或超时，请刷新状态后重试。') }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      if (response.status === 401) throw new GitError('PR_AUTH_REQUIRED', '访问令牌无效或已过期。')
      if (response.status === 429 || response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') throw new GitError('PR_RATE_LIMITED', '代码托管平台请求频率已达限制，请稍后刷新。')
      if (response.status === 403) throw new GitError('PR_FORBIDDEN', '当前账户没有执行此操作的权限。')
      if (response.status === 404) throw new GitError('PR_NOT_FOUND', '仓库或 PR 不存在，或当前账户没有访问权限。')
      if ([400, 409, 422].includes(response.status)) throw new GitError('PR_VALIDATION', 'PR 参数被平台拒绝，请检查分支、标题和当前仓库状态。')
      throw new GitError('PR_REMOTE_ERROR', '代码托管平台暂时无法完成请求。')
    }
    if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT) { void response.body?.cancel().catch(() => {}); throw new GitError('PR_RESPONSE_LIMIT', '平台返回的数据过大，请缩小查询范围。') }
    const reader = response.body?.getReader()
    if (!reader) throw new GitError('PR_RESPONSE_INVALID', '平台没有返回可读取的 PR 数据。')
    const chunks: Uint8Array[] = []; let size = 0
    try {
      while (true) {
        signal.throwIfAborted()
        const next = await untilSignal(reader.read(), signal)
        if (next.done) break
        size += next.value.byteLength
        if (size > RESPONSE_LIMIT) throw new GitError('PR_RESPONSE_LIMIT', '平台返回的数据过大，请缩小查询范围。')
        chunks.push(next.value)
      }
      const bytes = new Uint8Array(size); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      signal.throwIfAborted(); return parsed
    } catch (error) { if (error instanceof GitError) throw error; throw new GitError('PR_RESPONSE_INVALID', '平台返回的数据不完整，请刷新 PR 状态。') }
    finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
  }

  private normalize(value: unknown): GitPullRequest {
    const raw = record(value), gitlab = this.repo.provider === 'gitlab', number = gitlab ? raw.iid : raw.number
    const source = gitlab ? raw.source_branch : typeof raw.head === 'string' ? raw.head : record(raw.head).ref
    const target = gitlab ? raw.target_branch : typeof raw.base === 'string' ? raw.base : record(raw.base).ref
    if (!Number.isSafeInteger(number) || Number(number) <= 0 || typeof source !== 'string' || typeof target !== 'string' || typeof raw.title !== 'string') throw new GitError('PR_RESPONSE_INVALID', '平台返回的 PR 数据缺少必要字段。')
    if (raw.title.length > 4096 || string(raw.body || raw.description).length > 1_000_000) throw new GitError('PR_RESPONSE_LIMIT', '平台返回的 PR 内容过大。')
    const state = raw.merged === true || !!raw.merged_at || raw.state === 'merged' ? 'merged' : ['closed', 'locked'].includes(string(raw.state)) ? 'closed' : 'open'
    const suffix = gitlab ? `/-/merge_requests/${number}` : this.repo.provider === 'github' ? `/pull/${number}` : `/pulls/${number}`
    const mergeStatus = string(raw.detailed_merge_status || raw.mergeable_state)
    return { provider: this.repo.provider, number: Number(number), title: raw.title, body: string(gitlab ? raw.description : raw.body), url: this.repo.webUrl + suffix, state, sourceBranch: source, targetBranch: target,
      draft: typeof raw.draft === 'boolean' ? raw.draft : gitlab ? /^(?:draft|wip):/iu.test(raw.title) : false, checkStatus: checkStatus(raw),
      ...(mergeStatus && mergeStatus.length <= 128 && !/[\u0000-\u001f]/u.test(mergeStatus) ? { mergeStatus } : {}),
      ...(gitlab && raw.blocking_discussions_resolved === false ? { reviewStatus: '存在未解决讨论' } : {}) }
  }

  private ownSource(raw: unknown): boolean {
    const item = record(raw)
    if (this.repo.provider === 'gitlab') return item.source_project_id === undefined || item.target_project_id === undefined || item.source_project_id === item.target_project_id
    const name = record(record(item.head).repo).full_name
    return name === undefined || typeof name === 'string' && name.toLowerCase() === this.repo.fullName.toLowerCase()
  }

  async list(sourceBranch: string, signal: AbortSignal): Promise<GitPullRequest[]> {
    branchName(sourceBranch)
    const rows: GitPullRequest[] = [], query: Record<string, string> = this.repo.provider === 'gitlab' ? { state: 'all', source_branch: sourceBranch, scope: 'all', order_by: 'updated_at', sort: 'desc', per_page: '100' } : { state: 'all', head: this.repo.provider === 'github' ? `${this.repo.owner}:${sourceBranch}` : sourceBranch, sort: 'updated', direction: 'desc', per_page: '100' }
    for (let page = 1; page <= 5; page++) {
      const raw = await this.request('GET', this.collection, { ...query, page: String(page) }, undefined, signal)
      if (!Array.isArray(raw) || raw.length > 100) throw new GitError('PR_RESPONSE_INVALID', '平台返回的 PR 列表无效。')
      for (const item of raw) if (this.ownSource(item)) { const row = this.normalize(item); if (row.sourceBranch === sourceBranch) rows.push(row) }
      if (raw.length < 100) return rows
    }
    throw new GitError('PR_LIST_LIMIT', '当前分支关联的 PR 过多，请在代码托管平台查看完整列表。')
  }

  async create(input: GitPullRequestInput, signal: AbortSignal): Promise<GitPullRequest> {
    const source = branchName(input.sourceBranch), target = branchName(input.targetBranch)
    if (source === target) throw new GitError('PR_INVALID_BRANCH', 'PR 来源分支与目标分支不能相同。')
    const title = inputText(input.title, 4096, true), body = inputText(input.body, 32_000, false)
    if (input.draft !== undefined && typeof input.draft !== 'boolean') throw new GitError('PR_INVALID_INPUT', '草稿选项无效。')
    if (!this.token) throw new GitError('PR_AUTH_REQUIRED', '请先配置当前代码托管平台的访问令牌。')
    const existing = (await this.list(source, signal)).find(row => row.state === 'open' && row.targetBranch === target)
    if (existing) return existing
    const data = this.repo.provider === 'gitlab' ? { title: input.draft && !/^(?:draft|wip):/iu.test(title) ? `Draft: ${title}` : title, description: body, source_branch: source, target_branch: target } : { title, body, head: source, base: target, draft: input.draft === true }
    try {
      const value = this.normalize(await this.request('POST', this.collection, {}, data, signal))
      if (value.sourceBranch !== source || value.targetBranch !== target) throw new GitError('PR_RESPONSE_INVALID', '创建结果与请求的分支不一致，请刷新 PR 状态。')
      return value
    } catch (error) {
      const uncertain = error instanceof GitError && ['PR_NETWORK', 'PR_REMOTE_ERROR', 'PR_RESPONSE_INVALID', 'PR_RESPONSE_LIMIT', 'PR_VALIDATION'].includes(error.code)
      if (!uncertain) throw error
      // A response may be lost after creation. Reconcile once; never issue a second POST.
      if (!signal.aborted) {
        try { const reconciled = (await this.list(source, signal)).find(row => row.state === 'open' && row.targetBranch === target); if (reconciled) return reconciled } catch { /* Preserve the uncertain write outcome. */ }
      }
      if (error.code === 'PR_VALIDATION') throw error
      throw new GitError('PR_UNCONFIRMED', 'PR 创建结果尚未确认，请先刷新关联 PR，再决定是否重新创建。')
    }
  }

  async update(number: number, input: { title?: string; body?: string; targetBranch?: string }, signal: AbortSignal): Promise<GitPullRequest> {
    if (!Number.isSafeInteger(number) || number <= 0) throw new GitError('PR_INVALID_INPUT', 'PR 编号无效。')
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['title', 'body', 'targetBranch'].includes(key))) throw new GitError('PR_INVALID_INPUT', 'PR 更新参数无效。')
    if (input.targetBranch !== undefined && !this.targetBranchEditable) throw new GitError('PR_RETARGET_UNSUPPORTED', 'Gitee 当前接口不支持修改已有 PR 的目标分支，请到平台页面操作。')
    const data: JSONRecord = {}
    if (input.title !== undefined) data.title = inputText(input.title, 4096, true)
    if (input.body !== undefined) data[this.repo.provider === 'gitlab' ? 'description' : 'body'] = inputText(input.body, 32_000, false)
    if (input.targetBranch !== undefined) data[this.repo.provider === 'gitlab' ? 'target_branch' : 'base'] = branchName(input.targetBranch)
    if (!Object.keys(data).length) throw new GitError('PR_INVALID_INPUT', '没有需要更新的 PR 内容。')
    try { const row = this.normalize(await this.request(this.repo.provider === 'gitlab' ? 'PUT' : 'PATCH', `${this.collection}/${number}`, {}, data, signal)); if (row.number !== number) throw new GitError('PR_RESPONSE_INVALID', 'PR 更新结果编号不一致。'); return row }
    catch (error) { if (error instanceof GitError && ['PR_NETWORK', 'PR_REMOTE_ERROR', 'PR_RESPONSE_INVALID', 'PR_RESPONSE_LIMIT'].includes(error.code)) throw new GitError('PR_UNCONFIRMED', 'PR 更新结果尚未确认，请先刷新平台状态。'); throw error }
  }
}
