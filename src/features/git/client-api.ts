import { GIT_ENDPOINT, GitError, type GitBranch, type GitCommit, type GitCredentialStatus, type GitDiff, type GitFile, type GitPullRequest, type GitReceipt, type GitRequest, type GitScope, type GitSnapshot } from './contract.ts'
import { hostServiceIdentity } from '../../host-service-identity.ts'

export interface GitConnection { generation?: { getSnapshot(): unknown }; rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{ ok: boolean; value?: unknown; error?: { code?: string; message?: string } }> } }
const object = (raw: unknown): Record<string, unknown> => { if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new GitError('INVALID_RESPONSE', 'Git 返回的数据无效。'); return raw as Record<string, unknown> }
const text = (raw: unknown, limit = 4096): string => { if (typeof raw !== 'string' || raw.length > limit || raw.includes('\0')) throw new GitError('INVALID_RESPONSE', 'Git 返回的数据无效。'); return raw }
const count = (raw: unknown): number => { if (!Number.isSafeInteger(raw) || Number(raw) < 0) throw new GitError('INVALID_RESPONSE', 'Git 返回的统计无效。'); return Number(raw) }
const list = <T,>(raw: unknown, read: (value: unknown) => T, limit = 10_000): T[] => { if (!Array.isArray(raw) || raw.length > limit) throw new GitError('INVALID_RESPONSE', 'Git 返回的文件列表无效。'); return raw.map(read) }
function readFile(raw: unknown): GitFile {
  const v = object(raw)
  if (!['added', 'modified', 'deleted', 'renamed', 'untracked', 'conflicted', 'typechanged'].includes(String(v.status)) || typeof v.staged !== 'boolean' || typeof v.unstaged !== 'boolean' || typeof v.binary !== 'boolean') throw new GitError('INVALID_RESPONSE', 'Git 返回的文件状态无效。')
  return { path: text(v.path), ...(v.oldPath === undefined ? {} : { oldPath: text(v.oldPath) }), status: v.status as GitFile['status'], added: v.added === null ? null : count(v.added), deleted: v.deleted === null ? null : count(v.deleted), staged: v.staged, unstaged: v.unstaged, binary: v.binary, ...(['file', 'symlink', 'submodule'].includes(String(v.kind)) ? { kind: v.kind as GitFile['kind'] } : {}) }
}
export function readGitSnapshot(raw: unknown, sessionId: string): GitSnapshot {
  const v = object(raw)
  if (v.sessionId !== sessionId || typeof v.available !== 'boolean' || typeof v.locked !== 'boolean' || typeof v.bindingMismatch !== 'boolean' || !['current', 'worktree'].includes(String(v.mode)) || !['working', 'branch', 'staged', 'unstaged'].includes(String(v.scope))) throw new GitError('INVALID_RESPONSE', 'Git 会话数据不匹配。')
  const files = list(v.files, readFile)
  if (new Set(files.map(file => file.path)).size !== files.length || v.fileCount !== files.length) throw new GitError('INVALID_RESPONSE', 'Git 文件统计不一致。')
  return { sessionId, available: v.available, ...(v.reason === undefined ? {} : { reason: text(v.reason) }), repoName: text(v.repoName), repoRoot: text(v.repoRoot), branch: v.branch === null ? null : text(v.branch), ...(v.boundBranch === undefined ? {} : { boundBranch: v.boundBranch === null ? null : text(v.boundBranch) }), head: v.head === null ? null : text(v.head), locked: v.locked, bindingMismatch: v.bindingMismatch, mode: v.mode as GitSnapshot['mode'], scope: v.scope as GitScope, ...(v.target === undefined ? {} : { target: text(v.target) }), revision: text(v.revision), added: count(v.added), deleted: count(v.deleted), fileCount: count(v.fileCount), files, remotes: list(v.remotes, raw => { const r = object(raw); return { name: text(r.name), url: text(r.url, 8192) } }, 128), ahead: count(v.ahead), behind: count(v.behind), ...(v.upstream === undefined ? {} : { upstream: text(v.upstream) }), ...(v.defaultTarget === undefined ? {} : { defaultTarget: text(v.defaultTarget) }) }
}
export function readGitDiff(raw: unknown, request: Pick<GitRequest, 'sessionId' | 'path' | 'scope' | 'target'>): GitDiff {
  const v = object(raw), file = readFile(v.file)
  if (v.sessionId !== request.sessionId || file.path !== request.path || v.scope !== (request.scope ?? 'working') || v.target !== request.target || typeof v.tooLarge !== 'boolean') throw new GitError('INVALID_RESPONSE', 'Git 文件对比不匹配。')
  return { sessionId: request.sessionId, revision: text(v.revision), file, scope: v.scope as GitScope, ...(v.target === undefined ? {} : { target: text(v.target) }), oldText: v.oldText === null ? null : text(v.oldText, 4_000_000), newText: v.newText === null ? null : text(v.newText, 4_000_000), patch: text(v.patch, 8_000_000), hunks: list(v.hunks, raw => { const h = object(raw); return { oldStart: count(h.oldStart), oldLines: count(h.oldLines), newStart: count(h.newStart), newLines: count(h.newLines), lines: list(h.lines, raw => text(raw, 1_000_000), 100_000) } }, 20_000), tooLarge: v.tooLarge, ...(v.message === undefined ? {} : { message: text(v.message) }) }
}
function readPR(raw: unknown): GitPullRequest {
  const v = object(raw), url = new URL(text(v.url))
  if (!['github', 'gitlab', 'gitee'].includes(String(v.provider)) || !['open', 'closed', 'merged'].includes(String(v.state)) || !['success', 'failure', 'pending', 'unknown'].includes(String(v.checkStatus)) || url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname !== `${String(v.provider)}.com`) throw new GitError('INVALID_RESPONSE', 'PR 返回的数据无效。')
  return { provider: v.provider as GitPullRequest['provider'], number: count(v.number), title: text(v.title), body: text(v.body, 100_000), url: url.href, state: v.state as GitPullRequest['state'], sourceBranch: text(v.sourceBranch), targetBranch: text(v.targetBranch), checkStatus: v.checkStatus as GitPullRequest['checkStatus'], ...(typeof v.draft === 'boolean' ? { draft: v.draft } : {}), ...(v.reviewStatus === undefined ? {} : { reviewStatus: text(v.reviewStatus) }), ...(v.mergeStatus === undefined ? {} : { mergeStatus: text(v.mergeStatus) }) }
}
export interface GitClientAPI {
  call<T = unknown>(request: GitRequest, signal: AbortSignal): Promise<T>
  status(sessionId: string, signal: AbortSignal, scope?: GitScope, target?: string): Promise<GitSnapshot>
  branches(sessionId: string, signal: AbortSignal): Promise<GitBranch[]>
  log(sessionId: string, signal: AbortSignal): Promise<GitCommit[]>
  diff(request: GitRequest, signal: AbortSignal): Promise<GitDiff>
  perform(request: GitRequest, signal: AbortSignal): Promise<GitReceipt>
  pullRequests(request: GitRequest, signal: AbortSignal): Promise<GitPullRequest[]>
  pullRequest(request: GitRequest, signal: AbortSignal): Promise<GitPullRequest>
  credential(request: GitRequest, signal: AbortSignal): Promise<GitCredentialStatus>
}
export function createGitClientAPI(connection: () => GitConnection | undefined): GitClientAPI {
  const call = async <T,>(request: GitRequest, signal: AbortSignal): Promise<T> => {
    signal.throwIfAborted(); const peer = connection(); if (!peer) throw new GitError('UNAVAILABLE', '连接尚未就绪。')
    const identity = hostServiceIdentity(peer), generation = peer.generation?.getSnapshot()
    const readOnly = ['status', 'branches', 'diff', 'log', 'prList', 'credentialStatus'].includes(request.op)
    const payload = readOnly ? request : { ...request, requestId: request.requestId ?? globalThis.crypto.randomUUID() }
    const result = await peer.rpc.call('/api', GIT_ENDPOINT, payload, signal); signal.throwIfAborted()
    if (hostServiceIdentity(connection()) !== identity || peer.generation && peer.generation.getSnapshot() !== generation) throw new GitError('CONNECTION_CHANGED', '宿主连接已变化，请刷新 Git 状态。')
    if (!result.ok) throw new GitError(result.error?.code ?? 'GIT_FAILED', result.error?.message ?? 'Git 操作失败，请刷新后重试。')
    return result.value as T
  }
  return {
    call,
    async status(sessionId, signal, scope = 'working', target) { const value = readGitSnapshot(await call({ op: 'status', sessionId, scope, ...(target ? { target } : {}) }, signal), sessionId); if (value.scope !== scope || target !== undefined && value.target !== target) throw new GitError('INVALID_RESPONSE', 'Git 对比范围已变化。'); return value },
    async branches(sessionId, signal) { return list(await call({ op: 'branches', sessionId }, signal), raw => { const v = object(raw); if (typeof v.remote !== 'boolean' || typeof v.current !== 'boolean') throw new GitError('INVALID_RESPONSE', 'Git 分支数据无效。'); return { name: text(v.name), ref: text(v.ref), remote: v.remote, current: v.current, ...(v.upstream === undefined ? {} : { upstream: text(v.upstream) }), ...(typeof v.checkedOut === 'boolean' ? { checkedOut: v.checkedOut } : {}) } }, 20_000) },
    async log(sessionId, signal) { return list(await call({ op: 'log', sessionId }, signal), raw => { const v = object(raw), hash = text(v.hash, 64); if (!/^[a-f0-9]{40,64}$/iu.test(hash)) throw new GitError('INVALID_RESPONSE', 'Git 提交记录无效。'); return { hash, shortHash: text(v.shortHash, 64), subject: text(v.subject, 16_000), author: text(v.author), at: count(v.at) } }, 20) },
    async diff(request, signal) { return readGitDiff(await call(request, signal), request) },
    async perform(request, signal) { const v = object(await call(request, signal)); if (v.completed !== true) throw new GitError('GIT_UNCONFIRMED', typeof v.message === 'string' ? v.message : 'Git 操作尚未确认完成，请刷新状态。'); return { completed: true, message: text(v.message), ...(v.snapshot === undefined ? {} : { snapshot: readGitSnapshot(v.snapshot, request.sessionId) }), ...(v.worktreePath === undefined ? {} : { worktreePath: text(v.worktreePath) }), ...(v.branch === undefined ? {} : { branch: text(v.branch) }) } },
    async pullRequests(request, signal) { return list(await call(request, signal), readPR, 1000) },
    async pullRequest(request, signal) { return readPR(await call(request, signal)) },
    async credential(request, signal) { const v = object(await call(request, signal)); if (!['github', 'gitlab', 'gitee'].includes(String(v.provider)) || typeof v.configured !== 'boolean' || typeof v.writable !== 'boolean') throw new GitError('INVALID_RESPONSE', '凭据状态无效。'); return { provider: v.provider as GitCredentialStatus['provider'], hostname: text(v.hostname), configured: v.configured, writable: v.writable } },
  }
}

export interface GitClientState { snapshot?: GitSnapshot; error?: string; loading: boolean; busy: boolean }
const EMPTY_OPEN_REQUEST = Object.freeze({ version: 0, path: undefined as string | undefined })
interface Entry { sessionId: string; scope: GitScope; target?: string; state: GitClientState; listeners: Set<() => void>; refs: number; sequence: number; controller?: AbortController; timer?: ReturnType<typeof setTimeout> }
/** A shared snapshot per exact session/comparison, with no cross-session selected-seat fallback. */
export class GitClientStore {
  private entries = new Map<string, Entry>()
  private busy = new Set<string>()
  private mutations = new Set<AbortController>()
  private openRequests = new Map<string, { version: number; path?: string }>()
  private openListeners = new Map<string, Set<() => void>>()
  private openVersion = 0
  private closed = false
  constructor(readonly api: GitClientAPI, private readonly pollMs = 3000) {}
  openRequest(sessionId: string): { version: number; path?: string } { return this.openRequests.get(sessionId) ?? EMPTY_OPEN_REQUEST }
  subscribeOpen(sessionId: string, listener: () => void) { const listeners = this.openListeners.get(sessionId) ?? new Set(); this.openListeners.set(sessionId, listeners); listeners.add(listener); return () => { listeners.delete(listener); if (!listeners.size) this.openListeners.delete(sessionId) } }
  requestOpen(sessionId: string, path?: string) { if (this.closed) return; this.openRequests.delete(sessionId); this.openRequests.set(sessionId, { version: ++this.openVersion, ...(path ? { path } : {}) }); for (const listener of this.openListeners.get(sessionId) ?? []) listener(); if (this.openRequests.size > 64) for (const key of this.openRequests.keys()) { if (this.openRequests.size <= 64) break; if (!this.openListeners.has(key)) this.openRequests.delete(key) } }
  private key(sessionId: string, scope: GitScope, target?: string) { return JSON.stringify([sessionId, scope, target ?? '']) }
  private trim() { if (this.entries.size <= 64) return; for (const [key, entry] of this.entries) { if (this.entries.size <= 64) break; if (entry.refs === 0 && entry.listeners.size === 0 && !this.busy.has(entry.sessionId)) { entry.sequence++; entry.controller?.abort(); clearTimeout(entry.timer); this.entries.delete(key) } } }
  private entry(sessionId: string, scope: GitScope = 'working', target?: string): Entry {
    const key = this.key(sessionId, scope, target); let entry = this.entries.get(key)
    if (!entry) { entry = { sessionId, scope, target, state: { loading: true, busy: this.busy.has(sessionId) }, listeners: new Set(), refs: 0, sequence: 0 }; this.entries.set(key, entry) }
    return entry
  }
  snapshot = (sessionId: string, scope: GitScope = 'working', target?: string) => this.entry(sessionId, scope, target).state
  subscribe = (sessionId: string, notify: () => void, scope: GitScope = 'working', target?: string) => { const entry = this.entry(sessionId, scope, target); entry.listeners.add(notify); return () => entry.listeners.delete(notify) }
  private publish(entry: Entry, state: GitClientState) { if (this.closed) return; entry.state = state; for (const notify of [...entry.listeners]) notify() }
  retain(sessionId: string, scope: GitScope = 'working', target?: string): () => void {
    const entry = this.entry(sessionId, scope, target); entry.refs++
    if (entry.refs === 1 && !this.closed) void this.refresh(sessionId, scope, target)
    let released = false
    return () => { if (released) return; released = true; entry.refs--; if (entry.refs === 0) { entry.sequence++; entry.controller?.abort(); clearTimeout(entry.timer); entry.timer = undefined; this.trim() } }
  }
  async refresh(sessionId: string, scope: GitScope = 'working', target?: string): Promise<void> {
    if (this.closed) return
    const entry = this.entry(sessionId, scope, target), sequence = ++entry.sequence, controller = new AbortController()
    entry.controller?.abort(); clearTimeout(entry.timer); entry.controller = controller
    this.publish(entry, { ...entry.state, loading: entry.state.snapshot === undefined, error: undefined })
    try {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const snapshot = await this.api.status(sessionId, controller.signal, scope, target)
      if (!this.closed && !controller.signal.aborted && sequence === entry.sequence) this.publish(entry, { snapshot, loading: false, busy: this.busy.has(sessionId) })
    } catch (error) { if (!this.closed && !controller.signal.aborted && sequence === entry.sequence) this.publish(entry, { ...entry.state, loading: false, error: error instanceof Error ? error.message : 'Git 数据暂不可用。' }) }
    finally { if (!this.closed && sequence === entry.sequence && entry.refs > 0) { entry.timer = setTimeout(() => { void this.refresh(sessionId, scope, target) }, this.pollMs); (entry.timer as { unref?(): void }).unref?.() } else this.trim() }
  }
  async run<T>(sessionId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed || this.busy.has(sessionId)) throw new GitError('BUSY', '当前会话正在执行 Git 操作。')
    this.busy.add(sessionId)
    const controller = new AbortController(); this.mutations.add(controller)
    for (const entry of this.entries.values()) if (entry.sessionId === sessionId) { entry.sequence++; entry.controller?.abort(); clearTimeout(entry.timer); this.publish(entry, { ...entry.state, busy: true }) }
    try {
      return await work(controller.signal)
    } finally {
      this.mutations.delete(controller); this.busy.delete(sessionId)
      if (!this.closed) await Promise.all([...this.entries.values()].filter(entry => entry.sessionId === sessionId).map(entry => { this.publish(entry, { ...entry.state, busy: false }); return this.refresh(entry.sessionId, entry.scope, entry.target) }))
    }
  }
  async perform(request: GitRequest): Promise<GitReceipt> {
    return this.run(request.sessionId, async signal => {
      // Mutations are checked against the working snapshot. A staged or branch
      // view's revision is a different comparison and must never be sent as it.
      const working = this.entries.get(this.key(request.sessionId, 'working'))?.state.snapshot
      const viewed = request.scope && request.scope !== 'working' ? this.entries.get(this.key(request.sessionId, request.scope, request.target))?.state.snapshot : undefined
      const baseline = working ?? (viewed ? await this.api.status(request.sessionId, signal) : undefined)
      if (viewed && baseline && (viewed.head !== baseline.head || viewed.branch !== baseline.branch)) throw new GitError('STALE_SNAPSHOT', 'Git 分支或提交已变化，请刷新对比后再操作。')
      const expectedRevision = viewed ? baseline?.revision : request.expectedRevision
      return await this.api.perform({ ...request, scope: 'working', target: undefined, expectedRevision, requestId: request.requestId ?? globalThis.crypto.randomUUID() }, signal)
    })
  }
  refreshSession(sessionId: string) { return Promise.all([...this.entries.values()].filter(entry => entry.sessionId === sessionId).map(entry => this.refresh(entry.sessionId, entry.scope, entry.target))) }
  dispose() { if (this.closed) return; this.closed = true; for (const entry of this.entries.values()) { entry.sequence++; entry.controller?.abort(); clearTimeout(entry.timer); entry.listeners.clear() } for (const controller of this.mutations) controller.abort(); this.mutations.clear(); this.entries.clear(); this.openRequests.clear(); this.openListeners.clear() }
}
