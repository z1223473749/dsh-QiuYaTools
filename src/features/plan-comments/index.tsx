/** Port of Desktop PR #1304 using additive composer routing and a shadowed plan preview. */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PendingQuestion, PlanReview } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { PropsLocale, PropsRuntime, PropsStore, InjectFace, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button, extractMarkdownPlainText } from '@deepseek-ai/dsh-client-ui-primitives'
import { PlanPreview, type PlanPreviewInjected } from './PlanPreview.tsx'
import { PlanReviewSurface, type PlanReviewSurfaceInjected } from './PlanReviewSurface.tsx'
import { PlanRevisionReceipt } from './PlanRevisionReceipt.tsx'
import { createPlanCommentsStore } from './plan-comments.ts'
import { watchRevisionSubmissions } from './revision-submissions.ts'
import { planAddress } from './plan.ts'
import { reviewPreviewAddress } from './review-preview.ts'
import { en, zh, type PlanKey } from './locales.ts'

declare const __QYT_BUNDLED_CSS__: string
const NS = 'qiuyaPlan'
const PLAN_PREVIEW_KEY = '@deepseek-ai/dsh-client-ui-plan'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    qiuyaPlan: PlanKey
  }
}

/** Narrow a plan review without importing another plugin's class identity. */
export function planReviewOf(pending: PendingQuestion): PlanReview | undefined {
  if (pending.kind !== 'plan-review' || pending.questions.length !== 1) return undefined
  const question = pending.questions[0]
  if (question.intent?.kind !== 'plan-review' || question.detail === undefined || question.multiSelect) return undefined
  const options = question.options ?? []
  if (options.length > 2) return undefined
  const approve = options.find(option => option.label === question.intent?.approve)
  if (approve === undefined) return undefined
  const decline = options.find(option => option.label !== approve.label)
  return { id: question.id, question: question.question, plan: question.detail, approve,
    ...(decline === undefined ? {} : { decline }),
    ...(question.intent.callId === undefined ? {} : { callId: question.intent.callId }),
  }
}

interface ReviewFace extends PlanReviewSurfaceInjected {
  openReview: (review: PlanReview, requestKey: string) => void
  openReviewOnce: (review: PlanReview, requestKey: string) => void
  readonly hooks: { sidebarMounted: HostObservable<SessionId | undefined> }
}
type ComposerProps = PropsRuntime<'conversation.composer'> & PropsLocale<typeof NS>
  & PropsStore<ReturnType<typeof createPlanCommentsStore>> & InjectFace<ReviewFace>
  & { matched: { pending: PendingQuestion; review: PlanReview } }

export function PlanReviewComposer(props: ComposerProps) {
  // The chain keys its elected entry, not the request matched by its selector.
  return <PlanReviewComposerRequest key={props.matched.pending.key} {...props} />
}

function PlanReviewComposerRequest(props: ComposerProps) {
  const { matched: { pending, review }, t } = props
  const card = useSyncExternalStore(pending.subscribe, pending.snapshot, pending.snapshot)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [answeredRemotely, setAnsweredRemotely] = useState(false)
  const answeredRemotelyRef = useRef(false)
  const busyRef = useRef(false)
  const sentVia = useRef<'waterfall' | null>(null)
  const mounted = props.useSidebarMounted(session => session !== undefined)
  useEffect(() => {
    if (mounted) props.openReviewOnce(review, pending.key)
  }, [mounted, props.openReviewOnce, review, pending.key])
  useEffect(() => {
    if (sentVia.current !== 'waterfall' || card.state !== 'continued') return
    sentVia.current = null
    busyRef.current = false
    setBusy(false)
    setError(t('review.resubmit'))
  }, [card.state, t])
  const settle = async (send: () => Promise<void>, remote = false): Promise<boolean> => {
    if (busyRef.current) return false
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await send()
      if (remote) {
        // Admission and hiding are separate: retrying a failed hide must not
        // send an already accepted structured answer a second time.
        answeredRemotelyRef.current = true
        setAnsweredRemotely(true)
        await pending.dismiss()
      }
      if (remote) { busyRef.current = false; setBusy(false) }
      return true
    } catch (cause) {
      sentVia.current = null
      busyRef.current = false
      setBusy(false)
      setError(answeredRemotelyRef.current ? t('review.sent') : cause instanceof Error ? cause.message : String(cause))
      return false
    }
  }
  return <PlanReviewSurface {...props} pending={pending} review={review} requestKey={pending.key}
    preview={<Button variant="ghost" size="sm" onClick={() => props.openReview(review, pending.key)}>{t('preview.full')}</Button>}
    card={answeredRemotely ? { ...card, channel: 'none' } : card} busy={busy} error={error}
    approve={() => {
      if (card.closed || card.channel === 'none' || answeredRemotelyRef.current) return
      sentVia.current = card.channel === 'waterfall' ? 'waterfall' : null
      void settle(() => pending.answer({ answers: [{ id: review.id, selected: [review.approve.label] }] }), card.channel === 'rpc')
    }}
    dismiss={() => settle(() => pending.dismiss())} />
}

export function installPlanComments(ctx: Context): () => void {
  const disposers: Array<() => void | Promise<void>> = []
  disposers.push(ctx.effect(() => ctx.locale.register(NS, { zh, en })))
  disposers.push(ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'qiuya-tools-plan-comments'
    style.textContent = __QYT_BUNDLED_CSS__
    document.head.append(style)
    return () => style.remove()
  }))
  const store = createPlanCommentsStore()
  const focus = new Map<string, { pending: PendingQuestion; held: boolean }>()
  const openedReviews = new Set<string>()
  const previewFocus: PlanPreviewInjected = {
    holdReviewFocus: key => { const entry = focus.get(key); if (entry === undefined || entry.held) return; entry.held = true; entry.pending.holdFocus() },
    releaseReviewFocus: key => { const entry = focus.get(key); if (entry?.held !== true) return; entry.held = false; entry.pending.releaseFocus() },
  }
  disposers.push(ctx.effect(() => () => {
    for (const entry of focus.values()) if (entry.held) entry.pending.releaseFocus()
    focus.clear()
    openedReviews.clear()
  }))
  const inject = (sessionId: SessionId): ReviewFace => {
    const openReview = (review: PlanReview, requestKey: string): void => {
      const child = ctx.sessions.subagentAddress(sessionId)
      const session = child === undefined ? { kind: 'session' as const, sessionId } : { kind: 'subagent' as const, ...child }
      if (review.callId !== undefined) { ctx.sidebarRight.openResource(planAddress({ session, callId: review.callId })); return }
      ctx.sidebarRight.openResource(reviewPreviewAddress(sessionId, requestKey), {
        params: { planReview: { markdown: review.plan, title: extractMarkdownPlainText(review.plan, { mode: 'first-line' }) }, planCommentRequestKey: requestKey },
      })
    }
    return {
      ...previewFocus,
      hooks: { sidebarMounted: ctx.sidebarRight.mounted },
      openReview,
      openReviewOnce: (review, requestKey) => {
        const identity = JSON.stringify([sessionId, review.callId === undefined ? 'review' : 'call', review.callId ?? requestKey])
        if (openedReviews.has(identity)) return
        openReview(review, requestKey)
        openedReviews.add(identity)
      },
      submissionCursor: () => {
        const entries = ctx.sessions.binding(sessionId)?.eventSource.getSnapshot().entries ?? []
        for (let index = entries.length - 1; index >= 0; index--) {
          const entry = entries[index]
          if (entry?.type === 'event') return entry.event.seq
        }
        return -1
      },
      sendRevision: async text => {
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined) throw new Error('QiuYaTools: this session is no longer available')
        const result = await binding.session.prompt([{ type: 'text', text }], 'steer')
        if (!result.ok) throw new Error(result.error.message)
      },
      focusComposer: () => {
        requestAnimationFrame(() => {
          if (ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return
          const binding = ctx.sessions.binding(sessionId)
          if (binding !== undefined) binding.ctx.get('conversation')?.input.for(binding.ctx).focus()
        })
      },
      bindReview: (key, pending) => {
        const entry = { pending, held: false }
        focus.set(key, entry)
        return () => { if (focus.get(key) !== entry) return; if (entry.held) entry.pending.releaseFocus(); focus.delete(key) }
      },
    }
  }
  disposers.push(ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer', priority: -50, locale: NS, store, inject,
    select: ({ pendingInteraction }) => {
      if (pendingInteraction?.kind !== 'plan-review') return null
      const review = planReviewOf(pendingInteraction)
      return review === undefined ? null : { pending: pendingInteraction, review }
    },
  }, PlanReviewComposer)))
  disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: PLAN_PREVIEW_KEY, priority: -50, locale: NS, store,
    inject: () => previewFocus,
  }, PlanPreview)))
  disposers.push(ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay', id: 'qiuya-plan-receipts', store,
    inject: (sessionId: SessionId) => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) throw new Error('QiuYaTools: this session is no longer available')
      return { watchSubmitted: (confirmed: (text: string, seq: number) => void) => watchRevisionSubmissions(binding.eventSource, confirmed) }
    },
  }, PlanRevisionReceipt)))
  return () => { for (const dispose of disposers.splice(0).reverse()) void dispose() }
}
