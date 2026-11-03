import type { Context } from '@deepseek-ai/cordis'
import { SMART_THEME_CHANNEL, SMART_THEME_ENDPOINT, isMotionAssets, isMotionPlan, type MotionAssets, type MotionPlan, type MotionCrop } from '../smart-motion.ts'
export interface SmartModelRoute { provider: string; model: string; name: string }
export async function smartThemeRequest<T>(ctx: Context, endpoint: string, payload: object, signal?: AbortSignal): Promise<T> {
  const connection = ctx.get?.('connection') as { rpc?: { call(channel: string, endpoint: string, payload: object, signal?: AbortSignal): Promise<{ ok: boolean; value?: T; error?: { code: string } }> } } | undefined
  if (!connection?.rpc) throw new Error('unconfigured')
  const response = await connection.rpc.call(SMART_THEME_CHANNEL, SMART_THEME_ENDPOINT + endpoint, payload, signal)
  if (!response.ok) throw new Error(response.error?.code ?? 'generation-failed')
  return response.value as T
}
export async function analyzeSmartTheme(ctx: Context, payload: { image: string; prompt: string; requestId: string }, signal: AbortSignal): Promise<MotionPlan> {
  const value = await smartThemeRequest<{ plan: unknown }>(ctx, 'analyze', payload, signal)
  if (!isMotionPlan(value.plan)) throw new Error('invalid-plan')
  return value.plan
}
export async function reviewSmartTheme(ctx: Context, payload: { image: string; crops: MotionCrop[]; choices: Record<string,number[]>; plan: MotionPlan; prompt: string; requestId: string }, signal: AbortSignal): Promise<MotionPlan> {
  const value = await smartThemeRequest<{ plan: unknown }>(ctx, 'review', payload, signal)
  if (!isMotionPlan(value.plan)) throw new Error('invalid-plan')
  return value.plan
}
const assets = new Map<string, { value: MotionAssets; saved: boolean }>()
export async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(v => v.toString(16).padStart(2, '0')).join('')
}
export async function cacheMotionAssets(value: MotionAssets): Promise<string> {
  if (!isMotionAssets(value)) throw new Error('invalid-assets')
  const id = await digest(JSON.stringify(value))
  if (!assets.has(id)) { while (assets.size >= 4) assets.delete(assets.keys().next().value!); assets.set(id, { value, saved: false }) }
  return id
}
export async function loadMotionAssets(ctx: Context | undefined, id: string, signal?: AbortSignal): Promise<MotionAssets> {
  const hit = assets.get(id); if (hit) return hit.value
  if (!ctx) throw new Error('unconfigured')
  const value = await smartThemeRequest<MotionAssets>(ctx, 'get-assets', { assetId: id }, signal)
  if (!isMotionAssets(value) || await digest(JSON.stringify(value)) !== id) throw new Error('invalid-assets')
  await cacheMotionAssets(value); assets.get(id)!.saved = true
  return value
}
export async function persistMotionAssets(ctx: Context, id: string, leaseId?: string): Promise<void> {
  const entry = assets.get(id)
  if (!entry) { await loadMotionAssets(ctx, id); if (leaseId) await persistMotionAssets(ctx, id, leaseId); return }
  if (entry.saved && !leaseId) return
  const result = await smartThemeRequest<{ assetId: string }>(ctx, 'put-assets', { assets: entry.value, ...(leaseId ? { leaseId } : {}) })
  if (result.assetId !== id) throw new Error('invalid-assets')
  entry.saved = true
}
/** Discard only unreferenced assets; the Host also protects other saving drafts. */
export async function discardMotionAssets(ctx: Context, id: string, leaseId?: string, dropCache = true): Promise<void> {
  const entry = assets.get(id)
  if (entry?.saved || !entry || leaseId) await smartThemeRequest(ctx, 'discard-assets', { assetId: id, ...(leaseId ? { leaseId } : {}) })
  if (dropCache) assets.delete(id)
  else if (entry) entry.saved = false
}
