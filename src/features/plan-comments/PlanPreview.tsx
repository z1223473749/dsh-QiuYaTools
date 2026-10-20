/** Markdown plan viewer with client-owned selection comments. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button, FileTypeIcon, IconCloseOutlineRegular, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './resource-contract.ts'
import { isReviewPreviewAddress } from './review-preview.ts'
import { planFailureLine } from './failure-line.ts'
import { parsePlanAddress } from './plan.ts'
import { EMPTY_PLAN_COMMENTS, locatePlanComment, planCommentKey, type createPlanCommentsStore } from './plan-comments.ts'
import { planHighlightRanges, renderedPlanText, selectionPlanAnchor, type PlanTextAnchor } from './comment-dom.ts'
import css from './PlanPreview.module.css'

type PlanPreviewProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'qiuyaPlan'>
  & PropsStore<ReturnType<typeof createPlanCommentsStore>>
  & InjectFace<PlanPreviewInjected>

/** Callbacks to the live review that owns the preview's comments. */
export interface PlanPreviewInjected {
  /** Hold its existing countdown while a comment editor is open. */
  holdReviewFocus: (planKey: string) => void
  /** Release that hold after the editor closes or unmounts. */
  releaseReviewFocus: (planKey: string) => void
}

interface EditorState extends PlanTextAnchor {
  readonly id?: string
  readonly left: number
  readonly top: number
}

interface HighlightRect {
  readonly id: string
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

function randomCommentId(): string {
  return crypto.randomUUID()
}

/**
 * Render complete Markdown and floating comments for the current live review.
 * @param props - Framework-bound tab identity, resource, comment store, and copy.
 * @returns the plan document or a localized loading/failure state.
 */
export function PlanPreview({ useTabInfo, useResource, t, sessionId, useStore, actions, holdReviewFocus, releaseReviewFocus }: PlanPreviewProps) {
  const tab = useTabInfo()
  const resource = useResource<'plan'>(tab.tab.navigation.address)
  const temporary = isReviewPreviewAddress(tab.tab.navigation.address)
  const params = tab.tab.navigation.params
  const target = temporary ? undefined : parsePlanAddress(tab.tab.navigation.address)
  const plan = temporary ? (params !== undefined && 'planReview' in params ? params.planReview : undefined) : resource.value
  const requestKey = temporary
    ? (params !== undefined && 'planCommentRequestKey' in params && typeof params.planCommentRequestKey === 'string' ? params.planCommentRequestKey : undefined)
    : (plan !== undefined && 'callId' in plan && typeof plan.callId === 'string' ? plan.callId : undefined)
  const commentSessionId = target?.session.kind === 'subagent' ? target.session.childSessionId : target?.session.sessionId ?? sessionId
  const planKey = plan === undefined || commentSessionId === undefined || requestKey === undefined ? undefined : planCommentKey(commentSessionId, requestKey, plan.markdown)
  const comments = useStore(state => planKey === undefined ? EMPTY_PLAN_COMMENTS : state.commentsByPlan[planKey] ?? EMPTY_PLAN_COMMENTS)
  const editable = useStore(state => planKey !== undefined && state.editableByPlan[planKey] === true
    && (temporary || target?.session.kind === 'session' && target.session.sessionId === sessionId))
  const documentRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const [editor, setEditor] = useState<EditorState | undefined>()
  const [note, setNote] = useState('')
  const [rects, setRects] = useState<readonly HighlightRect[]>([])
  const [hovered, setHovered] = useState<string | undefined>()
  const closeEditor = useCallback(() => { composing.current = false; setEditor(undefined); setNote('') }, [])
  const editing = editor !== undefined && editable

  useEffect(() => {
    if (planKey !== undefined) actions.adopt(planKey)
    closeEditor()
    setHovered(undefined)
  }, [actions, closeEditor, planKey, editable])
  useEffect(() => {
    if (!editing || planKey === undefined) return
    holdReviewFocus(planKey)
    return () => { releaseReviewFocus(planKey) }
  }, [editing, planKey, holdReviewFocus, releaseReviewFocus])
  useEffect(() => {
    if (!editing) return
    const dismissOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !editorRef.current?.contains(event.target)) closeEditor()
    }
    const dismissEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.isComposing && !composing.current) { event.preventDefault(); closeEditor() }
    }
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('keydown', dismissEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('keydown', dismissEscape)
    }
  }, [editing, closeEditor])
  useLayoutEffect(() => {
    const root = documentRef.current
    if (root === null) return
    const measure = (): void => {
      const origin = root.getBoundingClientRect()
      const text = renderedPlanText(root)
      const next: HighlightRect[] = []
      const missing: string[] = []
      for (const comment of comments) {
        const anchor = locatePlanComment(text, comment)
        const ranges = anchor === undefined ? [] : planHighlightRanges(root, anchor.start, anchor.end)
        if (ranges.length === 0) { missing.push(comment.id); continue }
        for (const range of ranges) {
          for (const rect of range.getClientRects()) {
            if (rect.width > 0 && rect.height > 0) next.push({ id: comment.id, left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height })
          }
        }
      }
      setRects(next)
      if (planKey !== undefined) actions.setMissing(planKey, missing)
    }
    measure()
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    resize?.observe(root)
    window.addEventListener('resize', measure)
    return () => { resize?.disconnect(); window.removeEventListener('resize', measure) }
  }, [actions, comments, planKey, plan?.markdown, t])
  useLayoutEffect(() => {
    if (!editing || editor === undefined) return
    const root = documentRef.current
    const dialog = editorRef.current
    const viewport = root?.parentElement?.parentElement
    if (root === null || dialog === null || viewport === undefined || viewport === null) return
    const origin = root.getBoundingClientRect()
    const bounds = viewport.getBoundingClientRect()
    const height = dialog.getBoundingClientRect().height
    const top = Math.max(0, Math.min(editor.top, bounds.bottom - origin.top - height - 8))
    if (height > 0 && top !== editor.top) setEditor({ ...editor, top })
  }, [editing, editor])

  const openEditor = useCallback((next: PlanTextAnchor & { id?: string }, rect: { left: number; bottom: number }): void => {
    if (!editable || planKey === undefined) return
    const root = documentRef.current
    if (root === null) return
    const origin = root.getBoundingClientRect()
    const width = Math.min(360, root.clientWidth || 360)
    const left = Math.max(0, Math.min(rect.left - origin.left, (root.clientWidth || width) - width))
    setEditor({ ...next, left, top: Math.max(0, rect.bottom - origin.top + 8) })
    setHovered(undefined)
    setNote(next.id === undefined ? '' : comments.find(item => item.id === next.id)?.note ?? '')
  }, [comments, editable, planKey])
  const onSelection = useCallback(() => {
    if (!editable) return
    const root = documentRef.current
    const selection = window.getSelection()
    if (root === null || selection === null || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    const anchor = selectionPlanAnchor(root, range)
    if (anchor !== undefined) openEditor(anchor, range.getBoundingClientRect())
  }, [editable, openEditor])
  const submitComment = useCallback(() => {
    if (!editable || planKey === undefined || editor === undefined || note.trim() === '') return
    actions.save({ id: editor.id ?? randomCommentId(), planKey, quote: editor.quote, note: note.trim(), start: editor.start, end: editor.end, ...(editor.prefix === undefined ? {} : { prefix: editor.prefix }), ...(editor.suffix === undefined ? {} : { suffix: editor.suffix }) })
    window.getSelection()?.removeAllRanges()
    closeEditor()
  }, [actions, closeEditor, editable, editor, note, planKey])
  const deleteComment = useCallback(() => {
    if (!editable || planKey === undefined || editor?.id === undefined) return
    actions.remove(planKey, [editor.id])
    closeEditor()
  }, [actions, closeEditor, editable, editor?.id, planKey])
  const labels = useMemo(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied'), toolbarLabels: { codeLabel: t('codeBlock.title'), wrapLabel: t('codeBlock.wrap'), unwrapLabel: t('codeBlock.unwrap') } },
    footnotes: t('markdown.footnotes'),
  }), [t])
  if (plan === undefined) return (
    <div className={css.message} role="status">
      {temporary ? t('preview.expired') : resource.status === 'none' ? t('preview.unavailable')
        : resource.status === 'failed' ? t('preview.failed') : t('preview.loading')}
      {!temporary && resource.failure !== undefined && <p>{planFailureLine(t, resource.failure)}</p>}
    </div>
  )
  const hoverRect = rects.find(rect => rect.id === hovered)
  const hoverComment = comments.find(comment => comment.id === hovered)
  return (
    <section className={css.preview} data-plan-preview={'callId' in plan ? plan.callId : tab.tab.navigation.address} aria-label={plan.title}>
      <div className={css.documentFrame}>
        <div ref={documentRef} className={css.document} onMouseUp={onSelection} onKeyUp={onSelection}>
          <MarkdownText text={plan.markdown} labels={labels} />
        </div>
        {rects.map((rect, index) => (
          <button key={`${rect.id}:${index}`} type="button" className={css.commentMark} data-plan-comment-mark={rect.id}
            tabIndex={rects.findIndex(item => item.id === rect.id) === index ? 0 : -1}
            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} aria-label={comments.find(comment => comment.id === rect.id)?.note}
            aria-disabled={!editable} onMouseEnter={() => { setHovered(rect.id) }} onMouseLeave={() => { setHovered(undefined) }}
            onFocus={() => { setHovered(rect.id) }} onBlur={() => { setHovered(undefined) }}
            onClick={event => {
              const comment = comments.find(item => item.id === rect.id)
              if (comment !== undefined) openEditor(comment, event.currentTarget.getBoundingClientRect())
            }} />
        ))}
        {!editing && hoverRect !== undefined && hoverComment !== undefined && <div role="tooltip" className={css.commentTooltip} style={{ left: Math.max(0, Math.min(hoverRect.left, (documentRef.current?.clientWidth || 340) - 340)), top: hoverRect.top + hoverRect.height + 6 }}>{hoverComment.note}</div>}
        {editing && editor !== undefined && (
          <div ref={editorRef} className={css.commentEditor} style={{ left: editor.left, top: editor.top }} role="dialog" aria-label={t('comment.editor')}>
            <textarea autoFocus rows={3} value={note} aria-label={t('comment.editor')} placeholder={t('comment.placeholder')}
              onChange={event => { setNote(event.target.value) }} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
              onKeyDown={event => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && !composing.current) { event.preventDefault(); submitComment() }
              }} />
            <div className={css.commentEditorActions}>
              {editor.id !== undefined && <Button size="sm" variant="ghost" onClick={deleteComment}>{t('comment.delete')}</Button>}
              <Button size="sm" variant="ghost" onClick={closeEditor}>{t('comment.cancel')}</Button>
              <Button size="sm" variant="primary" disabled={note.trim() === ''} onClick={submitComment}>{t('comment.save')}</Button>
            </div>
            <button type="button" className={css.commentEditorClose} aria-label={t('comment.close')} onClick={closeEditor}><IconCloseOutlineRegular size={14} /></button>
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * Display a plain file icon and the heading in its tab after resource recovery.
 * @param props - Framework-bound tab identity and resource reader.
 * @returns a decorative file icon followed by the recovered title or initial localized label.
 */
export function PlanTitle({ useTabInfo, useResource }: PropsRuntime<'sidebar.right.pane.tab.title'>) {
  const tab = useTabInfo()
  const resource = useResource<'plan'>(tab.tab.navigation.address)
  const params = tab.tab.navigation.params
  const plan = isReviewPreviewAddress(tab.tab.navigation.address)
    ? (params !== undefined && 'planReview' in params ? params.planReview : undefined) : resource.value
  return <><FileTypeIcon kind="other" size={16} className={css.titleIcon} />{plan?.title ?? tab.tab.title}</>
}
