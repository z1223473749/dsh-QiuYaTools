/** One composer review surface, switching to revision when comments exist. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, extractMarkdownPlainText, IconEditOutlineRegular, IconTrashOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { PendingQuestion } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { PlanReviewSurfaceOwner } from './surface-contract.ts'
import { EMPTY_PLAN_COMMENTS, planCommentKey, type createPlanCommentsStore } from './plan-comments.ts'
import css from './PlanReviewSurface.module.css'

/** Session-owned link between the review carrier and its preview editor. */
export interface PlanReviewSurfaceInjected {
  /** Bind focus holding for this live review; the disposer removes only this binding. */
  bindReview: (planKey: string, pending: PendingQuestion) => () => void
  /** Last recorded event before the revision prompt is submitted. */
  submissionCursor: () => number
  /** Send only the revision prompt, preserving the user's draft and attachments. */
  sendRevision: (text: string) => Promise<void>
  /** Restore the Session input's focus after the review seat closes. */
  focusComposer: () => void
}

type SurfaceProps = PlanReviewSurfaceOwner & PropsRuntime<'conversation.composer'> & PropsLocale<'qiuyaPlan'>
  & PropsStore<ReturnType<typeof createPlanCommentsStore>> & InjectFace<PlanReviewSurfaceInjected>

/**
 * Render one card, retaining annotations until a revision is durably submitted.
 * @param props - Owner lifecycle, Session comment store, preview opener, and copy.
 * @returns the sole plan-review composer surface.
 */
export function PlanReviewSurface({ pending, review, requestKey, preview, card, busy, error, approve, dismiss, sessionId, t, useStore, actions, bindReview, submissionCursor, sendRevision, focusComposer }: SurfaceProps) {
  const planKey = planCommentKey(sessionId, review.callId === undefined ? requestKey : String(review.callId), review.plan)
  const comments = useStore(state => state.commentsByPlan[planKey] ?? EMPTY_PLAN_COMMENTS)
  const missing = useStore(state => state.missingByPlan[planKey])
  const staged = useStore(state => state.stagedByPlan[planKey])
  const sending = useStore(state => state.sendingByPlan[planKey] === true)
  const [sendError, setSendError] = useState<string | null>(null)
  const sendingRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const readOnly = pending.review !== undefined || card.closed || card.channel === 'none'
  const actionBusy = busy || sending
  const locked = readOnly || actionBusy
  const [selected, setSelected] = useState<readonly string[]>([])
  const selectedIds = selected.filter(id => comments.some(comment => comment.id === id))
  const selectedSet = new Set(selectedIds)
  useEffect(() => bindReview(planKey, pending), [bindReview, pending, planKey])
  useEffect(() => { actions.adopt(planKey) }, [actions, planKey])
  useEffect(() => {
    actions.setEditable(planKey, !locked)
    return () => { actions.setEditable(planKey, false) }
  }, [actions, locked, planKey])
  const summary = useMemo(() => {
    const title = extractMarkdownPlainText(review.plan, { mode: 'first-line' })
    const description = extractMarkdownPlainText(review.plan, { mode: 'first-paragraph' })
    return { title, description: description === title ? '' : description }
  }, [review.plan])
  const revision = comments.length > 0
  const revisionText = [t('review.prompt'), '', ...comments.flatMap((comment, index) => [
    `${index + 1}. “${comment.quote}”`,
    `   ${t('review.note', { note: comment.note })}`,
  ])].join('\n')
  const awaitingReceipt = staged?.draft === revisionText && comments.every(comment => staged.ids.includes(comment.id))
  const remove = (ids: readonly string[]): void => {
    if (locked) return
    actions.remove(planKey, ids)
    setSelected([])
  }
  const revise = async (): Promise<void> => {
    if (comments.length === 0 || locked || sendingRef.current) return
    sendingRef.current = true
    actions.setSending(planKey, true)
    setSendError(null)
    try {
      if (!awaitingReceipt) {
        actions.stage(planKey, revisionText, comments.map(comment => comment.id), submissionCursor())
        try { await sendRevision(revisionText) }
        catch (cause) {
          actions.unstage(planKey, revisionText)
          throw cause
        }
      }
      if (pending.snapshot().channel === 'waterfall') {
        await pending.answer({ answers: [{ id: review.id, selected: review.decline === undefined ? [] : [review.decline.label] }] })
      }
      await dismiss()
    } catch (cause) {
      if (mountedRef.current) setSendError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      sendingRef.current = false
      actions.setSending(planKey, false)
    }
  }
  const cancel = async (): Promise<void> => {
    if (locked || !await dismiss()) return
    actions.clear(planKey)
    focusComposer()
  }
  return (
    <div className={css.frame} data-plan-review-key={pending.key} data-plan-review-surface data-plan-review-variant={revision ? 'revision' : 'review'}>
      <section className={css.card} aria-label={review.question} aria-busy={actionBusy}>
        <div className={css.strip}>
          <StateDot state={actionBusy ? 'ongoing' : 'warning'} />
          <span>{revision ? t('review.header') : t('review.waiting')}</span>
          <div className={css.previewActions}>{preview}</div>
        </div>
        {!revision ? (
          <div className={css.summary}>
            <h3 className={css.title}>{summary.title}</h3>
            {summary.description !== '' && <p className={css.description}>{summary.description}</p>}
          </div>
        ) : (
          <div className={css.commentList}>
            {comments.map(comment => (
              <div key={comment.id} className={css.commentRow} data-plan-comment-item={comment.id}>
                {!readOnly && <input type="checkbox" aria-label={t('comment.select', { quote: comment.quote })} checked={selectedSet.has(comment.id)} disabled={actionBusy} onChange={event => {
                  setSelected(ids => event.target.checked ? [...ids, comment.id] : ids.filter(id => id !== comment.id))
                }} />}
                <span className={css.commentBody}><strong>“{comment.quote}”</strong><span>{comment.note}</span>{missing?.includes(comment.id) && <small className={css.changed}>{t('review.changed')}</small>}</span>
                {!readOnly && <button type="button" className={css.delete} aria-label={t('comment.delete')} disabled={actionBusy} onClick={() => { remove([comment.id]) }}>
                  <IconTrashOutlineRegular size={14} />
                </button>}
              </div>
            ))}
          </div>
        )}
        <div className={css.footer}>
          <div className={css.feedback} role="status">{sendError ?? error}</div>
          {revision && selectedIds.length > 0 && !readOnly && <Button size="sm" variant="ghost" disabled={actionBusy} onClick={() => { remove(selectedIds) }}>{t('comment.deleteSelected')}</Button>}
          {readOnly && <Button variant="outline" disabled={actionBusy} onClick={() => { void dismiss() }}>{t('review.close')}</Button>}
          {!readOnly && <div className={css.actions}>
            {!revision ? (
              <>
                <Button variant="outline" icon={<IconEditOutlineRegular size={14} />} disabled={actionBusy} onClick={() => { void cancel() }}>{t('review.discuss')}</Button>
                <Button variant="primary" disabled={actionBusy} onClick={approve}>{t('review.approve')}</Button>
              </>
            ) : (
              <>
                <Button variant="outline" disabled={actionBusy} onClick={() => { void cancel() }}>{t('review.cancel')}</Button>
                <Button variant="primary" disabled={actionBusy} onClick={() => { void revise() }}>{t('review.fix')}</Button>
              </>
            )}
          </div>}
        </div>
      </section>
    </div>
  )
}
