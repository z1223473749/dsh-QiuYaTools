import type { Context } from '@deepseek-ai/cordis'
import { mkdir, open, readdir, stat, rename, rm, type FileHandle } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LOCAL_THEME_VIDEO_METHOD, LOCAL_THEME_VIDEO_UPLOAD, LOCAL_VIDEO_ID, readMp4Tracks, THEME_VIDEOS, THEME_VIDEO_CHANNEL, THEME_VIDEO_METHOD } from '../../theme-video.ts'
import { createVerifiedThemeCache } from '../theme-cache.ts'
import { validSuggestionId } from '../prompt-suggestions/contract.ts'

interface Services {
  profileContext: { dir: string }
  connection: {
    browserPeer?: { principal: { kind: string } }
    fetch: { register(route: { path: string; methods: readonly ('GET' | 'HEAD' | 'POST')[]; requestBody: 'buffered' | 'streaming'; fetch(request: Request): Promise<Response> }): () => Promise<void> }
  }
}

export function createThemeVideoCache(directory: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}) {
  return createVerifiedThemeCache(directory, THEME_VIDEOS, '.mp4', { ...options, unavailable: 'video-unavailable' })
}

async function fileTracks(file: FileHandle, size: number, signal: AbortSignal) {
  return readMp4Tracks(size, async (offset, count) => {
    signal.throwIfAborted()
    const buffer = Buffer.alloc(count)
    const { bytesRead } = await file.read(buffer, 0, count, offset)
    return buffer.subarray(0, bytesRead)
  })
}

function videoRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return { start: 0, end: size - 1 }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return null
  const first = match[1] ? Number(match[1]) : undefined
  const last = match[2] ? Number(match[2]) : undefined
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) return null
  const start = first ?? Math.max(0, size - last!)
  const end = first === undefined || last === undefined ? size - 1 : Math.min(last, size - 1)
  return start <= end && start < size ? { start, end } : null
}

function installLocalVideoStore(services: Services, lifetime: AbortSignal, isReferenced: (id: string) => boolean) {
  const directory = join(services.profileContext.dir, 'qiuya-local-theme-videos')
  const pathFor = (id: string) => join(directory, id + '.mp4')
  const activeUploads = new Set<string>()
  let cleanup: Promise<void> | undefined

  // Keep incomplete uploads out of the catalog. Reclaim abandoned drafts left
  // by previous runs, while preserving files still referenced by the profile.
  function collectAbandoned() {
    cleanup ??= (async () => {
      for (const entry of await readdir(directory)) {
        const id = entry.replace(/\.mp4(?:\.tmp)?$/, '')
        if (id === entry || !LOCAL_VIDEO_ID.test(id) || activeUploads.has(id) || isReferenced(id)) continue
        const path = join(directory, entry)
        const info = await stat(path).catch(() => undefined)
        if (info && Date.now() - info.mtimeMs > 86_400_000 && !isReferenced(id)) await rm(path, { force: true })
      }
    })().catch(() => {}).finally(() => { cleanup = undefined })
    return cleanup
  }

  const owner = () => !lifetime.aborted && services.connection.browserPeer?.principal.kind === 'owner'
  const stopUpload = services.connection.fetch.register({
    path: `${THEME_VIDEO_CHANNEL}/${LOCAL_THEME_VIDEO_UPLOAD}`, methods: ['POST'], requestBody: 'streaming',
    async fetch(request) {
      if (!owner()) return new Response(null, { status: 403 })
      if (request.headers.get('content-type') !== 'video/mp4' || !request.body) return new Response(null, { status: 415 })
      const id = randomUUID(), path = pathFor(id), temporary = path + '.tmp'
      const signal = AbortSignal.any([request.signal, lifetime])
      activeUploads.add(id)
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await collectAbandoned()
        await pipeline(Readable.fromWeb(request.body as unknown as NodeReadableStream<Uint8Array>),
          createWriteStream(temporary, { mode: 0o600, flags: 'wx' }), { signal })
        const file = await open(temporary, 'r')
        try {
          const { size } = await file.stat()
          const length = request.headers.get('content-length')
          if ((length !== null && size !== Number(length)) || !(await fileTracks(file, size, signal)).video) {
            return Response.json({ code: 'invalid-video' }, { status: 415 })
          }
        } finally { await file.close() }
        signal.throwIfAborted()
        if (!owner()) return new Response(null, { status: 403 })
        await rename(temporary, path)
        return Response.json({ id })
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        const diskFull = code === 'ENOSPC' || code === 'EDQUOT'
        return Response.json({ code: diskFull ? 'video-storage-full' : 'video-unavailable' }, { status: diskFull ? 507 : 500 })
      } finally {
        activeUploads.delete(id)
        await rm(temporary, { force: true }).catch(() => {})
      }
    },
  })
  const stopMedia = services.connection.fetch.register({
    path: `${THEME_VIDEO_CHANNEL}/${LOCAL_THEME_VIDEO_METHOD}`, methods: ['GET', 'HEAD', 'POST'], requestBody: 'buffered',
    async fetch(request) {
      if (!owner()) return new Response(null, { status: 403 })
      const id = new URL(request.url).searchParams.get('id')
      if (!id || !LOCAL_VIDEO_ID.test(id)) return new Response(null, { status: 400 })
      const path = pathFor(id)
      if (request.method === 'POST') {
        if (!isReferenced(id)) await rm(path, { force: true }).catch(() => {})
        return new Response(null, { status: 204 })
      }
      if (!isReferenced(id)) return new Response(null, { status: 404 })
      const signal = AbortSignal.any([request.signal, lifetime])
      let file: FileHandle | undefined
      try {
        file = await open(path, 'r')
        const { size } = await file.stat()
        const headers = new Headers({ 'accept-ranges': 'bytes', 'content-type': 'video/mp4', 'cache-control': 'private, no-store' })
        if (request.method === 'HEAD') {
          headers.set('content-length', String(size))
          // The desktop protocol strips Content-Length when forwarding responses.
          headers.set('x-qyt-video-size', String(size))
          headers.set('x-qyt-video-audio', (await fileTracks(file, size, signal)).audio ? '1' : '0')
          return new Response(null, { headers })
        }
        const rangeHeader = request.headers.get('range')
        const range = videoRange(rangeHeader, size)
        if (!range) {
          headers.set('content-range', `bytes */${size}`)
          return new Response(null, { status: 416, headers })
        }
        headers.set('content-length', String(range.end - range.start + 1))
        if (rangeHeader) headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`)
        const stream = file.createReadStream({ ...range, signal })
        file = undefined // The stream owns and closes the handle.
        return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status: rangeHeader ? 206 : 200, headers })
      } catch {
        return new Response(null, { status: 404 })
      } finally { await file?.close().catch(() => {}) }
    },
  })
  return async () => { await Promise.all([stopUpload(), stopMedia()]) }
}

export function installThemeVideoHost(ctx: Context, isReferenced?: (id: string) => boolean): () => void {
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
  const stopLocal = isReferenced && installLocalVideoStore(services, controller.signal, isReferenced)
  return () => { if (disposed) return; disposed = true; controller.abort(); void stop(); void stopLocal?.() }
}
