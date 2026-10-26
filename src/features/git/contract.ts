/** Browser-safe contracts shared by the Git Host and its session-scoped UI. */
export const GIT_ENDPOINT = 'qiuya-tools.git.control'
export type GitScope = 'working' | 'branch' | 'staged' | 'unstaged'
export type GitProvider = 'github' | 'gitlab' | 'gitee'
export type GitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'typechanged'
export interface GitBranch { name: string; ref: string; remote: boolean; current: boolean; upstream?: string; checkedOut?: boolean }
export interface GitFile {
  path: string; oldPath?: string; status: GitFileStatus; added: number | null; deleted: number | null
  staged: boolean; unstaged: boolean; binary: boolean; kind?: 'file' | 'symlink' | 'submodule'
}
export interface GitRemote { name: string; url: string }
export interface GitCommit { hash: string; shortHash: string; subject: string; author: string; at: number }
export interface GitBinding {
  version: 1; sessionId: string; repoRoot: string; worktreeRoot: string; branch: string | null
  baseCommit: string | null; locked: boolean; mode: 'current' | 'worktree'; createdAt: number
}
export interface GitSnapshot {
  sessionId: string; available: boolean; reason?: string; repoName: string; repoRoot: string
  branch: string | null; boundBranch?: string | null; head: string | null; locked: boolean; bindingMismatch: boolean
  mode: 'current' | 'worktree'; scope: GitScope; target?: string; revision: string
  added: number; deleted: number; fileCount: number; files: GitFile[]; remotes: GitRemote[]
  ahead: number; behind: number; upstream?: string; defaultTarget?: string
}
export interface GitHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
export interface GitDiff {
  sessionId: string; revision: string; file: GitFile; scope: GitScope; target?: string
  oldText: string | null; newText: string | null; patch: string; hunks: GitHunk[]
  tooLarge: boolean; message?: string
}
export interface GitReceipt { completed: boolean; message: string; snapshot?: GitSnapshot; worktreePath?: string; branch?: string }
export interface GitSessionContext {
  sessionId: string; cwd: string; started: boolean; running: boolean; signal: AbortSignal
  assertCurrent(): void
  /** Re-check all live users of the same working directory before a mutation. */
  assertIdle?(worktreeRoot?: string): Promise<void>
}
export interface GitRequest {
  op: 'status' | 'branches' | 'diff' | 'log' | 'selectBranch' | 'createBranch' | 'createWorktree' | 'stage' | 'unstage' | 'commit' | 'fetch' | 'pull' | 'push' | 'restoreBinding' | 'prList' | 'prCreate' | 'prUpdate' | 'credentialStatus' | 'credentialSet' | 'credentialRemove'
  sessionId: string; scope?: GitScope; target?: string; path?: string; paths?: string[]
  branch?: string; base?: string; message?: string; remote?: string; expectedRevision?: string
  requestId?: string; provider?: GitProvider; token?: string; title?: string; body?: string
  sourceBranch?: string; targetBranch?: string; draft?: boolean; number?: number
}
export interface GitRemoteRepository {
  provider: GitProvider; hostname: string; owner: string; repository: string; fullName: string; webUrl: string; apiBase: string
}
export interface GitPullRequest {
  provider: GitProvider; number: number; title: string; body: string; url: string
  state: 'open' | 'closed' | 'merged'; sourceBranch: string; targetBranch: string
  draft?: boolean; checkStatus: 'success' | 'failure' | 'pending' | 'unknown'
  reviewStatus?: string; mergeStatus?: string
}
export interface GitPullRequestInput { title: string; body: string; sourceBranch: string; targetBranch: string; draft?: boolean }
export interface GitCredentialStatus { provider: GitProvider; hostname: string; configured: boolean; writable: boolean }
export class GitError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'GitError' }
}
const operations = new Set<GitRequest['op']>(['status', 'branches', 'diff', 'log', 'selectBranch', 'createBranch', 'createWorktree', 'stage', 'unstage', 'commit', 'fetch', 'pull', 'push', 'restoreBinding', 'prList', 'prCreate', 'prUpdate', 'credentialStatus', 'credentialSet', 'credentialRemove'])
const keys = new Set(['op', 'sessionId', 'scope', 'target', 'path', 'paths', 'branch', 'base', 'message', 'remote', 'expectedRevision', 'requestId', 'provider', 'token', 'title', 'body', 'sourceBranch', 'targetBranch', 'draft', 'number'])
export function parseGitRequest(raw: unknown): GitRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new GitError('INVALID_REQUEST', 'Git 请求无效。')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some(key => !keys.has(key)) || !operations.has(value.op as GitRequest['op']) || typeof value.sessionId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(value.sessionId)) throw new GitError('INVALID_REQUEST', 'Git 请求无效。')
  for (const key of ['target', 'path', 'branch', 'base', 'message', 'remote', 'expectedRevision', 'requestId', 'token', 'title', 'body', 'sourceBranch', 'targetBranch']) {
    const item = value[key], limit = key === 'body' ? 32_000 : key === 'message' ? 16_000 : key === 'token' ? 8192 : 4096
    if (item !== undefined && (typeof item !== 'string' || item.length > limit || item.includes('\0'))) throw new GitError('INVALID_REQUEST', 'Git 请求字段无效。')
  }
  if (value.paths !== undefined && (!Array.isArray(value.paths) || value.paths.length > 2000 || value.paths.some(path => typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')))) throw new GitError('INVALID_REQUEST', '文件列表无效。')
  if (value.scope !== undefined && !['working', 'branch', 'staged', 'unstaged'].includes(String(value.scope))) throw new GitError('INVALID_REQUEST', '对比范围无效。')
  if (value.provider !== undefined && !['github', 'gitlab', 'gitee'].includes(String(value.provider))) throw new GitError('INVALID_REQUEST', '代码托管平台无效。')
  if (value.draft !== undefined && typeof value.draft !== 'boolean' || value.number !== undefined && (!Number.isSafeInteger(value.number) || Number(value.number) <= 0)) throw new GitError('INVALID_REQUEST', 'PR 参数无效。')
  return value as unknown as GitRequest
}
export function gitAddress(sessionId: string, path?: string): string { return `dsh-resource://qiuya-git/${encodeURIComponent(sessionId)}${path ? `?file=${encodeURIComponent(path)}` : ''}` }
export function parseGitAddress(address: string): { sessionId: string; path?: string } | undefined {
  try { const url = new URL(address); if (url.protocol !== 'dsh-resource:' || url.hostname !== 'qiuya-git' || url.hash || url.username || url.password) return; const sessionId = decodeURIComponent(url.pathname.slice(1)); if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(sessionId) || [...url.searchParams.keys()].some(key => key !== 'file') || url.searchParams.getAll('file').length > 1) return; return { sessionId, ...(url.searchParams.has('file') ? { path: url.searchParams.get('file')! } : {}) } } catch { return }
}
