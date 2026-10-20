/** Connection's native channel grammar allows one segment; plugin paths belong to the endpoint. */
export const PROMPT_SUGGESTIONS_CHANNEL = '/api'
export const PROMPT_SUGGESTIONS_GENERATE_ENDPOINT = 'qiuya-tools/prompt-suggestions/generate'
export const PROMPT_SUGGESTIONS_CANCEL_ENDPOINT = 'qiuya-tools/prompt-suggestions/cancel'

export type PromptSuggestionLanguage = 'zh' | 'en'
export type PromptSuggestionReason = 'disabled' | 'unavailable' | 'busy' | 'empty' | 'timeout' | 'cancelled' | 'stale' | 'failed'
export interface PromptSuggestionRequest { sessionId: string; requestId: string; language: PromptSuggestionLanguage }
export interface PromptSuggestionCancelRequest { requestId: string }
export interface PromptSuggestionResult { suggestion: string | null; anchorMessageId: string | null; reason?: PromptSuggestionReason }

export function validSuggestionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/u.test(value)
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
export function parsePromptSuggestionRequest(value: unknown): PromptSuggestionRequest {
  if (!object(value) || !validSuggestionId(value.sessionId) || !validSuggestionId(value.requestId) || (value.language !== 'zh' && value.language !== 'en')) throw new Error('Invalid suggestion request')
  return { sessionId: value.sessionId, requestId: value.requestId, language: value.language }
}
export function parsePromptSuggestionCancelRequest(value: unknown): PromptSuggestionCancelRequest {
  if (!object(value) || !validSuggestionId(value.requestId)) throw new Error('Invalid suggestion cancellation')
  return { requestId: value.requestId }
}
