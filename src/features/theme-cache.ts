import { mkdir, readFile, stat, writeFile, rename, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

interface Artifact {
  url: string
  bytes: number
  sha256: string
}

/** Verify cache hits and new downloads against the manifest. Concurrent
 * requests share the same download even if a view closes. */
export function createVerifiedThemeCache(directory: string, artifacts: Readonly<Record<string, Artifact>>, suffix: string, options: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; unavailable?: string } = {}) {
  const pending = new Map<string, Promise<Buffer>>()
  return {
    async get(id: unknown): Promise<Buffer> {
      if (typeof id !== 'string' || !Object.hasOwn(artifacts, id)) throw new Error('invalid-request')
      const artifact = artifacts[id]!
      let job = pending.get(id)
      if (!job) {
        job = (async () => {
          const path = join(directory, artifact.sha256 + suffix)
          try {
            if ((await stat(path)).size === artifact.bytes) {
              const bytes = await readFile(path)
              if (sha256(bytes) === artifact.sha256) return bytes
            }
          } catch { /* absent or corrupt cache downloads again */ }
          const response = await (options.fetch ?? fetch)(artifact.url, { signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 120_000)]) })
          const declared = response.headers.get('content-length')
          if (!response.ok || declared && Number(declared) > artifact.bytes || !response.body) throw new Error(options.unavailable ?? 'artifact-unavailable')
          const reader = response.body.getReader(), chunks: Uint8Array[] = []
          let size = 0
          try {
            while (true) {
              const { value, done } = await reader.read()
              if (done) break
              size += value.byteLength
              if (size > artifact.bytes) throw new Error(options.unavailable ?? 'artifact-unavailable')
              chunks.push(value)
            }
          } finally { await reader.cancel().catch(() => {}) }
          const bytes = Buffer.concat(chunks)
          if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error(options.unavailable ?? 'artifact-unavailable')
          await mkdir(directory, { recursive: true, mode: 0o700 })
          const temporary = path + '.' + randomUUID() + '.tmp'
          try { await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await rename(temporary, path) }
          finally { await rm(temporary, { force: true }) }
          return bytes
        })()
        pending.set(id, job)
        void job.finally(() => { if (pending.get(id) === job) pending.delete(id) }).catch(() => {})
      }
      return job
    },
  }
}
