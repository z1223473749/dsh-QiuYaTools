import { constants, type BigIntStats } from 'node:fs'
import { open, lstat, realpath, opendir, link, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash, randomUUID, type Hash } from 'node:crypto'
import { ComputerError } from './contract.ts'

export const EXCHANGE_MAX_BYTES = 8 * 1024 * 1024
export const EXCHANGE_CHUNK_BYTES = 128 * 1024
const TTL = 120_000, MAX_UPLOADS = 2, LIST_LIMIT = 100, SCAN_LIMIT = 512
const PREFIX = '.qiuya-upload-'
const LOCK = '.qiuya-exchange.lock', GATE = '.qiuya-exchange.recovery'
interface DirectoryLock { identity?: BigIntStats; initialized: boolean; ownerId: string; gateIdentity?: BigIntStats; gateInitialized: boolean }
export interface ExchangeRequest { action: 'status' | 'list' | 'begin' | 'chunk' | 'commit' | 'abort' | 'cancel' | 'read'; name?: string; size?: number; sha256?: string; id?: string; offset?: number; data?: string; version?: string }
export interface ExchangeFile { name: string; size: number; modifiedAt: number; version: string }
export interface ExchangeResult { enabled: boolean; maxBytes: number; chunkBytes: number; files?: ExchangeFile[]; truncated?: boolean; id?: string; offset?: number; data?: string; done?: boolean; file?: ExchangeFile }
interface Upload { owner: string; name: string; path: string; handle?: FileHandle; size: number; offset: number; sha256: string; hash: Hash; expires: number; cancelled: boolean; published?: boolean }
function problem(code: string, message: string): never { throw new ComputerError(code, message) }
export function exchangeName(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 180 || value.normalize('NFC') !== value || /[<>:"/\\|?*\p{Cc}\p{Cf}]/u.test(value) || /[ .]$/u.test(value) || value === '.' || value === '..' || value.toLowerCase().startsWith('.qiuya-')) return problem('EXCHANGE_NAME', '文件名不合法：只允许不含路径的普通文件名。')
  const stem = value.split('.')[0]!.replace(/[ .]+$/u, '')
  if (/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu.test(stem)) return problem('EXCHANGE_NAME', '文件名不能使用 Windows 保留名称。')
  return value
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino }
function samePath(a: string, b: string): boolean { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b }
function fileInfo(name: string, stat: BigIntStats): ExchangeFile {
  return { name, size: Number(stat.size), modifiedAt: Number(stat.mtimeMs), version: createHash('sha256').update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`).digest('hex') }
}
function regular(stat: BigIntStats): boolean { return stat.isFile() && stat.nlink === 1n && stat.size >= 0n && stat.size <= BigInt(EXCHANGE_MAX_BYTES) }
async function directoryValid(root: string, identity: BigIntStats): Promise<void> {
  const current = await lstat(root, { bigint: true })
  if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(current, identity) || !samePath(await realpath(root), root)) problem('EXCHANGE_DIRECTORY_CHANGED', '交换目录已变化，请停止代理后重新配置。')
}
async function lockRecord(handle: FileHandle): Promise<{ version?: unknown; pid?: unknown; ownerId?: unknown }> {
  const bytes = Buffer.alloc(513); let used = 0
  while (used < bytes.length) { const read = await handle.read(bytes, used, bytes.length - used, used); if (!read.bytesRead) break; used += read.bytesRead }
  if (!used || used > 512) problem('EXCHANGE_DIRECTORY_BUSY', '交换目录锁超出限制，需由管理者检查。')
  try { const value = JSON.parse(bytes.subarray(0, used).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value }
  catch { return problem('EXCHANGE_DIRECTORY_BUSY', '交换目录锁记录无效，需由管理者检查。') }
}
async function lockValid(path: string, expected: BigIntStats, ownerId: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
  try {
    const stat = await handle.stat({ bigint: true })
    if (!regular(stat) || !sameFile(stat, expected) || stat.size > 512n) problem('EXCHANGE_LOCK_CHANGED', '交换目录锁身份已变化，请由管理者检查。')
    const record = await lockRecord(handle)
    if (record.ownerId !== ownerId) problem('EXCHANGE_LOCK_CHANGED', '交换目录锁所有者已变化，未移除其他代理的锁。')
  } finally { await handle.close() }
}
async function unlinkIdentity(root: string, rootIdentity: BigIntStats, name: string, expected: BigIntStats, ownerId?: string): Promise<void> {
  await directoryValid(root, rootIdentity)
  const current = await lstat(join(root, name), { bigint: true }).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined })
  if (!current) return
  if (!sameFile(current, expected) || current.isSymbolicLink()) problem('EXCHANGE_LOCK_CHANGED', '交换目录锁身份已变化，未移除其他代理的锁。')
  if (ownerId) await lockValid(join(root, name), expected, ownerId)
  await unlink(join(root, name))
}
async function acquireDirectory(root: string, rootIdentity: BigIntStats, onClaim: (lock: DirectoryLock) => void): Promise<DirectoryLock> {
  await directoryValid(root, rootIdentity)
  let gate: FileHandle
  try { gate = await open(join(root, GATE), 'wx', 0o600) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') problem('EXCHANGE_DIRECTORY_BUSY', '交换目录正在初始化或保留恢复门，请确认代理退出后由管理者检查。'); throw error }
  let gateIdentity: BigIntStats
  try { gateIdentity = await gate.stat({ bigint: true }) } catch (error) { await gate.close().catch(() => {}); throw error }
  const ownerId = randomUUID().replaceAll('-', '')
  const claim: DirectoryLock = { initialized: false, ownerId, gateIdentity, gateInitialized: false }; onClaim(claim)
  try {
    await gate.writeFile(JSON.stringify({ version: 1, pid: process.pid, ownerId })); await gate.sync()
    claim.gateInitialized = true
    await directoryValid(root, rootIdentity)
    try {
      const existing = await open(join(root, LOCK), constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
      try {
        const stat = await existing.stat({ bigint: true })
        if (!regular(stat) || stat.size < 1n || stat.size > 512n) problem('EXCHANGE_DIRECTORY_BUSY', '交换目录锁损坏，需由管理者检查。')
        const record = await lockRecord(existing)
        if (record.version !== 1 || typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0 || typeof record.ownerId !== 'string' || !/^[a-f0-9]{32}$/u.test(record.ownerId)) problem('EXCHANGE_DIRECTORY_BUSY', '交换目录锁无效，需由管理者检查。')
        let dead = false
        try { process.kill(record.pid, 0) } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH' }
        if (!dead) problem('EXCHANGE_DIRECTORY_BUSY', '专用交换目录只允许一个代理；已有进程仍在运行、PID 被复用或状态不可确认。')
        await existing.close()
        await unlinkIdentity(root, rootIdentity, LOCK, stat, record.ownerId)
      } finally { await existing.close() }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const handle = await open(join(root, LOCK), 'wx', 0o600)
    try { claim.identity = await handle.stat({ bigint: true }); await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, ownerId })); await handle.sync(); claim.initialized = true; await directoryValid(root, rootIdentity) }
    finally { await handle.close() }
    return claim
  } catch (error) {
    if (claim.identity) await unlinkIdentity(root, rootIdentity, LOCK, claim.identity, claim.initialized ? ownerId : undefined).then(() => { claim.identity = undefined }, () => {})
    throw error
  } finally {
    await gate.close()
    await unlinkIdentity(root, rootIdentity, GATE, gateIdentity, claim.gateInitialized ? ownerId : undefined)
    claim.gateIdentity = undefined
  }
}
export function parseExchangeRequest(value: unknown): ExchangeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return problem('EXCHANGE_REQUEST', '文件交换参数无效。')
  const input = value as Record<string, unknown>
  const fields: Record<string, string[]> = { status: [], list: [], begin: ['name', 'size', 'sha256'], chunk: ['id', 'offset', 'data'], commit: ['id'], abort: ['id'], cancel: [], read: ['name', 'version', 'offset'] }
  if (typeof input.action !== 'string' || !Object.hasOwn(fields, input.action) || Object.keys(input).some(key => key !== 'action' && !fields[input.action as string]!.includes(key))) return problem('EXCHANGE_REQUEST', '不支持的文件交换参数。')
  return input as unknown as ExchangeRequest
}

/** Operator-selected directory only. The mutex also fences reset against in-flight file IO. */
export class ComputerExchange {
  private static readonly failedClose = new Map<string, ComputerExchange>()
  private readonly uploads = new Map<string, Upload>()
  private tail: Promise<unknown> = Promise.resolve()
  private revision = 0
  private closed = false
  private timer?: ReturnType<typeof setInterval>
  private maintenancePending = false
  private constructor(private readonly root: string, private readonly identity: BigIntStats, private lock: DirectoryLock | undefined, private readonly now: () => number, private readonly hooks: { afterLockAcquired?(): Promise<void>; beforePublish?(): Promise<void>; afterPublish?(): Promise<void>; beforeRemove?(): Promise<void> }) {}
  static async create(directory: string, options: { now?: () => number; hooks?: { afterLockAcquired?(): Promise<void>; beforePublish?(): Promise<void>; afterPublish?(): Promise<void>; beforeRemove?(): Promise<void> } } = {}): Promise<ComputerExchange> {
    let store: ComputerExchange | undefined
    try {
      const selected = resolve(directory), selectedStat = await lstat(selected, { bigint: true })
      if (!selectedStat.isDirectory() || selectedStat.isSymbolicLink()) return problem('EXCHANGE_DIRECTORY', '交换目录必须是已存在的真实目录，不能使用链接。')
      // /var -> /private/var is a normal macOS ancestor alias. Pin its canonical
      // target once; the explicitly selected final directory itself cannot link.
      const root = await realpath(selected), stat = await lstat(root, { bigint: true })
      if (!stat.isDirectory() || !sameFile(stat, selectedStat)) return problem('EXCHANGE_DIRECTORY', '交换目录在打开时已变化。')
      const previous = this.failedClose.get(root)
      if (previous) await previous.close()
      await acquireDirectory(root, stat, lock => { store = new ComputerExchange(root, stat, lock, options.now ?? Date.now, options.hooks ?? {}) })
      await store!.hooks.afterLockAcquired?.()
      if (!store) problem('EXCHANGE_DIRECTORY', '交换目录锁未建立。')
      await store.removeAbandoned()
      const current = store
      store.timer = setInterval(() => {
        if (current.closed || current.maintenancePending) return
        current.maintenancePending = true
        void current.enqueue(() => current.expire()).catch(() => {}).finally(() => { current.maintenancePending = false })
      }, 5000); store.timer.unref()
      return store
    } catch (error) {
      try { await store?.close() } catch { return problem('EXCHANGE_CLEANUP_FAILED', '交换目录初始化后的清理未完成；恢复目录权限后重试会先清理本进程遗留锁。') }
      if (error instanceof ComputerError) throw error; return problem('EXCHANGE_DIRECTORY', '无法打开专用交换目录，请检查目录和权限。')
    }
  }
  private enqueue<T>(run: () => Promise<T>): Promise<T> { const task = this.tail.catch(() => {}).then(run); this.tail = task.catch(() => {}); return task }
  private async rootValid(): Promise<void> {
    await directoryValid(this.root, this.identity)
    if (this.lock?.identity) await lockValid(join(this.root, LOCK), this.lock.identity, this.lock.ownerId)
  }
  private base(): ExchangeResult { return { enabled: true, maxBytes: EXCHANGE_MAX_BYTES, chunkBytes: EXCHANGE_CHUNK_BYTES } }
  private async remove(upload: Upload, id: string): Promise<void> {
    upload.cancelled = true
    if (upload.handle) { await upload.handle.close(); upload.handle = undefined }
    await this.rootValid()
    await this.hooks.beforeRemove?.()
    try { await unlink(upload.path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.uploads.delete(id)
  }
  private async expire(): Promise<void> {
    for (const [id, upload] of this.uploads) if (upload.cancelled || upload.expires <= this.now()) await this.remove(upload, id)
    await this.removeAbandoned()
  }
  private async removeAbandoned(): Promise<void> {
    let inspected = 0, removed = 0
    const directory = await opendir(this.root)
    for await (const item of directory) {
      if (++inspected > SCAN_LIMIT || removed >= 32) break
      if (!/^\.qiuya-upload-[a-f0-9-]{36}\.tmp$/u.test(item.name)) continue
      const path = join(this.root, item.name), stat = await lstat(path, { bigint: true })
      if ([...this.uploads.values()].some(upload => upload.path === path)) continue
      // A crash between link(final) and unlink(temp) leaves nlink=2. Remove only
      // our expired temporary name, preserving the final name and its contents.
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= BigInt(EXCHANGE_MAX_BYTES) && this.now() - Number(stat.mtimeMs) > TTL) { await this.rootValid(); await unlink(path); removed++ }
    }
  }
  private async reserveAvailable(size: number): Promise<void> {
    let slots = this.uploads.size, bytes = [...this.uploads.values()].reduce((sum, upload) => sum + upload.size, 0), scanned = 0
    for await (const entry of await opendir(this.root)) {
      if (++scanned > SCAN_LIMIT) problem('EXCHANGE_LIST_LIMIT', '交换目录文件过多，请由目录管理者整理后重试。')
      if (!/^\.qiuya-upload-[a-f0-9-]{36}\.tmp$/u.test(entry.name)) continue
      const path = join(this.root, entry.name)
      if ([...this.uploads.values()].some(upload => upload.path === path)) continue
      const stat = await lstat(path, { bigint: true })
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(EXCHANGE_MAX_BYTES)) problem('EXCHANGE_FILE_CHANGED', '遗留临时文件状态异常，请由目录管理者检查。')
      slots++; bytes += Number(stat.size)
    }
    if (slots >= MAX_UPLOADS || bytes + size > MAX_UPLOADS * EXCHANGE_MAX_BYTES) problem('EXCHANGE_BUSY', '最多保留两个未完成上传（含重启遗留文件），请等待清理或取消当前上传。')
  }
  private async checkedFile(name: string): Promise<{ handle: FileHandle; stat: BigIntStats }> {
    const path = join(this.root, name)
    await this.rootValid()
    const before = await lstat(path, { bigint: true })
    if (!regular(before) || before.isSymbolicLink() || !samePath(await realpath(path), path)) return problem('EXCHANGE_FILE', '只允许专用目录中的普通、单链接且不超过 8 MiB 的文件。')
    const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
    try {
      const actual = await handle.stat({ bigint: true }), after = await lstat(path, { bigint: true })
      await this.rootValid()
      if (!regular(actual) || !sameFile(before, actual) || !sameFile(after, actual) || !samePath(await realpath(path), path)) problem('EXCHANGE_FILE_CHANGED', '读取前文件已变化，请刷新列表。')
      return { handle, stat: actual }
    } catch (error) { await handle.close(); throw error }
  }
  private async checkedUpload(upload: Upload): Promise<BigIntStats> {
    await this.rootValid()
    const actual = await upload.handle!.stat({ bigint: true }), pathStat = await lstat(upload.path, { bigint: true })
    if (!regular(actual) || !regular(pathStat) || !sameFile(actual, pathStat) || actual.size !== BigInt(upload.offset) || !samePath(await realpath(upload.path), upload.path)) problem('EXCHANGE_FILE_CHANGED', '上传临时文件已被外部修改或链接，已停止上传。')
    await this.rootValid(); return actual
  }
  run(owner: string, raw: unknown, signal?: AbortSignal): Promise<ExchangeResult> {
    const request = parseExchangeRequest(raw), revision = this.revision
    const current = () => { signal?.throwIfAborted(); if (this.closed || revision !== this.revision) problem('PAIR_UNAUTHORIZED', '文件交换已关闭或配对已撤销。') }
    return this.enqueue(async () => {
      let cleanupId: string | undefined
      try {
        current(); await this.rootValid(); await this.expire(); current()
        const result = this.base()
        if (request.action === 'status') return result
        if (request.action === 'cancel') { for (const [id, upload] of this.uploads) if (upload.owner === owner) await this.remove(upload, id); current(); return result }
        if (request.action === 'list') {
          const files: ExchangeFile[] = []; let inspected = 0, truncated = false
          const directory = await opendir(this.root)
          for await (const entry of directory) {
            current()
            if (++inspected > SCAN_LIMIT || files.length >= LIST_LIMIT) { truncated = true; break }
            try {
              const name = exchangeName(entry.name), file = await this.checkedFile(name)
              try { files.push(fileInfo(name, file.stat)) } finally { await file.handle.close() }
            } catch (error) { if (error instanceof ComputerError && ['EXCHANGE_NAME', 'EXCHANGE_FILE', 'EXCHANGE_FILE_CHANGED'].includes(error.code) || ['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error }
          }
          current(); return { ...result, files: files.sort((a, b) => a.name.localeCompare(b.name)), truncated }
        }
        if (request.action === 'begin') {
          const name = exchangeName(request.name), size = request.size
          if (!Number.isSafeInteger(size) || size! < 0 || size! > EXCHANGE_MAX_BYTES || typeof request.sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(request.sha256)) problem('EXCHANGE_SIZE', '文件需提供完整 SHA256，大小不能超过 8 MiB。')
          await this.reserveAvailable(size!)
          if ([...this.uploads.values()].some(upload => upload.name.toLowerCase() === name.toLowerCase())) problem('EXCHANGE_EXISTS', '已有同名文件正在上传。')
          let scanned = 0
          for await (const entry of await opendir(this.root)) {
            if (++scanned > SCAN_LIMIT) problem('EXCHANGE_LIST_LIMIT', '交换目录文件过多，请由目录管理者整理后重试。')
            if (entry.name.toLowerCase() === name.toLowerCase()) problem('EXCHANGE_EXISTS', '专用目录中已存在同名文件，请改名后上传。')
          }
          current(); await this.rootValid()
          const id = randomUUID(), path = join(this.root, `${PREFIX}${id}.tmp`)
          const handle = await open(path, 'wx+', 0o600)
          const upload: Upload = { owner, name, path, handle, size: size!, offset: 0, sha256: request.sha256!.toLowerCase(), hash: createHash('sha256'), expires: this.now() + TTL, cancelled: false }
          this.uploads.set(id, upload); cleanupId = id
          current(); await this.rootValid(); current(); cleanupId = undefined
          return { ...result, id, offset: 0 }
        }
        if (request.action === 'read') {
          const name = exchangeName(request.name), file = await this.checkedFile(name)
          try {
            const info = fileInfo(name, file.stat), offset = request.offset
            if (request.version !== info.version || !Number.isSafeInteger(offset) || offset! < 0 || offset! > info.size) problem('EXCHANGE_FILE_CHANGED', '文件已变化或读取位置无效，请刷新列表。')
            const bytes = Buffer.alloc(Math.min(EXCHANGE_CHUNK_BYTES, info.size - offset!)); let received = 0
            while (received < bytes.length) { current(); const read = await file.handle.read(bytes, received, bytes.length - received, offset! + received); if (!read.bytesRead) problem('EXCHANGE_FILE_CHANGED', '下载期间文件已变化。'); received += read.bytesRead }
            const after = await file.handle.stat({ bigint: true }), pathStat = await lstat(join(this.root, name), { bigint: true })
            await this.rootValid(); current()
            if (!regular(pathStat) || !sameFile(after, pathStat) || fileInfo(name, after).version !== info.version || fileInfo(name, pathStat).version !== info.version || !samePath(await realpath(join(this.root, name)), join(this.root, name))) problem('EXCHANGE_FILE_CHANGED', '下载期间文件已变化。')
            current(); return { ...result, file: info, offset: offset! + received, data: bytes.toString('base64'), done: offset! + received === info.size }
          } finally { await file.handle.close() }
        }
        const id = request.id
        if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/u.test(id)) problem('EXCHANGE_UPLOAD', '上传标识无效。')
        const upload = this.uploads.get(id!)
        if (!upload || upload.owner !== owner || upload.cancelled || !upload.handle) problem('EXCHANGE_UPLOAD', '上传不存在、已取消或已过期。')
        if (request.action === 'abort') { await this.remove(upload, id!); return result }
        cleanupId = id
        if (request.action === 'chunk') {
          if (request.offset !== upload.offset || typeof request.data !== 'string' || request.data.length > Math.ceil(EXCHANGE_CHUNK_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(request.data)) problem('EXCHANGE_CHUNK', '上传块位置或数据无效；重复块不会追加。')
          const bytes = Buffer.from(request.data, 'base64')
          if (!bytes.length || bytes.length > EXCHANGE_CHUNK_BYTES || bytes.toString('base64') !== request.data || upload.offset + bytes.length > upload.size || upload.offset + bytes.length > EXCHANGE_MAX_BYTES) problem('EXCHANGE_SIZE', '上传块超过声明大小或 8 MiB 限制。')
          await this.checkedUpload(upload); current()
          let written = 0
          while (written < bytes.length) { current(); const value = await upload.handle!.write(bytes, written, bytes.length - written, upload.offset + written); if (!value.bytesWritten) problem('EXCHANGE_IO', '上传块未写入。'); written += value.bytesWritten }
          await this.rootValid(); current(); upload.hash.update(bytes); upload.offset += bytes.length; upload.expires = this.now() + TTL; cleanupId = undefined
          return { ...result, id, offset: upload.offset }
        }
        if (request.action !== 'commit') problem('EXCHANGE_REQUEST', '不支持的文件交换操作。')
        if (upload.offset !== upload.size || upload.hash.digest('hex') !== upload.sha256) problem('EXCHANGE_DIGEST', '上传大小或 SHA256 校验失败，未发布文件。')
        await upload.handle!.sync(); const stat = await this.checkedUpload(upload), diskHash = createHash('sha256'), buffer = Buffer.alloc(EXCHANGE_CHUNK_BYTES)
        let offset = 0
        while (offset < upload.size) { current(); const read = await upload.handle!.read(buffer, 0, Math.min(buffer.length, upload.size - offset), offset); if (!read.bytesRead) problem('EXCHANGE_DIGEST', '磁盘上的上传大小不一致。'); diskHash.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead }
        const verified = await this.checkedUpload(upload)
        if (diskHash.digest('hex') !== upload.sha256 || fileInfo('', verified).version !== fileInfo('', stat).version) problem('EXCHANGE_DIGEST', '磁盘上的上传文件已变化或 SHA256 不一致。')
        await upload.handle!.close(); upload.handle = undefined
        await this.hooks.beforePublish?.(); await this.rootValid(); current()
        const destination = join(this.root, upload.name)
        // link is atomic and no-replace on NTFS/APFS; rename would overwrite.
        await link(upload.path, destination)
        upload.published = true
        await this.hooks.afterPublish?.()
        current(); await this.rootValid(); current()
        await unlink(upload.path)
        const published = await this.checkedFile(upload.name)
        const info = fileInfo(upload.name, published.stat); await published.handle.close()
        current(); this.uploads.delete(id!); cleanupId = undefined
        return { ...result, file: info, done: true }
      } catch (error) {
        let published = false
        if (cleanupId) { const upload = this.uploads.get(cleanupId); if (upload) { published = upload.published === true; await this.remove(upload, cleanupId).catch(() => {}) } }
        if (published) problem('EXCHANGE_COMMIT_UNKNOWN', '文件发布结果需要确认：请刷新交换目录检查，不会回滚或覆盖已发布文件。')
        if (error instanceof ComputerError) throw error
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') problem('EXCHANGE_EXISTS', '专用目录中已存在同名文件，未覆盖。')
        return problem('EXCHANGE_IO', '文件交换失败，请检查专用目录权限或重新配对。')
      }
    })
  }
  reset(): Promise<void> {
    this.revision++
    return this.enqueue(() => this.clearUploads())
  }
  private async clearUploads(): Promise<void> {
      const results = await Promise.allSettled([...this.uploads].map(([id, upload]) => this.remove(upload, id)))
      const failed = results.find((item): item is PromiseRejectedResult => item.status === 'rejected')
      if (failed) { if (failed.reason instanceof ComputerError) throw failed.reason; problem('EXCHANGE_CLEANUP_FAILED', '临时上传清理未完成，已阻止遗留事务复用，请检查目录权限后重试。') }
  }
  close(): Promise<void> {
    this.closed = true; clearInterval(this.timer); this.revision++
    return this.enqueue(async () => {
      await this.clearUploads()
      if (this.lock?.identity) { await unlinkIdentity(this.root, this.identity, LOCK, this.lock.identity, this.lock.initialized ? this.lock.ownerId : undefined); this.lock.identity = undefined }
      if (this.lock?.gateIdentity) { await unlinkIdentity(this.root, this.identity, GATE, this.lock.gateIdentity, this.lock.gateInitialized ? this.lock.ownerId : undefined); this.lock.gateIdentity = undefined }
      this.lock = undefined
      if (ComputerExchange.failedClose.get(this.root) === this) ComputerExchange.failedClose.delete(this.root)
    }).catch(error => {
      ComputerExchange.failedClose.set(this.root, this)
      if (error instanceof ComputerError) throw error
      return problem('EXCHANGE_CLEANUP_FAILED', '交换目录关闭清理未完成；恢复目录权限后可重试，不会移除其他代理的锁。')
    })
  }
}
