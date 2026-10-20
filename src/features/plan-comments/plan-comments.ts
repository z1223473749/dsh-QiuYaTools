/** Browser-owned annotations and revision submissions for plan review. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One note anchored to a plan's rendered text. */
export interface PlanComment {
  readonly id: string
  readonly planKey: string
  readonly quote: string
  readonly note: string
  readonly start: number
  readonly end: number
  readonly prefix?: string
  readonly suffix?: string
}

/** Comments included in submitted revision text awaiting durable delivery. */
export interface PlanCommentRevision {
  readonly draft: string
  readonly ids: readonly string[]
  readonly afterSeq: number
}

/** Shared interaction state for the plan card and full-text preview. */
export interface PlanCommentsState {
  commentsByPlan: Record<string, readonly PlanComment[]>
  editableByPlan: Record<string, boolean>
  sendingByPlan: Record<string, boolean>
  missingByPlan: Record<string, readonly string[]>
  stagedByPlan: Record<string, PlanCommentRevision>
}

/** Declared mutations for the shared plan review state. */
export type PlanCommentsActions = {
  adopt: (state: PlanCommentsState, planKey: string) => void
  save: (state: PlanCommentsState, comment: PlanComment) => void
  remove: (state: PlanCommentsState, planKey: string, ids: readonly string[]) => void
  clear: (state: PlanCommentsState, planKey: string) => void
  setEditable: (state: PlanCommentsState, planKey: string, editable: boolean) => void
  setSending: (state: PlanCommentsState, planKey: string, sending: boolean) => void
  setMissing: (state: PlanCommentsState, planKey: string, ids: readonly string[]) => void
  stage: (state: PlanCommentsState, planKey: string, draft: string, ids: readonly string[], afterSeq: number) => void
  unstage: (state: PlanCommentsState, planKey: string, draft: string) => void
  confirm: (state: PlanCommentsState, planKey: string, draft: string, seq: number) => void
  confirmSubmitted: (state: PlanCommentsState, text: string, seq: number) => void
}

/** Stable empty selection for framework store selectors. */
export const EMPTY_PLAN_COMMENTS: readonly PlanComment[] = Object.freeze([])

const STORAGE_KEY = 'qiuyaTools.plan-comments.v1'

function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlanComment(value: unknown): value is PlanComment {
  if (!isObject(value)) return false
  const { id, planKey, quote, note, start, end, prefix, suffix } = value
  return typeof id === 'string' && id.length > 0
    && typeof planKey === 'string' && planKey.length > 0
    && typeof quote === 'string' && quote.trim().length > 0
    && typeof note === 'string' && note.trim().length > 0
    && typeof start === 'number' && Number.isSafeInteger(start) && start >= 0
    && typeof end === 'number' && Number.isSafeInteger(end) && end > start
    && end - start === quote.length
    && (prefix === undefined || typeof prefix === 'string')
    && (suffix === undefined || typeof suffix === 'string')
}

function restore(raw: string | null): Pick<PlanCommentsState, 'commentsByPlan' | 'stagedByPlan'> {
  const commentsByPlan = dictionary<readonly PlanComment[]>()
  const stagedByPlan = dictionary<PlanCommentRevision>()
  if (raw === null) return { commentsByPlan, stagedByPlan }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (_error) {
    // Malformed browser data starts a fresh usable interaction store.
    return { commentsByPlan, stagedByPlan }
  }
  if (!isObject(parsed)) return { commentsByPlan, stagedByPlan }
  if (isObject(parsed.commentsByPlan)) {
    for (const [planKey, items] of Object.entries(parsed.commentsByPlan)) {
      if (!Array.isArray(items)) continue
      const ids = new Set<string>()
      const valid = items.filter((item): item is PlanComment => {
        if (!isPlanComment(item) || item.planKey !== planKey || ids.has(item.id)) return false
        ids.add(item.id)
        return true
      })
      if (valid.length > 0) commentsByPlan[planKey] = valid
    }
  }
  if (isObject(parsed.stagedByPlan)) {
    for (const [planKey, item] of Object.entries(parsed.stagedByPlan)) {
      if (!isObject(item) || typeof item.draft !== 'string' || item.draft.length === 0 || !Array.isArray(item.ids)
        || typeof item.afterSeq !== 'number' || !Number.isSafeInteger(item.afterSeq) || item.afterSeq < -1) continue
      const ids = item.ids.filter((id): id is string => typeof id === 'string' && commentsByPlan[planKey]?.some(comment => comment.id === id) === true)
      if (ids.length > 0) stagedByPlan[planKey] = { draft: item.draft, ids: [...new Set(ids)], afterSeq: item.afterSeq }
    }
  }
  return { commentsByPlan, stagedByPlan }
}

function readStored(key: string): Pick<PlanCommentsState, 'commentsByPlan' | 'stagedByPlan'> {
  let raw: string | null = null
  try {
    raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch (_error) {
    // An unavailable browser store leaves the in-memory interaction usable.
  }
  return restore(raw)
}

function persist(key: string, state: PlanCommentsState): void {
  if (typeof localStorage === 'undefined') return
  const serialized = JSON.stringify({ commentsByPlan: state.commentsByPlan, stagedByPlan: state.stagedByPlan })
  try {
    localStorage.setItem(key, serialized)
  } catch (_error) {
    // Storage quota and private mode do not block comment gestures.
  }
}

function remove(state: PlanCommentsState, planKey: string, ids: readonly string[]): void {
  const current = state.commentsByPlan[planKey]
  if (current === undefined) return
  const selected = new Set(ids)
  const next = current.filter(item => !selected.has(item.id))
  if (next.length === current.length) return
  if (next.length === 0) delete state.commentsByPlan[planKey]
  else state.commentsByPlan[planKey] = next
}

function confirm(state: PlanCommentsState, planKey: string, text: string, seq: number): void {
  const revision = state.stagedByPlan[planKey]
  if (revision === undefined || revision.draft !== text || seq <= revision.afterSeq) return
  remove(state, planKey, revision.ids)
  delete state.stagedByPlan[planKey]
}

/**
 * Declare one session-scoped store shared by card, preview, and delivery confirmation.
 * @returns a registration handle with validated, non-fatal browser persistence.
 */
export function createPlanCommentsStore(): EngineStoreHandle<PlanCommentsState, PlanCommentsActions> {
  const handle = defineStore<PlanCommentsState, PlanCommentsActions>({
    init: () => ({ commentsByPlan: dictionary(), editableByPlan: dictionary(), sendingByPlan: dictionary(), missingByPlan: dictionary(), stagedByPlan: dictionary() }),
    actions: {
      adopt: (state, planKey) => {
        const identity = planKey.slice(0, planKey.lastIndexOf(':') + 1)
        const previous = Object.keys(state.commentsByPlan).filter(key => key !== planKey && key.startsWith(identity))
        if (previous.length === 0) return
        const current = [...(state.commentsByPlan[planKey] ?? EMPTY_PLAN_COMMENTS)]
        const ids = new Set(current.map(comment => comment.id))
        for (const key of previous) {
          for (const comment of state.commentsByPlan[key] ?? EMPTY_PLAN_COMMENTS) {
            if (ids.has(comment.id)) continue
            current.push({ ...comment, planKey })
            ids.add(comment.id)
          }
          delete state.commentsByPlan[key]
          delete state.editableByPlan[key]
          delete state.missingByPlan[key]
          delete state.stagedByPlan[key]
        }
        state.commentsByPlan[planKey] = current
      },
      save: (state, comment) => {
        const current = [...(state.commentsByPlan[comment.planKey] ?? EMPTY_PLAN_COMMENTS)]
        const index = current.findIndex(item => item.id === comment.id)
        const previous = current[index]
        if (index === -1) current.push(comment)
        else current[index] = comment
        state.commentsByPlan[comment.planKey] = current
        const staged = state.stagedByPlan[comment.planKey]
        if (staged !== undefined && previous !== undefined && (previous.note !== comment.note || previous.quote !== comment.quote)) {
          const ids = staged.ids.filter(id => id !== comment.id)
          if (ids.length === 0) delete state.stagedByPlan[comment.planKey]
          else state.stagedByPlan[comment.planKey] = { ...staged, ids }
        }
      },
      remove,
      clear: (state, planKey) => {
        delete state.commentsByPlan[planKey]
        delete state.missingByPlan[planKey]
        delete state.stagedByPlan[planKey]
      },
      setEditable: (state, planKey, editable) => {
        if (editable) state.editableByPlan[planKey] = true
        else delete state.editableByPlan[planKey]
      },
      setSending: (state, planKey, sending) => {
        if (sending) state.sendingByPlan[planKey] = true
        else delete state.sendingByPlan[planKey]
      },
      setMissing: (state, planKey, ids) => {
        const current = state.missingByPlan[planKey]
        if (ids.length === 0) {
          if (current !== undefined) delete state.missingByPlan[planKey]
        } else if (current === undefined || current.length !== ids.length || current.some((id, index) => id !== ids[index])) {
          state.missingByPlan[planKey] = [...ids]
        }
      },
      stage: (state, planKey, draft, ids, afterSeq) => {
        state.stagedByPlan[planKey] = { draft, ids: [...ids], afterSeq }
      },
      unstage: (state, planKey, draft) => {
        if (state.stagedByPlan[planKey]?.draft === draft) delete state.stagedByPlan[planKey]
      },
      confirm,
      confirmSubmitted: (state, text, seq) => {
        for (const planKey of Object.keys(state.stagedByPlan)) confirm(state, planKey, text, seq)
      },
    },
  })
  return {
    spec: handle.spec,
    create: (scopeKey) => {
      const instance = handle.create(scopeKey)
      const key = scopeKey === undefined ? STORAGE_KEY : `${STORAGE_KEY}.${scopeKey}`
      instance.store.set({ ...readStored(key), editableByPlan: dictionary(), sendingByPlan: dictionary(), missingByPlan: dictionary() })
      instance.subscribe(() => { persist(key, instance.getSnapshot()) })
      return {
        ...instance,
        clearPersisted: () => {
          if (typeof localStorage === 'undefined') return
          try {
            localStorage.removeItem(key)
          } catch (_error) {
            // Browser storage can be unavailable during scope teardown.
          }
        },
      }
    },
  }
}

function hash(text: string): string {
  let value = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return (value >>> 0).toString(36)
}

/**
 * Identify a plan by its session, invocation (or unnamed request), and Markdown.
 * @param sessionId - the owning Session.
 * @param requestKey - tool call id, or the pending unnamed request key.
 * @param markdown - exact plan text.
 * @returns the browser-owned plan key.
 */
export function planCommentKey(sessionId: SessionId, requestKey: string, markdown: string): string {
  return `${encodeURIComponent(sessionId)}:${encodeURIComponent(requestKey)}:${hash(markdown)}`
}

function contextMatches(text: string, start: number, comment: PlanComment): boolean {
  const end = start + comment.quote.length
  return (comment.prefix === undefined || text.slice(Math.max(0, start - comment.prefix.length), start) === comment.prefix)
    && (comment.suffix === undefined || text.slice(end, end + comment.suffix.length) === comment.suffix)
}

/**
 * Resolve an annotation only when its original offset or text context identifies it.
 * @param text - current rendered plan text.
 * @param comment - persisted quote and text offsets.
 * @returns exact text offsets, or undefined for a missing or ambiguous quote.
 */
export function locatePlanComment(text: string, comment: PlanComment): { start: number; end: number } | undefined {
  if (text.slice(comment.start, comment.end) === comment.quote && contextMatches(text, comment.start, comment)) {
    return { start: comment.start, end: comment.end }
  }
  const candidates: number[] = []
  let offset = text.indexOf(comment.quote)
  while (offset !== -1) {
    candidates.push(offset)
    offset = text.indexOf(comment.quote, offset + 1)
  }
  if (candidates.length === 1) {
    const start = candidates[0] as number
    return { start, end: start + comment.quote.length }
  }
  const contextual = candidates.filter(start => contextMatches(text, start, comment))
  if (contextual.length !== 1) return undefined
  const start = contextual[0] as number
  return { start, end: start + comment.quote.length }
}
