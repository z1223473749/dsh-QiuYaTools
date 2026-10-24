export const DIAGNOSTICS_ENDPOINT = 'qiuya-tools.browser-diagnostics'
export const DIAGNOSTICS_LIMITS = Object.freeze({ entries: 128, bytes: 32768, requests: 128, pending: 16, sessions: 32, durationMs: 120000 })
export interface DiagnosticEvent { method: string; sessionId?: string; params?: Record<string, unknown> }
export interface DiagnosticAssociation { runId: string; checkId: string; attemptId: string }
export interface DiagnosticEntry {
  sequence: number; at: number; kind: 'console' | 'exception' | 'network'; level: string
  summary: string; argumentTypes?: string[]; count?: number; errorClass?: string
  method?: string; pathHash?: string; status?: number; durationMs?: number; failure?: string
  association?: DiagnosticAssociation
}
export interface DiagnosticSnapshot {
  diagnosticId: string; chatSessionId: string; environmentId: string; workbenchTabId: string
  targetId: string; epoch: number; origin: string; state: 'collecting' | 'stopped'
  startedAt: number; endedAt: number | null; reason: string | null; dropped: number
  entries: DiagnosticEntry[]; entryCount?: number; privacy: 'metadata-only'; verdict: 'diagnostic-only'
}
export interface DiagnosticRequest { requestId: string; chatSessionId: string; origin: string; environmentId: string; workbenchTabId: string; reason: string; expiresAt: number }
export function diagnosticObject(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || keys && Object.keys(value).some(key => !keys.includes(key))) throw Error('INVALID_DIAGNOSTIC_REQUEST')
  return value as Record<string, unknown>
}
export function diagnosticString(value: unknown, max = 256): string { if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f]/u.test(value)) throw Error('INVALID_DIAGNOSTIC_REQUEST'); return value }
export function diagnosticId(value: unknown): string { const id = diagnosticString(value, 128); if (!/^[a-zA-Z0-9._:-]+$/u.test(id)) throw Error('INVALID_DIAGNOSTIC_REQUEST'); return id }
