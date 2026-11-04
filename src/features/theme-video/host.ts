import type { Context } from '@deepseek-ai/cordis'
import { mkdir, readFile, stat, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { THEME_VIDEOS, THEME_VIDEO_CHANNEL, THEME_VIDEO_METHOD } from '../../theme-video.ts'
import { validSuggestionId } from '../prompt-suggestions/contract.ts'

interface Services {
  profileContext: { dir: string }
  connection: {
    browserPeer?: { principal: { kind: string } }
    fetch: { register(route: { path: string; methods: readonly ['POST']; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): () => Promise<void> }
  }
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** One fixed artifact, bounded and verified before it becomes a cache entry.
 * Nothing is fetched until requested; concurrent preview/window requests share
 * a download. Cancellation of a view leaves the shared cache fill intact. */
export function createThemeVideoCache(directory: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}) {
  const pending = new Map<string, Promise<Buffer>>()
  return {
    async get(id: unknown): Promise<Buffer> {
      if (typeof id !== 'string' || !Object.hasOwn(THEME_VIDEOS, id)) throw new Error('invalid-request')
      const artifact = THEME_VIDEOS[id as keyof typeof THEME_VIDEOS]
      let job = pending.get(id)
      if (!job) {
        job = (async () => {
          const path = join(directory, artifact.sha256 + '.mp4')
          try {
            if ((await stat(path)).size === artifact.bytes) {
              const bytes = await readFile(path)
              if (sha256(bytes) === artifact.sha256) return bytes
            }
          } catch { /* absent or corrupt cache downloads again */ }
          const response = await (options.fetch ?? fetch)(artifact.url, { signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(120_000)]) })
          const declared = response.headers.get('content-length')
          if (!response.ok || declared && Number(declared) > artifact.bytes || !response.body) throw new Error('video-unavailable')
          const reader = response.body.getReader(), chunks: Uint8Array[] = []
          let size = 0
          try {
            while (true) {
              const { value, done } = await reader.read()
              if (done) break
              size += value.byteLength
              if (size > artifact.bytes) throw new Error('video-unavailable')
              chunks.push(value)
            }
          } finally { await reader.cancel().catch(() => {}) }
          const bytes = Buffer.concat(chunks)
          if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error('video-unavailable')
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

export function installThemeVideoHost(ctx: Context): () => void {
  const services = ctx as unknown as Services, controller = new AbortController()
  const cache = createThemeVideoCache(join(services.profileContext.dir, 'qiuya-theme-videos'), { signal: controller.signal })
  let disposed = false
  const stop = services.connection.fetch.register({
    path: `${THEME_VIDEO_CHANNEL}/${THEME_VIDEO_METHOD}`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (disposed || services.connection.browserPeer?.principal.kind !== 'owner') return new Response('Forbidden', { status: 403 })
      let envelope: { type?: string; rpcId?: string; method?: string; payload?: { id?: unknown } }
      try {
        const text = await request.text()
        if (text.length > 1024) return new Response('Too large', { status: 413 })
        envelope = JSON.parse(text)
      } catch { return new Response('Invalid request', { status: 400 }) }
      if (!envelope || envelope.type !== 'client-request' || !validSuggestionId(envelope.rpcId) || envelope.method !== THEME_VIDEO_METHOD || !envelope.payload) return new Response('Invalid request', { status: 400 })
      let result: unknown
      try { result = { ok: true, value: (await cache.get(envelope.payload.id)).toString('base64') } }
      catch (error) { result = { ok: false, error: { code: error instanceof Error && error.message === 'invalid-request' ? 'invalid-request' : 'video-unavailable', message: 'video-unavailable', details: {} } } }
      return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result })
    },
  })
  return () => { if (disposed) return; disposed = true; controller.abort(); void stop() }
}
