import type { Context } from '@deepseek-ai/cordis'
import { THEME_VIDEO_CHANNEL, THEME_VIDEO_METHOD, THEME_VIDEOS } from '../theme-video.ts'

export async function loadThemeVideo(ctx: Context, id: keyof typeof THEME_VIDEOS, signal: AbortSignal): Promise<{ url: string; dispose(): void }> {
  const connection = ctx?.get?.('connection') as { rpc?: { call(channel: string, method: string, payload: object, signal: AbortSignal): Promise<{ ok: boolean; value?: unknown }> } } | undefined
  if (!connection?.rpc) throw new Error('video-unavailable')
  const result = await connection.rpc.call(THEME_VIDEO_CHANNEL, THEME_VIDEO_METHOD, { id }, signal)
  signal.throwIfAborted()
  if (!result.ok || typeof result.value !== 'string' || result.value.length !== Math.ceil(THEME_VIDEOS[id].bytes / 3) * 4) throw new Error('video-unavailable')
  const bytes = Uint8Array.from(atob(result.value), char => char.charCodeAt(0))
  if (bytes.length !== THEME_VIDEOS[id].bytes) throw new Error('video-unavailable')
  const url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }))
  return { url, dispose() { URL.revokeObjectURL(url) } }
}
