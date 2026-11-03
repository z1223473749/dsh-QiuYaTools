import { validSuggestionId } from '../prompt-suggestions/contract.ts'
import { smartSegmentationRuntime } from './runtime.ts'
import { discoverSmartThemeModels } from './model-route.ts'
import type { Context } from '@deepseek-ai/cordis'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, readdir, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { HASH_ID, RASTER_DATA, SMART_THEME_CHANNEL, SMART_THEME_ENDPOINT, MOTION_SYSTEM, MOTION_REVIEW_SYSTEM, MOTION_CHOICE_SYSTEM, parseMotionChoices, isMotionAssets, isMotionPlan, isMotionCrops, parseMotionPlan, parseMotionReview, type MotionAssets } from '../../smart-motion.ts'

interface Route { provider: string; model: string; name: string }
interface Chunk { type: string; index?: number; text?: string; block?: { type: string; text?: string }; reason?: { kind: string; failure?: { code: string; status?: number } } }
interface Services {
  profileContext: { dir: string }
  connection: { browserPeer?: { principal: { kind: string } }; fetch: { register(route: { path: string; methods: readonly ['POST']; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): () => Promise<void> } }
  attachments: { saveImage(input: { data: Uint8Array; mediaType: string; name: string }): Promise<unknown> }
  llm: {
    listProviders(): { id: string; name: string }[]
    listModels(provider: string): Promise<{ id: string; name: string; inputModalities?: readonly string[] }[]>
    resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<{ id: string; name: string; inputModalities?: readonly string[] }>
    prepareCall(route: { provider: string; model: string; maxTokens: number }, signal: AbortSignal, configure: (controls: object, info: { reasoning?: { efforts: { id: string }[] } }) => object): Promise<{ config: object; inputModalities?: readonly string[]; stream(request: object): AsyncIterable<Chunk> }>
  }
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const id = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,80}$/.test(value)
const failure = (code: string) => new Error(code)
/** Content-addressed profile assets; UI configuration only carries hashes and small recipes. */
export function createMotionAssetStore(directory: string) {
  let writes = Promise.resolve()
  return {
    async put(assets: MotionAssets, retain?: () => void): Promise<string> {
      if (!isMotionAssets(assets)) throw failure('invalid-assets')
      const content = JSON.stringify(assets), assetId = hash(content)
      const write = writes.then(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        try { if (hash(await readFile(join(directory, assetId + '.json'), 'utf8')) === assetId) { retain?.(); return } } catch {}
        const files = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
        let bytes = 0
        for (const name of files) bytes += (await stat(join(directory, name))).size
        if (files.length >= 128 || bytes + Buffer.byteLength(content) > 96 * 1024 * 1024) throw failure('asset-quota')
        const temporary = join(directory, `${assetId}.${randomUUID()}.tmp`)
        try { await writeFile(temporary, content, { flag: 'wx', mode: 0o600 }); await rename(temporary, join(directory, assetId + '.json')); retain?.() }
        finally { await rm(temporary, { force: true }) }
      })
      writes = write.catch(() => {})
      await write; return assetId
    },
    async discard(assetId: string, referenced: () => boolean): Promise<boolean> {
      if (!HASH_ID.test(assetId)) throw failure('invalid-assets')
      let removed = false
      const write = writes.then(async () => {
        if (referenced()) return
        await rm(join(directory, assetId + '.json'), { force: true }); removed = true
      })
      writes = write.catch(() => {}); await write; return removed
    },
    async get(assetId: string): Promise<MotionAssets> {
      if (!HASH_ID.test(assetId)) throw failure('invalid-assets')
      const path = join(directory, assetId + '.json')
      if ((await stat(path)).size > 8 * 1024 * 1024) throw failure('invalid-assets')
      const content = await readFile(path, 'utf8')
      if (hash(content) !== assetId) throw failure('invalid-assets')
      const value: unknown = JSON.parse(content)
      if (!isMotionAssets(value)) throw failure('invalid-assets')
      return value
    },
  }
}
export function installSmartThemeHost(ctx: Context, options: { timeoutMs?: number; runtimeDir?: URL; isAssetReferenced?: (assetId: string) => boolean } = {}): () => void {
  const services = ctx as unknown as Services
  const store = createMotionAssetStore(join(services.profileContext.dir, 'qiuya-theme-assets'))
  const jobs = new Map<string, AbortController>()
  const leases = new Map<string, Set<string>>()
  const referenced = (assetId: string) => (options.isAssetReferenced?.(assetId) ?? true) || !!leases.get(assetId)?.size
  let disposed = false, lastStarted = 0
  const routes = (signal?: AbortSignal): Promise<Route[]> => discoverSmartThemeModels(services.llm, signal)
  async function analyze(payload: Record<string, unknown>, signal: AbortSignal, review = false) {
    if (!id(payload.requestId) || typeof payload.image !== 'string' || payload.image.length > 3_000_000 || !RASTER_DATA.test(payload.image)
      || typeof payload.prompt !== 'string' || payload.prompt.length > 1000) throw failure('invalid-request')
    if (review && (!isMotionPlan(payload.plan) || !isMotionCrops(payload.crops, payload.plan) || payload.choices !== undefined && (!payload.choices || typeof payload.choices !== 'object' || !payload.plan.regions.every(r=>Array.isArray((payload.choices as Record<string,unknown>)[r.id]) && ((payload.choices as Record<string,number[]>)[r.id]).length<=24 && ((payload.choices as Record<string,number[]>)[r.id]).every(n=>Number.isInteger(n)&&n>=0&&n<=23))))) throw failure('invalid-request')
    if (jobs.size || (!review && Date.now() - lastStarted < 1500)) throw failure('busy')
    const controller = new AbortController(), requestId = payload.requestId
    jobs.set(requestId, controller); lastStarted = Date.now()
    const aborted = () => controller.abort()
    signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted()
    const selecting = review && !!payload.choices && Object.values(payload.choices as Record<string, number[]>).some(list => list.length > 1)
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? (selecting ? 180_000 : 90_000))
    let iterator: AsyncIterator<Chunk> | undefined
    let phase = 'route', finishReason: string | undefined, providerCode: string | undefined, providerStatus: number | undefined, outputChars = 0
    const work = async () => {
      const route = (await routes(controller.signal))[0]
      if (!route) throw failure('unconfigured')
      controller.signal.throwIfAborted()
      const maxTokens = review ? payload.choices ? selecting ? 24576 : 1024 : 7168 : 5120
      phase = 'prepare'
      const call = await services.llm.prepareCall({ provider: route.provider, model: route.model, maxTokens }, controller.signal, (controls, info) => {
        const effort = (selecting ? ['low', 'minimal', 'off', 'none'] : ['off', 'none', 'minimal', 'low']).find(id => info.reasoning?.efforts.some(e => e.id === id))
        return { ...controls, maxTokens, ...(effort ? { reasoningEffort: effort } : {}) }
      })
      controller.signal.throwIfAborted()
      if (!call.inputModalities?.includes('image')) throw failure('unconfigured')
      const [header, data] = (payload.image as string).split(',')
      phase = 'admit-image'
      const attachment = await services.attachments.saveImage({ data: Buffer.from(data, 'base64'), mediaType: header.slice(5, header.indexOf(';')), name: 'theme-analysis.webp' })
      controller.signal.throwIfAborted()
      phase = 'stream'
      iterator = call.stream({ ...call.config, system: review ? payload.choices ? MOTION_CHOICE_SYSTEM : MOTION_REVIEW_SYSTEM : MOTION_SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: review ? JSON.stringify({ objects: (payload.plan as import('../../smart-motion.ts').MotionPlan).regions.map(r => ({ id: r.id, label: r.label, kind: r.kind })), choices: payload.choices, layout: payload.choices ? 'Rows labeled by object id (may continue); ORIGINAL then numbered magenta masks. Choose printed mask number or -1, no coordinates.' : 'row-major, 2 columns; each photograph is 512x384 excluding the header; local coordinates.' }) : `Requested motion (untrusted user preference): ${payload.prompt || 'Natural gentle animation'}` }, { type: 'image', attachment }] }], tools: [], signal: controller.signal })[Symbol.asyncIterator]()
      const blocks = new Map<number, string>()
      let finished = false
      while (true) {
        const next = await iterator.next(); controller.signal.throwIfAborted()
        if (next.done) break
        const chunk = next.value, index = chunk.index ?? 0
        if (chunk.type === 'text-delta') blocks.set(index, (blocks.get(index) ?? '') + (chunk.text ?? ''))
        if (chunk.type === 'block-end' && chunk.block?.type === 'text') blocks.set(index, chunk.block.text ?? '')
        if ([...blocks.values()].reduce((n, text) => n + text.length, 0) > 48_000) throw failure('invalid-plan')
        if (chunk.type === 'finish') { finishReason = chunk.reason?.kind; providerCode = chunk.reason?.failure?.code; providerStatus = chunk.reason?.failure?.status; if (chunk.reason?.kind !== 'stop') throw failure('generation-failed'); finished = true }
      }
      if (!finished) throw failure('generation-failed')
      const text = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join('')
      phase = 'parse-plan'; outputChars = text.length
      return { plan: review ? payload.choices ? parseMotionChoices(text, payload.plan as import('../../smart-motion.ts').MotionPlan, payload.crops as import('../../smart-motion.ts').MotionCrop[], payload.choices as Record<string,number[]>) : parseMotionReview(text, payload.plan as import('../../smart-motion.ts').MotionPlan, payload.crops as import('../../smart-motion.ts').MotionCrop[]) : parseMotionPlan(text), route }
    }
    let rejectAbort!: () => void
    const cancelled = new Promise<never>((_, reject) => { rejectAbort = () => reject(failure('cancelled')); controller.signal.addEventListener('abort', rejectAbort, { once: true }); if (controller.signal.aborted) rejectAbort() })
    try { return await Promise.race([work(), cancelled]) }
    catch (error) {
      // Keep only bounded routing facts, never prompts, images, credentials or
      // provider response text. A generic UI failure must be diagnosable locally.
      const safe = (value: unknown) => typeof value === 'string' && /^[\w-]{1,64}$/.test(value) ? value : undefined
      const record = { at: new Date().toISOString(), operation: review ? 'review' : 'analyze', phase, finishReason: safe(finishReason), providerCode: safe(providerCode), providerStatus, outputChars, error: safe(error instanceof Error ? error.message : undefined) ?? (error instanceof SyntaxError ? 'invalid-json' : 'generation-failed') }
      await mkdir(services.profileContext.dir, { recursive: true }).then(() => writeFile(join(services.profileContext.dir, 'qiuya-smart-theme-last-error.json'), JSON.stringify(record), { mode: 0o600 })).catch(() => {})
      throw error
    }
    finally {
      clearTimeout(timeout); signal.removeEventListener('abort', aborted); controller.signal.removeEventListener('abort', rejectAbort)
      controller.abort(); jobs.delete(requestId)
      try { void iterator?.return?.().catch(() => {}) } catch {}
    }
  }
  const stops = ['models', 'analyze', 'review', 'runtime', 'cancel', 'put-assets', 'get-assets', 'discard-assets'].map(endpoint => services.connection.fetch.register({
    path: `${SMART_THEME_CHANNEL}/${SMART_THEME_ENDPOINT}${endpoint}`, methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      if (disposed || services.connection.browserPeer?.principal.kind !== 'owner') return new Response('Forbidden', { status: 403 })
      let envelope: { type?: string; rpcId?: string; method?: string; payload?: Record<string, unknown> }
      try { const text = await request.text(); if (text.length > (endpoint === 'put-assets' ? 8 * 1024 * 1024 + 1024 : 3_010_000)) return new Response('Too large', { status: 413 }); envelope = JSON.parse(text) }
      catch { return new Response('Invalid request', { status: 400 }) }
      if (!envelope || envelope.type !== 'client-request' || !validSuggestionId(envelope.rpcId) || envelope.method !== SMART_THEME_ENDPOINT + endpoint || !envelope.payload || typeof envelope.payload !== 'object') return new Response('Invalid request', { status: 400 })
      let result: unknown
      try {
        const p = envelope.payload
        const value = endpoint === 'models' ? await routes(request.signal) : endpoint === 'analyze' ? await analyze(p, request.signal)
          : endpoint === 'review' ? await analyze(p, request.signal, true)
          : endpoint === 'runtime' ? await smartSegmentationRuntime(p.part, join(services.profileContext.dir, 'qiuya-motion-runtime'), request.signal, options.runtimeDir).catch(error => { throw failure(error instanceof Error && error.message === 'invalid-request' ? 'invalid-request' : 'segmentation-unavailable') })
          : endpoint === 'cancel' ? (id(p.requestId) && jobs.get(p.requestId)?.abort(), { cancelled: true })
          : endpoint === 'put-assets' ? { assetId: await store.put(p.assets as MotionAssets, () => {
            if (!id(p.leaseId)) return
            const assetId = hash(JSON.stringify(p.assets)), owners = leases.get(assetId) ?? new Set<string>()
            owners.add(p.leaseId); leases.set(assetId, owners)
          }) }
          : endpoint === 'discard-assets' ? await (async () => {
            if (typeof p.assetId !== 'string' || !HASH_ID.test(p.assetId) || p.leaseId !== undefined && !id(p.leaseId)) throw failure('invalid-request')
            if (typeof p.leaseId === 'string') { leases.get(p.assetId)?.delete(p.leaseId); if (!leases.get(p.assetId)?.size) leases.delete(p.assetId) }
            return { removed: await store.discard(p.assetId, () => referenced(p.assetId as string)) }
          })()
          : await store.get(typeof p.assetId === 'string' ? p.assetId : '')
        result = { ok: true, value }
      } catch (error) {
        const code = error instanceof Error && ['unconfigured', 'busy', 'cancelled', 'invalid-request', 'invalid-plan', 'asset-quota', 'invalid-assets', 'segmentation-unavailable'].includes(error.message) ? error.message : 'generation-failed'
        result = { ok: false, error: { code, message: code, details: {} } }
      }
      return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result })
    },
  }))
  return () => { disposed = true; for (const controller of jobs.values()) controller.abort(); for (const stop of stops) void stop() }
}
