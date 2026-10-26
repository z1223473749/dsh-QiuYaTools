/** Session-owned text annotations and receipt-confirmed revision submissions. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** Offsets refer to rendered text within one assistant content block. */
export interface ConversationTextAnchor {
  readonly quote: string
  readonly start: number
  readonly end: number
  readonly prefix?: string
  readonly suffix?: string
}

/** Stable message and content identities keep repeated text in separate replies apart. */
export interface ConversationComment extends ConversationTextAnchor {
  readonly id: string
  readonly messageId: string
  readonly contentId: string
  readonly note: string
}

/** The exact text and comment revisions carried by an outstanding submission. */
export interface ConversationCommentSubmission {
  readonly draft: string
  readonly ids: readonly string[]
  readonly revisions: Readonly<Record<string, number>>
  readonly afterSeq: number
  readonly match: 'exact' | 'includes'
}

export interface ConversationCommentsState {
  comments: readonly ConversationComment[]
  staged: readonly ConversationCommentSubmission[]
  revisions: Record<string, number>
  sending: boolean
  missing: readonly string[]
}

export type ConversationCommentsActions = {
  save: (state: ConversationCommentsState, comment: ConversationComment) => void
  remove: (state: ConversationCommentsState, ids: readonly string[]) => void
  clear: (state: ConversationCommentsState) => void
  setSending: (state: ConversationCommentsState, sending: boolean) => void
  setMissing: (state: ConversationCommentsState, ids: readonly string[]) => void
  /** Includes mode requires a complete annotation block carrying a unique submission marker. */
  stage: (state: ConversationCommentsState, draft: string, ids: readonly string[], afterSeq: number, match?: 'exact' | 'includes') => void
  unstage: (state: ConversationCommentsState, draft: string) => void
  confirmSubmitted: (state: ConversationCommentsState, text: string, seq: number) => void
}

export const EMPTY_CONVERSATION_COMMENTS: readonly ConversationComment[] = Object.freeze([])
const STORAGE_KEY = 'qiuyaTools.conversation-comments.v1'

function dictionary<T>(): Record<string, T> { return Object.create(null) as Record<string, T> }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function identity(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function revision(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }

function isComment(value: unknown): value is ConversationComment {
  if (!object(value)) return false
  return identity(value.id) && identity(value.messageId) && identity(value.contentId)
    && typeof value.quote === 'string' && value.quote.trim().length > 0
    && typeof value.note === 'string' && value.note.trim().length > 0
    && typeof value.start === 'number' && Number.isSafeInteger(value.start) && value.start >= 0
    && typeof value.end === 'number' && Number.isSafeInteger(value.end) && value.end > value.start
    && value.end - value.start === value.quote.length
    && (value.prefix === undefined || typeof value.prefix === 'string')
    && (value.suffix === undefined || typeof value.suffix === 'string')
}

function sameComment(first: ConversationComment, second: ConversationComment): boolean {
  return first.id === second.id && first.messageId === second.messageId && first.contentId === second.contentId
    && first.quote === second.quote && first.note === second.note && first.start === second.start && first.end === second.end
    && first.prefix === second.prefix && first.suffix === second.suffix
}

function emptyState(): ConversationCommentsState {
  return { comments: [], staged: [], revisions: dictionary(), sending: false, missing: [] }
}

function restore(raw: string | null): ConversationCommentsState {
  const state = emptyState()
  if (raw === null) return state
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return state }
  if (!object(parsed)) return state
  const seen = new Set<string>()
  state.comments = Array.isArray(parsed.comments) ? parsed.comments.filter((item): item is ConversationComment => {
    if (!isComment(item) || seen.has(item.id)) return false
    seen.add(item.id)
    return true
  }) : []
  if (object(parsed.revisions)) {
    for (const [id, value] of Object.entries(parsed.revisions)) if (revision(value)) state.revisions[id] = value
  }
  for (const comment of state.comments) state.revisions[comment.id] ??= 1
  if (Array.isArray(parsed.staged)) {
    const drafts = new Set<string>()
    state.staged = parsed.staged.flatMap((item): ConversationCommentSubmission[] => {
      if (!object(item) || !identity(item.draft) || drafts.has(item.draft) || !Array.isArray(item.ids) || !object(item.revisions)
        || typeof item.afterSeq !== 'number' || !Number.isSafeInteger(item.afterSeq) || item.afterSeq < -1
        || (item.match !== undefined && item.match !== 'exact' && item.match !== 'includes')) return []
      const revisions = dictionary<number>()
      const savedRevisions = item.revisions
      const ids = [...new Set(item.ids.filter((id): id is string => identity(id) && revision(savedRevisions[id])))]
      if (ids.length === 0) return []
      for (const id of ids) revisions[id] = savedRevisions[id] as number
      drafts.add(item.draft)
      return [{ draft: item.draft, ids, revisions, afterSeq: item.afterSeq, match: item.match ?? 'exact' }]
    })
  }
  return state
}

/** Shared by the message overlays and composer; each framework scope owns one session. */
export function createConversationCommentsStore(): EngineStoreHandle<ConversationCommentsState, ConversationCommentsActions> {
  const handle = defineStore<ConversationCommentsState, ConversationCommentsActions>({
    init: emptyState,
    actions: {
      save: (state, comment) => {
        if (!isComment(comment)) return
        const index = state.comments.findIndex(item => item.id === comment.id)
        if (index !== -1 && sameComment(state.comments[index]!, comment)) return
        const comments = [...state.comments]
        if (index === -1) comments.push(comment)
        else comments[index] = comment
        state.comments = comments
        state.revisions[comment.id] = (state.revisions[comment.id] ?? 0) + 1
      },
      remove: (state, ids) => {
        const removed = new Set(ids)
        if (!state.comments.some(comment => removed.has(comment.id))) return
        state.comments = state.comments.filter(comment => !removed.has(comment.id))
        state.missing = state.missing.filter(id => !removed.has(id))
      },
      clear: state => { state.comments = []; state.staged = []; state.revisions = dictionary(); state.missing = [] },
      setSending: (state, sending) => { state.sending = sending },
      setMissing: (state, ids) => {
        const next = [...new Set(ids)].filter(id => state.comments.some(comment => comment.id === id))
        if (state.missing.length !== next.length || state.missing.some((id, index) => next[index] !== id)) state.missing = next
      },
      stage: (state, draft, ids, afterSeq, match = 'exact') => {
        if (!identity(draft) || !Number.isSafeInteger(afterSeq) || afterSeq < -1 || (match !== 'exact' && match !== 'includes')) return
        const selected = new Set(ids)
        const saved = state.comments.filter(comment => selected.has(comment.id)).map(comment => comment.id)
        if (saved.length === 0) return
        const revisions = dictionary<number>()
        for (const id of saved) revisions[id] = state.revisions[id]!
        state.staged = [...state.staged.filter(item => item.draft !== draft), { draft, ids: saved, revisions, afterSeq, match }]
      },
      unstage: (state, draft) => {
        if (state.staged.some(item => item.draft === draft)) state.staged = state.staged.filter(item => item.draft !== draft)
      },
      confirmSubmitted: (state, text, seq) => {
        if (!Number.isSafeInteger(seq)) return
        const confirmed = state.staged.filter(item => (item.match === 'includes' ? text.includes(item.draft) : item.draft === text) && seq > item.afterSeq)
        if (confirmed.length === 0) return
        const remove = new Set(confirmed.flatMap(item => item.ids.filter(id => item.revisions[id] === state.revisions[id])))
        state.comments = state.comments.filter(comment => !remove.has(comment.id))
        state.missing = state.missing.filter(id => !remove.has(id))
        state.staged = state.staged.filter(item => !confirmed.includes(item))
        // Once no submission can reference a removed revision, discard its tombstone.
        for (const id of Object.keys(state.revisions)) {
          if (!state.comments.some(comment => comment.id === id) && !state.staged.some(item => item.ids.includes(id))) delete state.revisions[id]
        }
      },
    },
  })
  return {
    spec: handle.spec,
    create: scopeKey => {
      const instance = handle.create(scopeKey)
      const key = scopeKey === undefined ? STORAGE_KEY : `${STORAGE_KEY}.${scopeKey}`
      try { if (typeof localStorage !== 'undefined') instance.store.set(restore(localStorage.getItem(key))) } catch { /* Browser storage is optional. */ }
      instance.subscribe(() => {
        try {
          if (typeof localStorage === 'undefined') return
          const { comments, staged, revisions } = instance.getSnapshot()
          localStorage.setItem(key, JSON.stringify({ comments, staged, revisions }))
        } catch { /* A quota or private-mode error must preserve in-memory editing. */ }
      })
      return { ...instance, clearPersisted: () => {
        try { if (typeof localStorage !== 'undefined') localStorage.removeItem(key) } catch { /* Browser storage is optional. */ }
      } }
    },
  }
}

/** Format the selected source text with its request; the composer owns any surrounding draft. */
export function conversationCommentsPrompt(comments: readonly ConversationComment[], locale: 'zh' | 'en' = 'zh'): string {
  if (comments.length === 0) return ''
  const english = locale === 'en'
  return [english ? 'Please address the following comments on your conversation replies:' : '请根据以下会话批注修改或补充你的回复：', '',
    ...comments.flatMap((comment, index) => [
      `${index + 1}. ${english ? 'Quoted reply' : '引用原文'}：`,
      ...comment.quote.split('\n').map(line => `> ${line}`),
      `${english ? 'Requested change' : '修改意见'}：${comment.note.trim()}`, '',
    ]),
  ].join('\n').trimEnd()
}

/** Re-anchor only when the quote or surrounding context identifies one location. */
export function locateConversationComment(text: string, comment: ConversationTextAnchor): { start: number; end: number } | undefined {
  const contextMatches = (start: number): boolean => {
    const end = start + comment.quote.length
    return (comment.prefix === undefined || text.slice(Math.max(0, start - comment.prefix.length), start) === comment.prefix)
      && (comment.suffix === undefined || text.slice(end, end + comment.suffix.length) === comment.suffix)
  }
  if (text.slice(comment.start, comment.end) === comment.quote && contextMatches(comment.start)) return { start: comment.start, end: comment.end }
  if (comment.quote.length === 0) return undefined
  const candidates: number[] = []
  for (let offset = text.indexOf(comment.quote); offset !== -1; offset = text.indexOf(comment.quote, offset + 1)) candidates.push(offset)
  const matches = candidates.length === 1 ? candidates : candidates.filter(contextMatches)
  return matches.length === 1 ? { start: matches[0]!, end: matches[0]! + comment.quote.length } : undefined
}
