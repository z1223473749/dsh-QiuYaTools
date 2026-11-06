import type { Context } from '@deepseek-ai/cordis'
import { LOCAL_THEME_VIDEO_METHOD, LOCAL_THEME_VIDEO_UPLOAD, LOCAL_VIDEO_ID, THEME_VIDEO_CHANNEL, THEME_VIDEO_METHOD, THEME_VIDEOS } from '../theme-video.ts'

async function videoRequest(ctx: Context | undefined, method: string, payload: object, signal?: AbortSignal): Promise<unknown> {
  const connection = ctx?.get?.('connection') as { rpc?: { call(channel: string, method: string, payload: object, signal?: AbortSignal): Promise<{ ok: boolean; value?: unknown; error?: { code?: string } }> } } | undefined
  if (!connection?.rpc) throw new Error('video-unavailable')
  const result = await connection.rpc.call(THEME_VIDEO_CHANNEL, method, payload, signal)
  signal?.throwIfAborted()
  if (!result.ok) throw new Error(result.error?.code ?? 'video-unavailable')
  return result.value
}

function videoResource(bytes: Uint8Array<ArrayBuffer>) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }))
  return { url, dispose() { URL.revokeObjectURL(url) } }
}

export async function loadThemeVideo(ctx: Context, id: keyof typeof THEME_VIDEOS, signal: AbortSignal): Promise<{ url: string; dispose(): void }> {
  const value = await videoRequest(ctx, THEME_VIDEO_METHOD, { id }, signal)
  if (typeof value !== 'string' || value.length !== Math.ceil(THEME_VIDEOS[id].bytes / 3) * 4) throw new Error('video-unavailable')
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0))
  if (bytes.length !== THEME_VIDEOS[id].bytes) throw new Error('video-unavailable')
  return videoResource(bytes)
}

export function localThemeVideoUrl(id: string): string {
  if (!LOCAL_VIDEO_ID.test(id)) throw new Error('video-unavailable')
  return new URL(`${THEME_VIDEO_CHANNEL}/${LOCAL_THEME_VIDEO_METHOD}?id=${id}`, location.href).href
}

export async function localThemeVideoInfo(id: string, signal: AbortSignal) {
  const url = localThemeVideoUrl(id)
  const response = await fetch(url, { method: 'HEAD', signal })
  const size = Number(response.headers.get('x-qyt-video-size') ?? response.headers.get('content-length'))
  if (!response.ok || !Number.isSafeInteger(size) || size <= 0) throw new Error('video-unavailable')
  return { url, size, audio: response.headers.get('x-qyt-video-audio') === '1' }
}

export async function saveLocalThemeVideo(file: File, signal: AbortSignal): Promise<string> {
  const response = await fetch(`${THEME_VIDEO_CHANNEL}/${LOCAL_THEME_VIDEO_UPLOAD}`, {
    method: 'POST', body: file, headers: { 'content-type': 'video/mp4' }, signal,
  })
  const result = await response.json()
  if (!response.ok || typeof result.id !== 'string' || !LOCAL_VIDEO_ID.test(result.id)) throw new Error(result.code ?? 'video-unavailable')
  return result.id
}

export async function discardLocalThemeVideo(id: string): Promise<void> {
  await fetch(localThemeVideoUrl(id), { method: 'POST' })
}
