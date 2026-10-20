import React, { useLayoutEffect, useRef } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { attachPromptSuggestion, type PromptSuggestionController, type PromptSuggestionState, type PromptSuggestionReply } from './client.ts'
import { PROMPT_SUGGESTIONS_CHANNEL, PROMPT_SUGGESTIONS_GENERATE_ENDPOINT, PROMPT_SUGGESTIONS_CANCEL_ENDPOINT } from './contract.ts'
import css from './styles.css'

interface RpcService {
  rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{ ok: true; value: unknown } | { ok: false }> }
}
interface NativeMenu { getSnapshot(): { open: boolean }; subscribe(listener: () => void): () => void }

/** The optional public trigger controller is authoritative even before its portal mounts. */
function nativeMenu(ctx: Context, sessionId: string): NativeMenu | undefined {
  try {
    const sessions = ctx.get('sessions') as { scope(id: string): unknown } | undefined
    const triggers = ctx.get('inputTriggers') as { sessionOf(scope: unknown): { menu: NativeMenu } } | undefined
    return sessions && triggers ? triggers.sessionOf(sessions.scope(sessionId)).menu : undefined
  } catch { return undefined }
}

/** Read the public Chat order only to invalidate decorations after history changes. */
export function promptConversationKey(views: unknown): string {
  if (!views || typeof (views as { get?: unknown }).get !== 'function') return ''
  const chat = (views as { get(key: string): { order?: readonly string[] } | undefined }).get('chat')
  const last = chat?.order?.at(-1)
  return typeof last === 'string' ? last : ''
}

function reply(value: unknown): PromptSuggestionReply {
  if (!value || typeof value !== 'object') throw new Error('suggestion-unavailable')
  const result = value as Record<string, unknown>
  if (result.suggestion !== null && typeof result.suggestion !== 'string'
    || result.anchorMessageId !== null && typeof result.anchorMessageId !== 'string') throw new Error('suggestion-unavailable')
  return { suggestion: result.suggestion as string | null, anchorMessageId: result.anchorMessageId as string | null }
}

/** Additive public slot bridge: no draft replacement, message submission or editor-private commands. */
export function installPromptSuggestions(ctx: Context): () => void {
  const service = (): RpcService | undefined => ctx.get('connection') as RpcService | undefined
  function PromptSuggestionBridge({ sessionId, useSession, useInput, useConversation, useProjection, inputActions }: PropsRuntime<'conversation.input.overlay'>) {
    const session = useSession(snapshot => snapshot)
    const input = useInput(snapshot => snapshot)
    const contextKey = useConversation(snapshot => promptConversationKey(snapshot.views))
    const modelKey = useProjection('modelSelection', value => value?.next ? JSON.stringify([value.next.provider, value.next.model]) : '')
    const anchor = useRef<HTMLSpanElement | null>(null)
    const controller = useRef<PromptSuggestionController | undefined>(undefined)
    const current = useRef({ inputActions, state: {} as PromptSuggestionState })
    current.current = {
      inputActions,
      state: {
        sessionId,
        contextKey: contextKey ? JSON.stringify([contextKey, modelKey]) : '',
        language: ctx.locale.getSnapshot().active.startsWith('zh') ? 'zh' : 'en',
        ready: session.openState === 'open' && !session.running && !session.blank && !session.removed
          && session.subagent === null && !session.awaitingFirstTurn && session.pendingSubmissions.length === 0
          && session.lastAgentError === null && session.promptError === null,
        draft: input.draft,
        draftRev: input.draftRev,
        phase: input.phase,
        attachmentCount: input.attachmentIds.length,
        occurrenceCount: input.occurrences.length,
      },
    }
    useLayoutEffect(() => {
      const card = anchor.current?.closest<HTMLElement>('[data-composer-card]')
      if (!card?.closest('[data-slot="main.conversation"]')) return
      const menu = nativeMenu(ctx, sessionId)
      const selection = ctx.uiSession.adapter.current
      const instance = attachPromptSuggestion(card, {
        anchor: anchor.current!,
        isCurrentSession: () => selection.getSnapshot().key === sessionId,
        read: () => current.current.state,
        captureInsertion: () => current.current.inputActions.captureInsertion(),
        insertText: (text, span) => current.current.inputActions.insertText(text, span),
        nativeMenuOpen: () => menu?.getSnapshot().open === true,
        request: async (payload, signal) => {
          const connection = service()
          if (!connection) throw new Error('suggestion-unavailable')
          const response = await connection.rpc.call(PROMPT_SUGGESTIONS_CHANNEL, PROMPT_SUGGESTIONS_GENERATE_ENDPOINT, payload, signal)
          if (!response.ok) throw new Error('suggestion-unavailable')
          return reply(response.value)
        },
        cancel: async requestId => {
          await service()?.rpc.call(PROMPT_SUGGESTIONS_CHANNEL, PROMPT_SUGGESTIONS_CANCEL_ENDPOINT, { requestId })
        },
      })
      controller.current = instance
      const stopMenu = menu?.subscribe(instance.sync)
      const stopSelection = selection.subscribe(instance.sync)
      return () => { stopSelection(); stopMenu?.(); instance.dispose(); if (controller.current === instance) controller.current = undefined }
    }, [sessionId])
    useLayoutEffect(() => { controller.current?.sync() })
    return <span ref={anchor} data-qyt-prompt-anchor="" hidden aria-hidden="true" />
  }
  const style = typeof document === 'undefined' ? undefined : document.createElement('style')
  if (style) { style.dataset.qytPromptSuggestions = ''; style.textContent = css; document.head.append(style) }
  const unregister = ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay', id: 'qiuya-tools-prompt-suggestions', order: 110,
  }, PromptSuggestionBridge))
  return () => { unregister(); style?.remove() }
}
