import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ConversationComments, type ConversationCommentsInjected } from './ConversationComments.tsx'
import { createConversationCommentsStore } from './comments.ts'
import { watchRevisionSubmissions } from '../plan-comments/revision-submissions.ts'
import { zh, en, type ConversationCommentKey } from './locales.ts'
import styles from './styles.css'
import { createNewConversationQuestion, type NewConversationQuestion } from './new-question.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { qiuyaConversationComments: ConversationCommentKey }
}

/** Public composer extension, with a fail-closed adapter for the shipped transcript DOM. */
export function installConversationComments(ctx: Context): () => void {
  const store = createConversationCommentsStore()
  const questions = new Map<SessionId, { binding: NonNullable<ReturnType<Context['sessions']['binding']>>; controller: NewConversationQuestion }>()
  const removeLocale = ctx.locale.register('qiuyaConversationComments', { zh, en })
  const style = document.createElement('style')
  style.dataset.qytConversationComments = ''; style.textContent = styles; document.head.append(style)
  const unregister = ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'qiuya-tools-conversation-comments', order: 80,
    locale: 'qiuyaConversationComments', store,
    inject: (sessionId: SessionId): ConversationCommentsInjected => {
      const binding = ctx.sessions.binding(sessionId)
      if (!binding) throw new Error('Conversation unavailable')
      return {
        watchSubmitted: confirm => watchRevisionSubmissions(binding.eventSource, confirm),
        submissionCursor: () => {
          const entries = binding.eventSource.getSnapshot().entries
          for (let i = entries.length - 1; i >= 0; i--) { const entry = entries[i]; if (entry?.type === 'event') return entry.event.seq }
          return -1
        },
        sendComments: async text => {
          if (ctx.sessions.binding(sessionId) !== binding) return '当前会话连接已变化，请重新打开批注。'
          const result = await binding.session.prompt([{ type: 'text', text }], 'queue')
          return result.ok ? null : result.error.message
        },
        openQuestion: quote => {
          let entry = questions.get(sessionId)
          if (entry?.binding !== binding) {
            entry?.controller.dispose()
            entry = { binding, controller: createNewConversationQuestion(ctx, binding, ctx.locale.getSnapshot().active.startsWith('zh') ? 'zh' : 'en') }
            questions.set(sessionId, entry)
          }
          return entry.controller.open(quote)
        },
      }
    },
  }, ConversationComments))
  return () => { unregister(); for (const entry of questions.values()) entry.controller.dispose(); questions.clear(); style.remove(); removeLocale() }
}
