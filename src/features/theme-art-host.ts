import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { THEME_ART_CHANNEL, THEME_ART_FILES, THEME_ART_METHOD } from '../theme-art.ts'
import { validSuggestionId } from './prompt-suggestions/contract.ts'
import { createVerifiedThemeCache } from './theme-cache.ts'

interface Services {
  profileContext: { dir: string }
  connection: {
    browserPeer?: { principal: { kind: string } }
    fetch: { register(route: { path: string; methods: readonly ['POST']; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): () => Promise<void> }
  }
}

export function installThemeArtHost(ctx: Context): () => void {
  const { connection, profileContext } = ctx as unknown as Services
  const controller = new AbortController()
  const cache = createVerifiedThemeCache(join(profileContext.dir, 'qiuya-theme-art'), THEME_ART_FILES, '.image', { signal: controller.signal, timeoutMs: 30_000 })
  const stop = connection.fetch.register({
    path: `${THEME_ART_CHANNEL}/${THEME_ART_METHOD}`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (controller.signal.aborted || connection.browserPeer?.principal.kind !== 'owner') return new Response('Forbidden', { status: 403 })
      let envelope: { type?: string; rpcId?: string; method?: string; payload?: { id?: unknown } }
      try {
        const text = await request.text()
        if (text.length > 1024) return new Response('Too large', { status: 413 })
        envelope = JSON.parse(text)
      } catch { return new Response('Invalid request', { status: 400 }) }
      if (!envelope || envelope.type !== 'client-request' || !validSuggestionId(envelope.rpcId) || envelope.method !== THEME_ART_METHOD || !envelope.payload) return new Response('Invalid request', { status: 400 })

      let result
      try { result = { ok: true, value: (await cache.get(envelope.payload.id)).toString('base64') } }
      catch {
        result = { ok: false, error: { code: 'art-unavailable', message: 'art-unavailable', details: {} } }
      }
      return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result })
    },
  })
  return () => { controller.abort(); void stop() }
}
