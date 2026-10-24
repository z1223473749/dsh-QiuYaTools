import { symbols } from '@deepseek-ai/cordis'

/**
 * Cordis wraps a Service again on each ctx.get(). Compare the exact underlying
 * service using its publicly exported original symbol, while keeping the traced
 * wrapper for API calls so registration remains owned by the caller's fiber.
 * Only call this on trusted Host service lookups, never a renderer/model DTO.
 */
export function hostServiceIdentity(value: unknown): object | undefined {
  if (value === null || typeof value !== 'object' && typeof value !== 'function') return undefined
  const original: unknown = Reflect.get(value, symbols.original)
  if (original === undefined) return value
  return original !== null && (typeof original === 'object' || typeof original === 'function') ? original : undefined
}
