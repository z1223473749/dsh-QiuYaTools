import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, lstat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitBinding } from './contract.ts'
import { GitError } from './contract.ts'

/** One file per Session avoids unrelated sessions overwriting each other's binding. */
export class GitBindingStore {
  constructor(private readonly directory: string) {}
  private path(id: string) { return join(this.directory, createHash('sha256').update(id).digest('hex') + '.json') }
  async read(id: string): Promise<GitBinding | undefined> {
    try {
      const path = this.path(id), stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw Error('Invalid binding')
      const value = JSON.parse(await readFile(path, 'utf8')) as GitBinding
      if (value.version !== 1 || value.sessionId !== id || typeof value.repoRoot !== 'string' || typeof value.worktreeRoot !== 'string' || !(value.branch === null || typeof value.branch === 'string') || !(value.baseCommit === null || typeof value.baseCommit === 'string') || typeof value.locked !== 'boolean' || !['current', 'worktree'].includes(value.mode) || !Number.isFinite(value.createdAt)) throw Error('Invalid binding')
      return value
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new GitError('BINDING_UNAVAILABLE', '会话的 Git 分支记录无法读取，请检查宿主存储。') }
  }
  async write(value: GitBinding): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const directory = await lstat(this.directory)
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new GitError('BINDING_UNAVAILABLE', 'Git 分支记录目录无效。')
    const temporary = join(this.directory, '.binding-' + randomUUID() + '.json')
    try { await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await rename(temporary, this.path(value.sessionId)) }
    catch { await unlink(temporary).catch(() => {}); throw new GitError('BINDING_UNAVAILABLE', '会话的 Git 分支记录无法保存。') }
  }
}
