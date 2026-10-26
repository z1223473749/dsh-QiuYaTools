import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { hostServiceIdentity } from '../../host-service-identity.ts'
import { GIT_ENDPOINT, GitError, parseGitRequest, type GitCredentialStatus, type GitRequest, type GitSessionContext, type GitSnapshot } from './contract.ts'
import { GitService } from './service.ts'
import { runGit } from './runner.ts'
import { GitProviderClient, parseGitRemote } from './providers.ts'

interface LiveSession { id: string; header: { id?: string; cwd?: string; origin?: string } }
interface LiveAgent { id: string; status: string; session: LiveSession }
interface Peer { principal: { kind: string } }
interface Observation { header: LiveSession['header']; events: readonly { type: string }[]; [Symbol.dispose](): void }
interface CredentialRecord { kind: 'api-key'; key?: string }
interface Services {
  on(event: 'session/event', listener: (session: LiveSession, event: { type: string }) => void): () => void
  on(event: 'agent/pre-step', listener: (payload: { agent: LiveAgent; signal: AbortSignal }, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>): () => void
  connection: { browserPeer?: Peer; fetch: { register(route: { path: string; methods: readonly ['POST']; requestBody: 'streaming'; fetch(request: Request): Promise<Response> }): () => Promise<void> } }
  profileContext?: { dir: string }
  sessionQuery: { observeSession(id: string, options: { signal: AbortSignal; projectionMode: 'none' }): Promise<Observation> }
  sessions?: { get(id: string): LiveSession | undefined }
  agents?: { get(id: string): LiveAgent | undefined; roots(): readonly LiveAgent[]; list?(): readonly LiveAgent[] }
  credentials?: {
    readRecord(key: string): Promise<CredentialRecord | undefined>
    describeRecord(key: string): Promise<{ configured: boolean; writable: boolean }>
    modifyRecord(key: string, mutate: (value: unknown) => Promise<CredentialRecord>): Promise<unknown>
    deleteRecord(key: string): Promise<void>
  }
  get(name: string): unknown
}
export type GitHostService = Pick<GitService, 'execute' | 'checkBinding' | 'lock' | 'hasBinding' | 'dispose'>
export interface GitHostOptions { directory?: string; service?: GitHostService; fetch?: typeof fetch }
const writes = new Set(['selectBranch', 'createBranch', 'createWorktree', 'stage', 'unstage', 'commit', 'fetch', 'pull', 'push', 'restoreBinding', 'prCreate', 'prUpdate', 'credentialSet', 'credentialRemove'])

async function bodyOf(request: Request, signal: AbortSignal): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) throw new GitError('INVALID_REQUEST', 'Git 请求为空。')
  const chunks: Uint8Array[] = []; let size = 0
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) { signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) break; size += part.value.byteLength; if (size > 65_536) throw new GitError('REQUEST_LIMIT', 'Git 请求过大。'); chunks.push(part.value) }
    const bytes = new Uint8Array(size); let offset = 0
    for (const part of chunks) { bytes.set(part, offset); offset += part.length }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new GitError('INVALID_REQUEST', 'Git 请求格式无效。') }
  } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Owner-only Git operations over authenticated, exact Session identities. */
export function installGitHost(ctx: Context, readEnabled: () => boolean, options: GitHostOptions = {}) {
  const services = ctx as unknown as Services, connection = services.connection, identity = hostServiceIdentity(connection)
  const directory = options.directory ?? (services.profileContext?.dir ? join(services.profileContext.dir, 'qiuya-git') : undefined)
  if (!directory) throw new GitError('UNAVAILABLE', 'Git 配置目录尚未就绪。')
  const service = options.service ?? new GitService({ directory }), lifetime = new AbortController()
  const started = new Set<string>(), observed = new Map<string, boolean>(), issued = new Map<string, { fingerprint: string; promise: Promise<unknown> }>()
  let disposed = false
  const enabled = () => !disposed && readEnabled()
  const assertEnabled = () => { lifetime.signal.throwIfAborted(); if (!enabled()) throw new GitError('DISABLED', 'Git 功能已关闭。') }
  const running = (id: string) => services.agents?.get(id)?.status === 'running'
  const observation = async (id: string, signal: AbortSignal) => {
    const read = await services.sessionQuery.observeSession(id, { signal, projectionMode: 'none' })
    try {
      signal.throwIfAborted()
      if (read.header.id !== id || !read.header.cwd || read.header.origin === 'subagent') throw new GitError('SESSION_UNAVAILABLE', '当前会话不支持 Git 操作。')
      if (!observed.has(id)) { const value = read.events.some(event => event.type === 'turn/start'); observed.set(id, value); if (value) started.add(id) }
      return { cwd: read.header.cwd }
    } finally { read[Symbol.dispose]() }
  }
  const scope = async (id: string, signal: AbortSignal, assertOwner: () => void): Promise<GitSessionContext> => {
    assertOwner(); const initial = await observation(id, signal); assertOwner()
    const live = services.sessions?.get(id), cwd = await realpath(initial.cwd)
    assertOwner()
    return {
      sessionId: id, cwd, signal,
      get started() { return started.has(id) || observed.get(id) === true },
      get running() { return running(id) },
      assertCurrent() { assertOwner(); signal.throwIfAborted(); const current = services.sessions?.get(id); if (live && current !== live || current && current.header.cwd !== initial.cwd) throw new GitError('SESSION_CHANGED', '会话工作目录或实例已变化。') },
      async assertIdle(this: GitSessionContext, worktreeRoot?: string) {
        this.assertCurrent()
        const refreshed = await observation(id, signal)
        if (refreshed.cwd !== initial.cwd || running(id)) throw new GitError('SESSION_BUSY', '请等待当前任务停止后再操作 Git。')
        for (const agent of services.agents?.list?.() ?? services.agents?.roots() ?? []) {
          if (agent.id === id || agent.status !== 'running' || !agent.session.header.cwd) continue
          let other: string
          try {
            other = await realpath(agent.session.header.cwd)
            if (worktreeRoot) { const actual = await runGit(other, ['rev-parse', '--show-toplevel'], { signal, allowFailure: true }); if (!actual.code) other = await realpath(actual.stdout.toString('utf8').replace(/\r?\n$/u, '')) }
          } catch { throw new GitError('SESSION_BUSY', '暂时无法确认其他运行会话的工作目录。') }
          // A nested Session can mutate the same working tree too.
          if (other === (worktreeRoot ?? cwd) || !worktreeRoot && (other.startsWith(cwd + '/') || cwd.startsWith(other + '/'))) throw new GitError('SESSION_BUSY', '其他会话正在使用此目录，请等待或使用独立工作树。')
        }
        this.assertCurrent()
      },
    }
  }
  const providerOperation = async (context: GitSessionContext, request: GitRequest): Promise<unknown> => {
    const snapshot = await service.execute(context, { op: 'status', sessionId: context.sessionId }) as GitSnapshot
    context.assertCurrent()
    if (!snapshot.available || snapshot.bindingMismatch) throw new GitError('BRANCH_CHANGED', '请先确认当前会话的仓库和绑定分支。')
    const remote = snapshot.remotes.find(remote => remote.name === (request.remote ?? 'origin')) ?? (!request.remote ? snapshot.remotes[0] : undefined)
    const repo = remote && parseGitRemote(remote.url)
    if (!repo || request.provider && request.provider !== repo.provider) throw new GitError('PROVIDER_UNSUPPORTED', '请选择 GitHub、GitLab 或 Gitee 的远程仓库。')
    const key = 'dsh-qiuya-tools/git-' + repo.provider + '-' + createHash('sha256').update(repo.hostname).digest('hex').slice(0, 16)
    const credentials = services.credentials ?? services.get('credentials') as Services['credentials']
    if (request.op === 'credentialStatus') {
      const info = credentials ? await credentials.describeRecord(key) : { configured: false, writable: false }
      context.assertCurrent()
      return { provider: repo.provider, hostname: repo.hostname, ...info } satisfies GitCredentialStatus
    }
    if (request.op === 'credentialSet' || request.op === 'credentialRemove') {
      if (!credentials) throw new GitError('CREDENTIALS_UNAVAILABLE', '当前宿主未提供凭据存储。')
      context.assertCurrent()
      if (request.op === 'credentialSet') { if (!request.token || /[\u0000-\u0020\u007f]/u.test(request.token)) throw new GitError('INVALID_CREDENTIAL', '访问令牌无效。'); await credentials.modifyRecord(key, async () => { context.assertCurrent(); return { kind: 'api-key', key: request.token } }) }
      else await credentials.deleteRecord(key)
      context.assertCurrent()
      return { completed: true, message: request.op === 'credentialSet' ? '访问令牌已保存。' : '已移除此平台访问令牌。' }
    }
    const stored = await credentials?.readRecord(key); context.assertCurrent()
    const client = new GitProviderClient(repo, stored?.kind === 'api-key' ? stored.key ?? '' : '', { fetch: options.fetch, assertCurrent: () => context.assertCurrent() })
    const branch = snapshot.branch
    if (!branch) throw new GitError('BRANCH_REQUIRED', '请先选择一个本地分支。')
    if (request.op === 'prList') { const values = await client.list(branch, context.signal); context.assertCurrent(); return values }
    await context.assertIdle?.(); context.assertCurrent()
    if (request.op === 'prCreate') {
      if (request.sourceBranch && request.sourceBranch !== branch) throw new GitError('BRANCH_CHANGED', 'PR 来源必须是当前会话绑定的分支。')
      if (snapshot.upstream !== `${remote!.name}/${branch}` || snapshot.ahead !== 0) throw new GitError('PUSH_REQUIRED', '请先将当前分支推送到所选远程仓库。')
      const value = await client.create({ title: request.title ?? '', body: request.body ?? '', sourceBranch: branch, targetBranch: request.targetBranch ?? snapshot.defaultTarget ?? '', draft: request.draft }, context.signal)
      context.assertCurrent(); return value
    }
    if (request.op === 'prUpdate') {
      if (!request.number) throw new GitError('INVALID_REQUEST', '请选择需要更新的 PR。')
      const current = await client.list(branch, context.signal); context.assertCurrent()
      if (!current.some(item => item.number === request.number)) throw new GitError('PR_UNAVAILABLE', '此 PR 不属于当前会话分支。')
      const value = await client.update(request.number, { title: request.title, body: request.body, targetBranch: request.targetBranch }, context.signal)
      context.assertCurrent(); return value
    }
    throw new GitError('INVALID_REQUEST', 'Git 操作无效。')
  }
  const dispatch = async (context: GitSessionContext, request: GitRequest) => request.op.startsWith('pr') || request.op.startsWith('credential') ? providerOperation(context, request) : service.execute(context, request)
  const unregister = connection.fetch.register({ path: '/api/' + GIT_ENDPOINT, methods: ['POST'], requestBody: 'streaming', async fetch(request) {
    const peer = connection.browserPeer, principal = peer?.principal
    const assertOwner = () => { assertEnabled(); if (hostServiceIdentity(services.get('connection')) !== identity || connection.browserPeer !== peer || peer?.principal !== principal || principal?.kind !== 'owner') throw new GitError('OWNER_CHANGED', '当前连接已变化，请重新打开 Git 面板。') }
    if (principal?.kind !== 'owner') return new Response('Forbidden', { status: 403 })
    let rpcId = '', result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: object } }
    try {
      assertOwner()
      const input = await bodyOf(request, AbortSignal.any([request.signal, lifetime.signal, AbortSignal.timeout(2000)])) as Record<string, unknown>
      assertOwner()
      if (!input || input.type !== 'client-request' || input.method !== GIT_ENDPOINT || typeof input.rpcId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(input.rpcId)) throw new GitError('INVALID_REQUEST', 'Git 请求格式无效。')
      rpcId = input.rpcId
      const payload = parseGitRequest(input.payload), signal = AbortSignal.any([request.signal, lifetime.signal, AbortSignal.timeout(120_000)])
      const context = await scope(payload.sessionId, signal, assertOwner)
      let value: unknown
      if (writes.has(payload.op)) {
        if (!payload.requestId || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(payload.requestId)) throw new GitError('REQUEST_ID_REQUIRED', 'Git 操作缺少请求标识，请刷新后重试。')
        const key = payload.sessionId + ':' + payload.requestId, fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex'), old = issued.get(key)
        if (old) { if (old.fingerprint !== fingerprint) throw new GitError('REQUEST_CONFLICT', '请求标识已被其他 Git 操作使用。'); value = await old.promise }
        else {
          if (issued.size >= 4096) throw new GitError('REQUEST_LIMIT', '本次连接的 Git 操作已达上限，请重新连接。')
          const promise = Promise.resolve().then(() => { context.assertCurrent(); return dispatch(context, payload) })
          issued.set(key, { fingerprint, promise }); value = await promise
        }
      } else value = await dispatch(context, payload)
      context.assertCurrent(); result = { ok: true, value }
    } catch (error) { result = { ok: false, error: { code: error instanceof GitError ? error.code : 'GIT_UNAVAILABLE', message: error instanceof GitError ? error.message : 'Git 操作暂不可用，请刷新查看当前状态。', details: {} } } }
    return Response.json({ type: 'server-response', rpcId, result })
  } })
  const offEvent = services.on('session/event', (session, event) => { if (event.type === 'turn/start') { started.add(session.id); observed.set(session.id, true) } })
  const offStep = services.on('agent/pre-step', async (payload, next) => {
    if (!enabled() || payload.agent.session.header.origin === 'subagent' || !payload.agent.session.header.cwd) return next()
    try {
      const agent = payload.agent, expected = hostServiceIdentity(agent), signal = AbortSignal.any([payload.signal, lifetime.signal])
      const assertCurrent = () => { assertEnabled(); signal.throwIfAborted(); if (hostServiceIdentity(services.agents?.get(agent.id)) !== expected) throw new GitError('SESSION_CHANGED', '会话已变化。') }
      const context = await scope(agent.id, signal, assertCurrent)
      await service.checkBinding(context); await service.lock(context)
      return next()
    } catch (error) {
      // Switching this enhancement off must not consume the original chat's
      // pending step. Actual Session cancellation or Host disposal still wins.
      if (!disposed && !payload.signal.aborted && !readEnabled()) return next()
      ctx.logger.warn('Git 会话检查未通过：%s', error instanceof GitError ? error.message : '仓库暂不可用')
      return { kind: 'reject' }
    }
  })
  return { service, async dispose() { if (disposed) return; disposed = true; lifetime.abort(); offStep(); offEvent(); service.dispose(); issued.clear(); observed.clear(); started.clear(); await unregister() } }
}
