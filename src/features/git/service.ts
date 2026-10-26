import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readlink, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { GitError, type GitBinding, type GitBranch, type GitCommit, type GitDiff, type GitFile, type GitFileStatus, type GitHunk, type GitReceipt, type GitRequest, type GitScope, type GitSessionContext, type GitSnapshot } from './contract.ts'
import { runGit } from './runner.ts'
import { GitBindingStore } from './storage.ts'

interface Repository { root: string; common: string; cwd: string; branch: string | null; head: string | null }
interface Change { path: string; oldPath?: string; status: GitFileStatus }
interface Flags { staged: boolean; unstaged: boolean; conflicted: boolean; oldPath?: string }
const DIFF = ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--find-renames']
const EMPTY_LIMIT = 1024 * 1024
const utf8 = (value: Buffer) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(value) } catch { throw new GitError('UNSUPPORTED_PATH', '仓库存在无法显示的文件名，请先将文件名转换为 UTF-8。') } }
const ending = (value: Buffer) => utf8(value).replace(/\r?\n$/u, '')
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const statusKind = (code: string): GitFileStatus => ({ A: 'added', D: 'deleted', R: 'renamed', U: 'conflicted', T: 'typechanged' } as const)[code as 'A'] ?? 'modified'
const notRelative = (path: string) => !path || isAbsolute(path) || path === '..' || path.startsWith('../') || path.startsWith('..\\') || path.split(/[\\/]/u).includes('.git') || path.includes('\0')
function splitChanges(buffer: Buffer): Change[] {
  const fields = utf8(buffer).split('\0'), result: Change[] = []
  for (let i = 0; i < fields.length && fields[i];) {
    const code = fields[i++]!, first = fields[i++]!
    if (code.startsWith('R') || code.startsWith('C')) result.push({ path: fields[i++]!, oldPath: first, status: 'renamed' })
    else result.push({ path: first, status: statusKind(code[0]!) })
  }
  return result
}
function splitNumstat(buffer: Buffer): Map<string, { added: number | null; deleted: number | null }> {
  const fields = utf8(buffer).split('\0'), result = new Map<string, { added: number | null; deleted: number | null }>()
  for (let i = 0; i < fields.length && fields[i]; i++) {
    const line = fields[i]!, one = line.indexOf('\t'), two = line.indexOf('\t', one + 1)
    if (one < 0 || two < 0) continue
    let path = line.slice(two + 1)
    if (!path) { i++; path = fields[++i]! }
    const added = line.slice(0, one), deleted = line.slice(one + 1, two)
    result.set(path, { added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted) })
  }
  return result
}
function porcelain(buffer: Buffer): Map<string, Flags> {
  const fields = utf8(buffer).split('\0'), result = new Map<string, Flags>()
  for (let i = 0; i < fields.length && fields[i]; i++) {
    const line = fields[i]!, x = line[0]!, y = line[1]!, path = line.slice(3)
    const oldPath = x === 'R' || x === 'C' || y === 'R' || y === 'C' ? fields[++i] : undefined
    if (x === '?' && y === '?') result.set(path, { staged: false, unstaged: true, conflicted: false })
    else result.set(path, { staged: x !== ' ' && x !== '?', unstaged: y !== ' ' && y !== '?', conflicted: x === 'U' || y === 'U' || x + y === 'AA' || x + y === 'DD', ...(oldPath ? { oldPath } : {}) })
  }
  return result
}
function rawKinds(buffer: Buffer): Map<string, 'file' | 'symlink' | 'submodule'> {
  const fields = utf8(buffer).split('\0'), result = new Map<string, 'file' | 'symlink' | 'submodule'>()
  for (let i = 0; i < fields.length && fields[i];) {
    const header = fields[i++]!.split(' '), first = fields[i++]!, code = header.at(-1) ?? ''
    const path = /^[RC]/u.test(code) ? fields[i++]! : first
    result.set(path, header[0] === ':160000' || header[1] === '160000' ? 'submodule' : header[0] === ':120000' || header[1] === '120000' ? 'symlink' : 'file')
  }
  return result
}
export function parseGitHunks(patch: string): GitHunk[] {
  const hunks: GitHunk[] = []; let hunk: GitHunk | undefined
  for (const line of patch.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line)
    if (match) { hunk = { oldStart: Number(match[1]), oldLines: match[2] === undefined ? 1 : Number(match[2]), newStart: Number(match[3]), newLines: match[4] === undefined ? 1 : Number(match[4]), lines: [] }; hunks.push(hunk) }
    else if (hunk && /^[ +\\-]/u.test(line)) hunk.lines.push(line)
    else if (line.startsWith('diff --git ')) hunk = undefined
  }
  return hunks
}

/** Authoritative Git state: session identity and cwd are supplied only by the Host. */
export class GitService {
  private readonly store: GitBindingStore
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private disposed = false
  constructor(private readonly options: { directory: string }) { this.store = new GitBindingStore(join(options.directory, 'bindings')) }
  dispose() { this.disposed = true; this.lifetime.abort(); this.queues.clear() }
  private current(context: GitSessionContext) { if (this.disposed) throw new GitError('UNAVAILABLE', 'Git 功能已停止。'); this.lifetime.signal.throwIfAborted(); context.signal.throwIfAborted(); context.assertCurrent() }
  private async run(context: GitSessionContext, root: string, args: readonly string[], options: Parameters<typeof runGit>[2] = {}) { this.current(context); const result = await runGit(root, args, { ...options, signal: AbortSignal.any([context.signal, this.lifetime.signal]) }); this.current(context); return result }
  private async repository(context: GitSessionContext): Promise<Repository> {
    this.current(context)
    let cwd: string
    try { cwd = await realpath(context.cwd) } catch { throw new GitError('DIRECTORY_UNAVAILABLE', '会话工作目录不存在或无法读取。') }
    const probe = await this.run(context, cwd, ['rev-parse', '--show-toplevel'], { allowFailure: true })
    if (probe.code) throw new GitError('NOT_A_REPOSITORY', '当前目录不是 Git 仓库。')
    const root = await realpath(ending(probe.stdout)), commonValue = await this.run(context, root, ['rev-parse', '--git-common-dir'])
    const common = await realpath(resolve(root, ending(commonValue.stdout)))
    const [branchResult, headResult] = await Promise.all([
      this.run(context, root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true }),
      this.run(context, root, ['rev-parse', '--verify', 'HEAD^{commit}'], { allowFailure: true }),
    ])
    this.current(context)
    return { root, common, cwd, branch: branchResult.code ? null : ending(branchResult.stdout), head: headResult.code ? null : ending(headResult.stdout) }
  }
  private async serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve(), pending = previous.catch(() => {}).then(task)
    this.queues.set(key, pending)
    try { return await pending } finally { if (this.queues.get(key) === pending) this.queues.delete(key) }
  }
  private async binding(context: GitSessionContext, repo: Repository): Promise<GitBinding> {
    let binding = await this.store.read(context.sessionId)
    this.current(context)
    if (!binding) {
      const managedRoot = await realpath(join(this.options.directory, 'worktrees')).catch(() => undefined); this.current(context)
      binding = { version: 1, sessionId: context.sessionId, repoRoot: repo.common, worktreeRoot: repo.root, branch: repo.branch, baseCommit: repo.head, locked: context.started, mode: managedRoot && repo.root.startsWith(managedRoot + sep) ? 'worktree' : 'current', createdAt: Date.now() }
      await this.store.write(binding)
    } else if (context.started && !binding.locked) { binding = { ...binding, locked: true }; await this.store.write(binding) }
    this.current(context); return binding
  }
  private mismatch(binding: GitBinding, repo: Repository) { return binding.repoRoot !== repo.common || binding.worktreeRoot !== repo.root || binding.branch !== repo.branch }
  async hasBinding(sessionId: string): Promise<boolean> { return !!await this.store.read(sessionId) }
  private async optionalRepository(context: GitSessionContext): Promise<Repository | undefined> {
    try { return await this.repository(context) }
    catch (error) {
      this.current(context)
      if (error instanceof GitError && ['NOT_A_REPOSITORY', 'DIRECTORY_UNAVAILABLE', 'GIT_UNAVAILABLE'].includes(error.code)) {
        const bound = await this.store.read(context.sessionId); this.current(context)
        if (!bound) return
      }
      throw error
    }
  }
  async checkBinding(context: GitSessionContext): Promise<void> {
    const repo = await this.optionalRepository(context)
    if (!repo) return
    await this.serialized(repo.common, async () => { const actual = await this.repository(context), binding = await this.binding(context, actual); if (this.mismatch(binding, actual)) throw new GitError('BRANCH_CHANGED', '当前目录的分支与此会话绑定的分支不一致，请先恢复原分支。') })
  }
  async lock(context: GitSessionContext): Promise<void> {
    const repo = await this.optionalRepository(context)
    if (!repo) return
    await this.serialized(repo.common, async () => { const actual = await this.repository(context), binding = await this.binding(context, actual); if (this.mismatch(binding, actual)) throw new GitError('BRANCH_CHANGED', '当前分支已变化，请恢复会话绑定分支。'); if (context.started && !binding.locked) await this.store.write({ ...binding, locked: true }) })
  }
  private empty(context: GitSessionContext, request: GitRequest, reason: string): GitSnapshot { return { sessionId: context.sessionId, available: false, reason, repoName: '', repoRoot: '', branch: null, head: null, locked: context.started, bindingMismatch: false, mode: 'current', scope: request.scope ?? 'working', revision: '', added: 0, deleted: 0, fileCount: 0, files: [], remotes: [], ahead: 0, behind: 0 } }
  async execute(context: GitSessionContext, request: GitRequest): Promise<GitSnapshot | GitBranch[] | GitCommit[] | GitDiff | GitReceipt> {
    this.current(context)
    if (context.sessionId !== request.sessionId) throw new GitError('SESSION_CHANGED', '当前会话已变化。')
    let repo: Repository
    try { repo = await this.repository(context) }
    catch (error) { if (request.op === 'status' && error instanceof GitError && ['NOT_A_REPOSITORY', 'DIRECTORY_UNAVAILABLE', 'GIT_UNAVAILABLE'].includes(error.code)) return this.empty(context, request, error.message); throw error }
    return this.serialized(repo.common, async () => {
      repo = await this.repository(context)
      if (request.op === 'status') return this.snapshot(context, repo, request)
      if (request.op === 'branches') return this.branches(context, repo)
      if (request.op === 'log') return this.log(context, repo)
      if (request.op === 'diff') return this.diff(context, repo, request)
      return this.mutate(context, repo, request)
    })
  }
  private async emptyTree(context: GitSessionContext, repo: Repository) { return ending((await this.run(context, repo.root, ['hash-object', '-t', 'tree', '--stdin'], { input: '' })).stdout) }
  private async target(context: GitSessionContext, repo: Repository, target?: string): Promise<string> {
    if (!target || target.startsWith('-') || target.includes('\0') || target.length > 4096) throw new GitError('TARGET_REQUIRED', '请选择用于分支对比的目标分支。')
    const result = await this.run(context, repo.root, ['rev-parse', '--verify', '--end-of-options', target + '^{commit}'], { allowFailure: true })
    if (result.code) throw new GitError('INVALID_TARGET', '目标分支不存在或尚未获取，请先刷新远程分支。')
    return ending(result.stdout)
  }
  private async diffArgs(context: GitSessionContext, repo: Repository, request: GitRequest): Promise<string[]> {
    const scope = request.scope ?? 'working', base = repo.head ?? await this.emptyTree(context, repo)
    if (scope === 'branch') {
      if (!repo.head) throw new GitError('NO_COMMITS', '当前仓库尚无提交，暂不可进行分支对比。')
      const target = await this.target(context, repo, request.target)
      const common = await this.run(context, repo.root, ['merge-base', target, repo.head], { allowFailure: true })
      if (common.code) throw new GitError('UNRELATED_HISTORY', '两个分支没有共同祖先。')
      return [ending(common.stdout), repo.head]
    }
    return scope === 'staged' ? ['--cached', base] : scope === 'unstaged' ? [] : [base]
  }
  private async safeRead(context: GitSessionContext, repo: Repository, path: string, countLarge = false): Promise<{ text: string | null; binary: boolean; tooLarge: boolean; kind: 'file' | 'symlink' | 'submodule'; lineCount?: number }> {
    this.current(context)
    if (notRelative(path)) throw new GitError('INVALID_PATH', '文件路径无效。')
    const absolute = resolve(repo.root, path), rel = relative(repo.root, absolute)
    if (notRelative(rel)) throw new GitError('INVALID_PATH', '文件路径超出仓库。')
    let directory = repo.root
    for (const part of rel.split(sep).slice(0, -1)) {
      directory = join(directory, part)
      try { const stat = await lstat(directory); this.current(context); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new GitError('UNSAFE_PATH', '该文件位于符号链接目录中，无法读取。') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: null, binary: false, tooLarge: false, kind: 'file' }; throw error }
    }
    let stat
    try { stat = await lstat(absolute); this.current(context) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: null, binary: false, tooLarge: false, kind: 'file' }; throw error }
    if (stat.isSymbolicLink()) return { text: await readlink(absolute), binary: false, tooLarge: false, kind: 'symlink' }
    if (stat.isDirectory()) return { text: null, binary: false, tooLarge: false, kind: 'submodule' }
    if (!stat.isFile()) throw new GitError('UNSAFE_PATH', '该文件类型不支持 Git 对比。')
    if (stat.size > EMPTY_LIMIT && !countLarge) return { text: null, binary: false, tooLarge: true, kind: 'file' }
    if (stat.size > 128 * EMPTY_LIMIT) throw new GitError('OUTPUT_LIMIT', '未跟踪文件超过 128 MiB，请先忽略或处理该文件后刷新统计。')
    // Reject path replacement during the asynchronous read rather than following a new symlink.
    const canonical = await realpath(absolute); this.current(context)
    if (canonical !== absolute) throw new GitError('UNSAFE_PATH', '文件路径已变化，请刷新后重试。')
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      this.current(context); const opened = await handle.stat(); this.current(context)
      if (opened.ino !== stat.ino || opened.dev !== stat.dev || !opened.isFile()) throw new GitError('STALE_STATE', '文件读取期间发生变化，请刷新。')
      const chunks: Buffer[] = [], chunk = Buffer.allocUnsafe(64 * 1024); let length = 0, lines = 0, last = -1, binary = false
      while (true) {
        this.current(context)
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        this.current(context); if (!bytesRead) break
        length += bytesRead
        if (length > 128 * EMPTY_LIMIT) throw new GitError('OUTPUT_LIMIT', '未跟踪文件过大，请先处理后刷新统计。')
        for (let i = 0; i < bytesRead; i++) { if (chunk[i] === 0) binary = true; if (chunk[i] === 10) lines++ }
        last = chunk[bytesRead - 1]!
        if (stat.size <= EMPTY_LIMIT && length <= EMPTY_LIMIT) chunks.push(Buffer.from(chunk.subarray(0, bytesRead)))
      }
      const after = await lstat(absolute); this.current(context)
      if (after.isSymbolicLink() || after.ino !== stat.ino || after.dev !== stat.dev || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new GitError('STALE_STATE', '文件读取期间发生变化，请刷新。')
      return { text: binary || length > EMPTY_LIMIT ? null : Buffer.concat(chunks).toString('utf8'), binary, tooLarge: length > EMPTY_LIMIT, kind: 'file', lineCount: lines + (length && last !== 10 ? 1 : 0) }
    } finally { await handle.close() }
  }
  private async blob(context: GitSessionContext, repo: Repository, revision: string | null, path: string): Promise<{ text: string | null; tooLarge: boolean }> {
    if (revision === null) return { text: null, tooLarge: false }
    if (notRelative(path)) throw new GitError('INVALID_PATH', '文件路径无效。')
    const spec = revision + ':' + path, found = await this.run(context, repo.root, ['rev-parse', '--verify', '--end-of-options', spec], { allowFailure: true })
    if (found.code) return { text: null, tooLarge: false }
    const object = ending(found.stdout)
    if (!/^[a-f0-9]{40,64}$/u.test(object)) throw new GitError('INVALID_OBJECT', 'Git 对象无效。')
    const size = await this.run(context, repo.root, ['cat-file', '-s', object], { allowFailure: true })
    if (size.code) return { text: null, tooLarge: false }
    if (Number(ending(size.stdout)) > EMPTY_LIMIT) return { text: null, tooLarge: true }
    const result = await this.run(context, repo.root, ['cat-file', '-p', object], { maxBytes: EMPTY_LIMIT + 4096 })
    return { text: result.stdout.includes(0) ? null : result.stdout.toString('utf8'), tooLarge: false }
  }
  private async snapshot(context: GitSessionContext, repo: Repository, request: GitRequest): Promise<GitSnapshot> {
    const binding = await this.binding(context, repo), scope = request.scope ?? 'working'
    const [status, remotesList, branchList] = await Promise.all([
      this.run(context, repo.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      this.run(context, repo.root, ['remote']),
      this.branches(context, repo),
    ])
    const flags = porcelain(status.stdout), args = await this.diffArgs(context, repo, request)
    const [names, numbers, raw] = await Promise.all([
      this.run(context, repo.root, [...DIFF, '--name-status', '-z', ...args, '--']),
      this.run(context, repo.root, [...DIFF, '--numstat', '-z', ...args, '--']),
      this.run(context, repo.root, [...DIFF, '--raw', '--abbrev=64', '-z', ...args, '--']),
    ])
    const kinds = rawKinds(raw.stdout), changes = splitChanges(names.stdout), stats = splitNumstat(numbers.stdout), files: GitFile[] = changes.map(change => {
      const number = stats.get(change.path) ?? { added: 0, deleted: 0 }, flag = flags.get(change.path)
      return { ...change, status: flag?.conflicted && scope !== 'branch' ? 'conflicted' : change.status, ...number, staged: scope !== 'branch' && !!flag?.staged, unstaged: scope !== 'branch' && !!flag?.unstaged, binary: number.added === null || number.deleted === null, kind: kinds.get(change.path) ?? 'file' }
    })
    if (scope === 'working' || scope === 'unstaged') {
      const untracked = await this.run(context, repo.root, ['ls-files', '--others', '--exclude-standard', '-z'])
      for (const path of utf8(untracked.stdout).split('\0').filter(Boolean)) {
        const read = await this.safeRead(context, repo, path, true), text = read.text
        files.push({ path, status: 'untracked', added: read.binary ? null : read.lineCount ?? (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0), deleted: read.binary ? null : 0, staged: false, unstaged: true, binary: read.binary, kind: read.kind })
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path))
    const remotes = []
    for (const name of utf8(remotesList.stdout).split('\n').filter(Boolean)) {
      const result = await this.run(context, repo.root, ['remote', 'get-url', '--', name], { allowFailure: true })
      if (!result.code) { let url = ending(result.stdout); try { const parsed = new URL(url); parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = ''; url = parsed.toString() } catch { /* SSH scp address carries no embedded password. */ } remotes.push({ name, url }) }
    }
    const current = branchList.find(branch => branch.current && !branch.remote), upstream = current?.upstream
    let ahead = 0, behind = 0
    if (upstream && repo.head) { const count = await this.run(context, repo.root, ['rev-list', '--left-right', '--count', repo.head + '...' + upstream, '--'], { allowFailure: true }); if (!count.code) [ahead, behind] = ending(count.stdout).split(/\s+/u).map(Number) as [number, number] }
    const originHead = await this.run(context, repo.root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFailure: true })
    const defaultTarget = !originHead.code ? ending(originHead.stdout) : ['origin/main', 'origin/master', 'main', 'master'].find(name => name !== repo.branch && branchList.some(branch => branch.name === name))
    let repoName = basename(repo.common) === '.git' ? basename(dirname(repo.common)) : basename(repo.common).replace(/\.git$/u, '') || basename(repo.root)
    if (remotes[0]) { const path = remotes[0].url.replace(/[?#].*$/u, '').replace(/\/$/u, ''); repoName = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf(':')) + 1).replace(/\.git$/u, '') || repoName }
    const fingerprints = []
    if (scope !== 'branch' && scope !== 'staged') for (const file of files) {
      const stat = await lstat(resolve(repo.root, file.path)).catch(() => undefined)
      fingerprints.push(stat ? [file.path, stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeMs, stat.ctimeMs] : [file.path, null])
    }
    const index = scope !== 'branch' ? await this.run(context, repo.root, [...DIFF, '--cached', '--raw', '--abbrev=64', '-z', repo.head ?? await this.emptyTree(context, repo), '--']) : undefined
    const revision = digest({ head: repo.head, branch: repo.branch, scope, target: request.target, status: scope === 'branch' ? null : status.stdout.toString('base64'), names: names.stdout.toString('base64'), numbers: numbers.stdout.toString('base64'), raw: raw.stdout.toString('base64'), index: index?.stdout.toString('base64'), fingerprints, files })
    const actual = await this.repository(context)
    if (actual.head !== repo.head || actual.branch !== repo.branch) throw new GitError('STALE_STATE', '仓库分支或提交在读取期间变化，请刷新。')
    this.current(context)
    return { sessionId: context.sessionId, available: true, repoName, repoRoot: repo.root, branch: repo.branch, boundBranch: binding.branch, head: repo.head, locked: binding.locked, bindingMismatch: this.mismatch(binding, repo), mode: binding.mode, scope, ...(request.target ? { target: request.target } : {}), revision, added: files.reduce((sum, file) => sum + (file.added ?? 0), 0), deleted: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0), fileCount: files.length, files, remotes, ahead, behind, ...(upstream ? { upstream } : {}), ...(defaultTarget ? { defaultTarget } : {}) }
  }
  private async branches(context: GitSessionContext, repo: Repository): Promise<GitBranch[]> {
    const result = await this.run(context, repo.root, ['for-each-ref', '--format=%(refname)%00%(refname:short)%00%(upstream:short)%00%(worktreepath)', 'refs/heads/', 'refs/remotes/'])
    return utf8(result.stdout).split('\n').filter(Boolean).flatMap(line => { const [ref, name, upstream, checkedOut] = line.split('\0'); if (!ref || !name || ref.endsWith('/HEAD')) return []; return [{ ref, name, remote: ref.startsWith('refs/remotes/'), current: ref === 'refs/heads/' + repo.branch, ...(upstream ? { upstream } : {}), ...(checkedOut ? { checkedOut: true } : {}) }] })
  }
  private async log(context: GitSessionContext, repo: Repository): Promise<GitCommit[]> {
    if (!repo.head) return []
    const result = await this.run(context, repo.root, ['log', '--max-count=20', '-z', '--format=%H%x00%h%x00%s%x00%an%x00%at', '--'])
    const fields = utf8(result.stdout).split('\0'); if (fields.at(-1) === '') fields.pop()
    if (fields.length % 5) throw new GitError('INVALID_HISTORY', '提交记录格式无法读取。')
    const commits: GitCommit[] = []
    for (let i = 0; i < fields.length; i += 5) {
      const [hash, shortHash, subject, author, at] = fields.slice(i, i + 5)
      if (!hash || !/^[a-f0-9]{40,64}$/u.test(hash) || !at || !/^\d+$/u.test(at)) throw new GitError('INVALID_HISTORY', '提交记录格式无法读取。')
      commits.push({ hash, shortHash: shortHash!, subject: subject!, author: author!, at: Number(at) * 1000 })
    }
    return commits
  }
  private async diff(context: GitSessionContext, repo: Repository, request: GitRequest): Promise<GitDiff> {
    const snapshot = await this.snapshot(context, repo, request), file = snapshot.files.find(file => file.path === request.path)
    if (!file || !request.path || notRelative(request.path)) throw new GitError('FILE_NOT_CHANGED', '该文件不在当前对比中，请刷新文件列表。')
    if (request.expectedRevision && request.expectedRevision !== snapshot.revision) throw new GitError('STALE_STATE', '仓库改动已更新，请刷新后查看。')
    const args = await this.diffArgs(context, repo, request), scope = request.scope ?? 'working'
    let oldRevision: string | null = scope === 'unstaged' ? '' : repo.head, newRevision: string | null | undefined = scope === 'staged' ? '' : undefined
    if (scope === 'branch') { oldRevision = args[0]!; newRevision = repo.head }
    const old = file.status === 'untracked' ? { text: null, tooLarge: false } : await this.blob(context, repo, oldRevision, file.oldPath ?? file.path)
    const next = newRevision !== undefined ? await this.blob(context, repo, newRevision, file.path) : await this.safeRead(context, repo, file.path)
    const tooLarge = old.tooLarge || next.tooLarge
    let patch = ''
    if (!file.binary && !tooLarge) {
      if (file.status === 'untracked') { const lines = (next.text ?? '').split('\n'); if (lines.at(-1) === '') lines.pop(); patch = `--- /dev/null\n+++ b/${file.path}\n` + (lines.length ? `@@ -0,0 +1,${lines.length} @@\n` + lines.map(line => '+' + line).join('\n') : '') }
      else patch = (await this.run(context, repo.root, [...DIFF, '--no-color', '--unified=3', ...args, '--', ...(file.oldPath ? [file.oldPath] : []), file.path], { maxBytes: 4 * EMPTY_LIMIT })).stdout.toString('utf8')
    }
    const after = await this.snapshot(context, await this.repository(context), request)
    if (after.revision !== snapshot.revision) throw new GitError('STALE_STATE', '文件读取期间发生变化，请刷新后重试。')
    return { sessionId: context.sessionId, revision: snapshot.revision, file, scope, ...(request.target ? { target: request.target } : {}), oldText: old.text, newText: next.text, patch, hunks: parseGitHunks(patch), tooLarge, ...(tooLarge ? { message: '文件较大，已保留改动统计，请在编辑器中查看完整内容。' } : file.binary ? { message: '二进制文件已修改，无法按文本行显示。' } : {}) }
  }
  private async validBranch(context: GitSessionContext, repo: Repository, branch?: string): Promise<string> {
    if (!branch || branch.startsWith('-') || branch.includes('\0') || branch.length > 512) throw new GitError('INVALID_BRANCH', '请输入有效的分支名称。')
    const result = await this.run(context, repo.root, ['check-ref-format', '--branch', branch], { allowFailure: true })
    if (result.code || ending(result.stdout) !== branch || branch === 'HEAD') throw new GitError('INVALID_BRANCH', '分支名称不符合 Git 命名规则。')
    return branch
  }
  private async mutate(context: GitSessionContext, repo: Repository, request: GitRequest): Promise<GitReceipt> {
    const binding = await this.binding(context, repo)
    if (context.running) throw new GitError('SESSION_BUSY', '会话正在执行任务，请停止或等待完成后操作 Git。')
    if (request.op !== 'restoreBinding' && this.mismatch(binding, repo)) throw new GitError('BRANCH_CHANGED', '当前分支与会话绑定分支不一致，请先恢复原分支。')
    await context.assertIdle?.(repo.root); this.current(context)
    const before = await this.snapshot(context, repo, { op: 'status', sessionId: context.sessionId, scope: 'working' })
    if (request.expectedRevision && request.expectedRevision !== before.revision) throw new GitError('STALE_STATE', '仓库改动已更新，请刷新后重试。')
    const changingBranch = ['selectBranch', 'createBranch', 'createWorktree'].includes(request.op)
    const assertWritable = () => {
      this.current(context)
      if (context.running) throw new GitError('SESSION_BUSY', '会话正在执行任务，请停止或等待完成后操作 Git。')
      if (changingBranch && (context.started || binding.locked)) throw new GitError('BRANCH_LOCKED', '会话已开始，不能更改分支或工作目录。')
    }
    const write = async (args: string[], input?: string) => {
      await context.assertIdle?.(repo.root); assertWritable()
      const actual = await this.repository(context)
      if (actual.root !== repo.root || actual.common !== repo.common || actual.branch !== repo.branch || actual.head !== repo.head) throw new GitError('STALE_STATE', '仓库分支或提交已变化，操作未执行，请刷新。')
      if (request.expectedRevision) {
        const latest = await this.snapshot(context, actual, { op: 'status', sessionId: context.sessionId, scope: 'working' })
        if (latest.revision !== request.expectedRevision) throw new GitError('STALE_STATE', '仓库改动已更新，操作未执行，请刷新。')
      }
      // No await separates these final live checks from the actual child-process spawn.
      assertWritable()
      return this.run(context, repo.root, args, { mutation: true, timeoutMs: ['fetch', 'pull', 'push'].includes(args[0]!) ? 120_000 : 30_000, ...(input !== undefined ? { input } : {}) })
    }
    let worktreePath: string | undefined, branch: string | undefined
    if (['selectBranch', 'createBranch', 'createWorktree'].includes(request.op) && (context.started || binding.locked)) throw new GitError('BRANCH_LOCKED', '会话已开始，不能更改分支或工作目录。')
    if (request.op === 'selectBranch' || request.op === 'restoreBinding') {
      branch = request.op === 'restoreBinding' ? binding.branch ?? undefined : request.branch
      if (request.op === 'restoreBinding' && (binding.repoRoot !== repo.common || binding.worktreeRoot !== repo.root)) throw new GitError('DIRECTORY_CHANGED', '会话绑定的仓库目录已变化，无法恢复。')
      if (!branch) throw new GitError('BRANCH_REQUIRED', '请选择一个分支。')
      const branches = await this.branches(context, repo), target = branches.find(item => item.ref === branch || item.name === branch)
      if (!target) throw new GitError('INVALID_BRANCH', '所选分支不存在，请刷新分支列表。')
      if (!target.current) {
        const dirty = await this.run(context, repo.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
        if (dirty.stdout.length) throw new GitError('DIRTY_WORKTREE', '当前目录有未提交修改，请先处理修改或使用独立工作树。')
        if (target.remote) {
          const name = target.name.slice(target.name.indexOf('/') + 1); await this.validBranch(context, repo, name)
          if (branches.some(item => !item.remote && item.name === name)) throw new GitError('BRANCH_EXISTS', '同名本地分支已存在，请直接选择本地分支。')
          await write(['switch', '--track', '-c', name, target.ref]); branch = name
        } else { await write(['switch', '--', target.name]); branch = target.name }
      } else branch = target.name
    } else if (request.op === 'createBranch') {
      branch = await this.validBranch(context, repo, request.branch)
      const base = request.base ? await this.target(context, repo, request.base) : repo.head
      if (request.base && base !== repo.head && (await this.run(context, repo.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout.length) throw new GitError('DIRTY_WORKTREE', '当前目录有未提交修改，不能从其他版本创建分支。')
      await write(['switch', '-c', branch, ...(base ? [base] : []), '--'])
    } else if (request.op === 'createWorktree') {
      branch = await this.validBranch(context, repo, request.branch)
      const base = request.base ? await this.target(context, repo, request.base) : repo.head
      if (!base) throw new GitError('NO_COMMITS', '仓库至少需要一个提交才能创建独立工作树。')
      const root = join(this.options.directory, 'worktrees'); await mkdir(root, { recursive: true, mode: 0o700 })
      if ((await lstat(root)).isSymbolicLink()) throw new GitError('UNSAFE_PATH', '工作树目录无效。')
      const path = join(root, randomUUID()), exists = (await this.branches(context, repo)).some(item => !item.remote && item.name === branch)
      if (exists && request.base && await this.target(context, repo, 'refs/heads/' + branch) !== base) throw new GitError('BRANCH_CONFLICT', '同名本地分支与所选起点不同，请使用其他分支名称。')
      const remoteRef = request.base?.startsWith('refs/remotes/') ? request.base : request.base && (await this.branches(context, repo)).find(item => item.remote && item.name === request.base)?.ref
      const remoteName = remoteRef?.slice('refs/remotes/'.length), track = !exists && remoteName?.slice(remoteName.indexOf('/') + 1) === branch
      await write(['worktree', 'add', ...(exists ? [] : ['-b', branch, ...(track ? ['--track'] : [])]), '--', path, exists ? branch : track ? remoteRef! : base])
      const suffix = relative(repo.root, repo.cwd), selected = resolve(path, suffix)
      const stat = await lstat(selected).catch(() => undefined)
      worktreePath = await realpath(stat?.isDirectory() && !stat.isSymbolicLink() ? selected : path)
    } else if (request.op === 'stage' || request.op === 'unstage') {
      const allowed = new Set(before.files.flatMap(file => [file.path, ...(file.oldPath ? [file.oldPath] : [])]))
      // Net-zero worktree changes can still exist in the index; consult status for staging actions.
      const status = porcelain((await this.run(context, repo.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout)
      for (const [path, flag] of status) { allowed.add(path); if (flag.oldPath) allowed.add(flag.oldPath) }
      const paths = request.paths === undefined ? [...allowed] : [...request.paths]
      if (!paths.length) throw new GitError('NO_CHANGES', '没有可操作的文件。')
      if (paths.some(path => notRelative(path) || !allowed.has(path))) throw new GitError('INVALID_PATH', '文件不在当前仓库改动列表中。')
      for (const [path, flag] of status) if (flag.oldPath && (paths.includes(path) || paths.includes(flag.oldPath))) { if (!paths.includes(path)) paths.push(path); if (!paths.includes(flag.oldPath)) paths.push(flag.oldPath) }
      const selected = request.paths === undefined ? ['.'] : paths
      if (request.op === 'stage') await write(['--literal-pathspecs', 'add', '-A', '--', ...selected])
      else if (repo.head) await write(['--literal-pathspecs', 'restore', '--staged', '--', ...selected])
      else await write(['--literal-pathspecs', 'rm', '--cached', '-r', '--ignore-unmatch', '--', ...selected])
    } else if (request.op === 'commit') {
      if (!request.message?.trim()) throw new GitError('COMMIT_MESSAGE_REQUIRED', '请填写提交说明。')
      const staged = await this.run(context, repo.root, ['diff', '--cached', '--quiet', '--exit-code'], { allowFailure: true })
      if (staged.code === 0) throw new GitError('NO_STAGED_CHANGES', '请先暂存需要提交的文件。')
      await write(['commit', '--file=-'], request.message)
    } else if (['fetch', 'pull', 'push'].includes(request.op)) {
      const remotes = before.remotes, upstreamRemote = remotes.find(item => before.upstream?.startsWith(item.name + '/'))
      const remote = request.remote ?? upstreamRemote?.name ?? (remotes.find(item => item.name === 'origin') ?? remotes[0])?.name
      if (!remote || !remotes.some(item => item.name === remote) || remote.startsWith('-')) throw new GitError('REMOTE_REQUIRED', '请先配置远程仓库。')
      if (request.op === 'fetch') await write(['fetch', '--', remote])
      else {
        if (!repo.branch || !repo.head) throw new GitError('BRANCH_REQUIRED', '请先选择并提交到一个本地分支。')
        if (request.op === 'pull') {
          const dirty = await this.run(context, repo.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
          if (dirty.stdout.length) throw new GitError('DIRTY_WORKTREE', '请先处理未提交修改，再拉取远程更新。')
          const destination = upstreamRemote?.name === remote && before.upstream ? before.upstream.slice(remote.length + 1) : repo.branch
          await write(['pull', '--ff-only', '--no-rebase', '--', remote, destination])
        } else {
          const destination = upstreamRemote?.name === remote && before.upstream ? before.upstream.slice(remote.length + 1) : repo.branch
          await write(['push', '--set-upstream', '--', remote, `refs/heads/${repo.branch}:refs/heads/${destination}`])
        }
      }
    } else throw new GitError('INVALID_OPERATION', '不支持该 Git 操作。')
    this.current(context)
    const after = await this.repository(context)
    if ((request.op === 'selectBranch' || request.op === 'createBranch') && branch) await this.store.write({ ...binding, branch, baseCommit: after.head, locked: binding.locked || context.started })
    return { completed: true, message: request.op === 'createWorktree' ? '独立工作树已准备好。' : 'Git 操作已完成。', ...(worktreePath ? { worktreePath } : {}), ...(branch ? { branch } : {}), snapshot: await this.snapshot(context, after, { op: 'status', sessionId: context.sessionId, scope: 'working' }) }
  }
}
