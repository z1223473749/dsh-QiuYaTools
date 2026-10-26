import { spawn } from 'node:child_process'
import { GitError } from './contract.ts'

export interface GitRunResult { code: number; stdout: Buffer; stderr: Buffer }
export interface GitRunOptions { signal?: AbortSignal; input?: string | Buffer; timeoutMs?: number; maxBytes?: number; allowFailure?: boolean; mutation?: boolean }
/** Git is always invoked directly. Neither filenames nor refs are shell programs. */
export function runGit(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<GitRunResult> {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'core.pager=cat', ...args], {
      cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C', ...(!options.mutation ? { GIT_OPTIONAL_LOCKS: '0' } : {}) },
    })
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let bytes = 0, failure: Error | undefined, settled = false, killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (error: Error) => { failure ??= error; child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000) }
    const abort = () => stop(new GitError(options.mutation ? 'OPERATION_UNCONFIRMED' : 'CANCELLED', options.mutation ? 'Git 操作已中断，请刷新仓库状态后确认结果。' : 'Git 读取已取消。'))
    const timer = setTimeout(() => stop(new GitError(options.mutation ? 'OPERATION_UNCONFIRMED' : 'GIT_TIMEOUT', options.mutation ? 'Git 操作超时，请刷新仓库状态后确认结果。' : 'Git 读取超时。')), options.timeoutMs ?? 15_000)
    const collect = (target: Buffer[], chunk: Buffer) => { bytes += chunk.length; if (bytes > (options.maxBytes ?? 8 * 1024 * 1024)) stop(new GitError('OUTPUT_LIMIT', 'Git 输出过大，请缩小对比范围。')); else target.push(chunk) }
    child.stdout.on('data', chunk => collect(stdout, chunk)); child.stderr.on('data', chunk => collect(stderr, chunk))
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort()
    const finish = (error?: Error, code = 0) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); options.signal?.removeEventListener('abort', abort)
      if (error) { reject(error); return }
      const result = { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
      if (code && !options.allowFailure) { reject(gitFailure(result)); return }
      resolve(result)
    }
    child.once('error', error => finish(new GitError('GIT_UNAVAILABLE', (error as NodeJS.ErrnoException).code === 'ENOENT' ? '未找到 Git，请先在宿主安装 Git。' : 'Git 进程无法启动。')))
    child.once('close', code => finish(failure, code ?? 1)); child.stdin.on('error', () => {})
    child.stdin.end(options.input)
  })
}
export function gitFailure(result: GitRunResult): GitError {
  const text = result.stderr.toString('utf8')
  if (/index\.lock|another git process|cannot lock ref|Unable to create.*\.lock/iu.test(text)) return new GitError('GIT_BUSY', '仓库正被其他 Git 操作使用，请稍后刷新重试。')
  if (/not a git repository/iu.test(text)) return new GitError('NOT_A_REPOSITORY', '当前目录不是 Git 仓库。')
  if (/Authentication failed|Permission denied|could not read Username|terminal prompts disabled|publickey/iu.test(text)) return new GitError('AUTHENTICATION_REQUIRED', 'Git 认证失败，请检查宿主的 SSH 或 Git 凭据配置。')
  if (/non-fast-forward|fetch first|not possible to fast-forward|divergent branches|would be overwritten|local changes/iu.test(text)) return new GitError('GIT_CONFLICT', '远程分支或本地修改存在冲突，当前修改已保留，请处理后重试。')
  if (/already checked out|already used by worktree/iu.test(text)) return new GitError('BRANCH_IN_USE', '该分支已在其他工作树使用，请选择其他分支或创建新分支。')
  if (/already exists/iu.test(text)) return new GitError('BRANCH_EXISTS', '该分支已经存在。')
  if (/identity unknown|unable to auto-detect email/iu.test(text)) return new GitError('GIT_IDENTITY_REQUIRED', '请先配置 Git 提交者姓名和邮箱。')
  if (/Could not resolve host|Failed to connect|Connection timed out|unable to access/iu.test(text)) return new GitError('NETWORK_UNAVAILABLE', '无法连接 Git 远程仓库，请检查网络与远程地址。')
  if (/pre-commit|hook|gpg failed|failed to sign/iu.test(text)) return new GitError('COMMIT_REJECTED', '提交被 Git 钩子或签名配置拒绝，暂存修改已保留。')
  return new GitError('GIT_FAILED', 'Git 操作失败，请检查仓库状态、分支和权限。')
}
