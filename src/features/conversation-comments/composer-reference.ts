import type { ReferenceInsert, TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Context } from '@deepseek-ai/cordis'

const PREFIX = 'qiuya-tools-comments.v1:'
export const conversationCommentSource = (_sessionId: SessionId): string => 'qiuya-tools-comments'

/** Immutable reference content survives draft persistence and failed-send restoration. */
export function conversationCommentReference(sessionId: SessionId, text: string, label: string): ReferenceInsert {
  return { source: conversationCommentSource(sessionId), ref: `${PREFIX}${JSON.stringify({ sessionId, text })}`,
    label, appearance: 'session', clipboardText: `\n\n${text}` }
}

function referenceValue(ref: string): { sessionId: SessionId; text: string } {
  if (!ref.startsWith(PREFIX)) throw new Error('Invalid conversation comment reference')
  const value: unknown = JSON.parse(ref.slice(PREFIX.length))
  if (typeof value !== 'object' || value === null || !('sessionId' in value) || typeof value.sessionId !== 'string' || !value.sessionId
    || !('text' in value) || typeof value.text !== 'string' || !value.text.trim()) throw new Error('Conversation comment reference belongs to another conversation')
  return { sessionId: value.sessionId as SessionId, text: value.text }
}

export function conversationCommentReferenceText(ref: string, sessionId: SessionId): string {
  const value = referenceValue(ref)
  if (value.sessionId !== sessionId) throw new Error('Conversation comment reference belongs to another conversation')
  return value.text
}

/** Only the public input-trigger source face is needed; no private editor access. */
export interface ConversationCommentReferenceSource {
  readonly trigger: '@'
  readonly name: string
  readonly showGroupTitle: false
  candidates(): Promise<readonly never[]>
  onPick(): undefined
  openReference(session: { readonly sessionId: SessionId }, reference: { readonly ref: string }): boolean
  readonly codec: { clipboardText(ref: string): string; serialize(ref: string, signal: AbortSignal): Promise<string> }
}
export interface ConversationCommentReferenceRegistry { registerSource(source: ConversationCommentReferenceSource): () => void }

export function createConversationCommentReferenceSource(current: (sessionId: SessionId) => boolean, open: (sessionId: SessionId) => boolean): ConversationCommentReferenceSource {
  return {
    trigger: '@', name: conversationCommentSource('' as SessionId), showGroupTitle: false,
    candidates: async () => [], onPick: () => undefined,
    openReference: (session, reference) => {
      if (!current(session.sessionId)) return false
      try { conversationCommentReferenceText(reference.ref, session.sessionId) } catch { return false }
      return open(session.sessionId)
    },
    codec: {
      clipboardText: ref => `\n\n${referenceValue(ref).text}`,
      serialize: async (ref, signal) => {
        signal.throwIfAborted()
        const value = referenceValue(ref)
        if (!current(value.sessionId)) throw new Error('The conversation changed. Reopen its comments before sending.')
        return `\n\n${value.text}`
      },
    },
  }
}

export interface ConversationCommentReferences {
  watchOpen(sessionId: SessionId, current: () => boolean, open: () => void): () => void
}

/** Keep persisted chips readable even while all feature UI is disabled. */
export function installConversationCommentReferences(ctx: Context): () => void {
  const registry = ctx.get('inputTriggers') as ConversationCommentReferenceRegistry
  const listeners = new Map<SessionId, Set<{ current: () => boolean; open: () => void }>>()
  const disposeSource = registry.registerSource(createConversationCommentReferenceSource(
    sessionId => ctx.sessions.binding(sessionId) !== undefined && ctx.uiSession.adapter.current.getSnapshot().key === sessionId,
    sessionId => {
      let opened = false
      for (const listener of listeners.get(sessionId) ?? []) if (listener.current()) { listener.open(); opened = true }
      return opened
    }))
  const disposeService = ctx.provide('qiuyaConversationCommentReferences', {
    watchOpen(sessionId: SessionId, current: () => boolean, open: () => void) {
      let group = listeners.get(sessionId)
      if (!group) { group = new Set(); listeners.set(sessionId, group) }
      const listener = { current, open }; group.add(listener)
      return () => { group.delete(listener); if (!group.size) listeners.delete(sessionId) }
    },
  } satisfies ConversationCommentReferences)
  return () => { disposeService(); disposeSource(); listeners.clear() }
}

/** Map a clipboard-projection range to the public editor's one-character chip coordinates. */
export function commentReferenceSpan(input: { readonly draft: string; readonly draftRev: number; readonly occurrences: readonly { readonly offset: number; readonly length: number }[] }, occurrence?: { readonly offset: number; readonly length: number }): TokenSpan {
  const offset = occurrence?.offset ?? input.draft.length
  const start = offset - input.occurrences.filter(item => item.offset < offset).reduce((total, item) => total + item.length - 1, 0)
  return { start, end: start + (occurrence ? 1 : 0), draftRev: input.draftRev }
}
