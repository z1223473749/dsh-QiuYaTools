/** Additive composer bridge and text-only overlays for finalized assistant replies. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { createConversationCommentsStore, conversationCommentsPrompt, locateConversationComment, type ConversationComment, type ConversationTextAnchor } from './comments.ts'
import { discoverConversationMessages, renderedConversationText, selectionConversationAnchor, conversationHighlightRanges, type ConversationMessageContent } from './dom.ts'

export interface ConversationCommentsInjected {
  watchSubmitted: (confirm: (text: string, seq: number) => void) => () => void
  submissionCursor: () => number
  /** null means admitted; a returned string is a definite refusal; throws are unconfirmed. */
  sendComments: (text: string) => Promise<string | null>
  /** Open a fresh conversation with the selected quote staged as an unsent draft. */
  openQuestion: (quote: string) => Promise<void>
}
export type ConversationCommentsProps = PropsRuntime<'conversation.input.dock'> & PropsStore<ReturnType<typeof createConversationCommentsStore>>
  & PropsLocale<'qiuyaConversationComments'> & InjectFace<ConversationCommentsInjected>
interface Positioned { left: number; top: number }
interface SelectionDraft extends ConversationTextAnchor, Positioned { messageId: string; contentId: string; id?: string }
interface Highlight { id: string; number: number; note: string; left: number; top: number; width: number; height: number; last: boolean }

/** Keep numbers individually clickable when notes share a passage or line end. */
function numberedPositions(rects: readonly Highlight[], width: number): readonly (Highlight & Positioned)[] {
  const placed: Array<Highlight & Positioned> = []
  for (const rect of rects.filter(item => item.last)) {
    let left = Math.max(0, Math.min(rect.left + rect.width - 8, width - 24)), top = rect.top - 10
    while (placed.some(item => Math.abs(item.top - top) < 24 && Math.abs(item.left - left) < 24)) {
      if (left >= 26) left -= 26
      else { left = Math.max(0, Math.min(rect.left + rect.width - 8, width - 24)); top -= 26 }
    }
    placed.push({ ...rect, left, top })
  }
  return placed
}

function position(rect: Pick<DOMRect, 'left' | 'bottom'>, width = 360): Positioned {
  return { left: Math.max(12, Math.min(rect.left, window.innerWidth - Math.min(width, window.innerWidth - 24) - 12)),
    top: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 240)) }
}

function MessageComments({ surface, comments, onEdit, t }: {
  surface: ConversationMessageContent; comments: readonly (ConversationComment & { number: number })[]
  onEdit: (comment: ConversationComment, rect: DOMRect) => void
  t: ConversationCommentsProps['t']
}) {
  const [rects, setRects] = useState<readonly Highlight[]>([])
  const [hovered, setHovered] = useState<string>()
  useLayoutEffect(() => {
    const root = surface.root
    root.setAttribute('data-qyt-cc-root', '')
    let frame = 0
    const measure = (): void => {
      const origin = root.getBoundingClientRect(), text = renderedConversationText(root)
      const next: Highlight[] = []
      for (const comment of comments) {
        const anchor = locateConversationComment(text, comment)
        const boxes = anchor === undefined ? [] : conversationHighlightRanges(root, anchor.start, anchor.end)
          .flatMap(range => Array.from(range.getClientRects())).filter(rect => rect.width > 0 && rect.height > 0)
        boxes.forEach((rect, index) => next.push({ id: comment.id, number: comment.number, note: comment.note,
          left: rect.left - origin.left + root.scrollLeft, top: rect.top - origin.top + root.scrollTop,
          width: rect.width, height: rect.height, last: index === boxes.length - 1 }))
      }
      setRects(next)
    }
    const schedule = (): void => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure) }
    measure()
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    resize?.observe(root)
    window.addEventListener('resize', schedule)
    root.addEventListener('scroll', schedule, true)
    root.addEventListener('load', schedule, true)
    // Font loading can reflow text without changing the Markdown source.
    document.fonts?.addEventListener('loadingdone', schedule)
    return () => { cancelAnimationFrame(frame); resize?.disconnect(); window.removeEventListener('resize', schedule)
      root.removeEventListener('scroll', schedule, true); root.removeEventListener('load', schedule, true)
      document.fonts?.removeEventListener('loadingdone', schedule); root.removeAttribute('data-qyt-cc-root') }
  }, [surface.root, comments])
  const numbers = numberedPositions(rects, surface.root.clientWidth)
  return createPortal(<div className="qyt-cc-layer" data-qyt-cc-layer>
    {rects.map((rect, index) => <span key={`${rect.id}:${index}`} className="qyt-cc-highlight" aria-hidden="true" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />)}
    {numbers.map(rect => <button key={rect.id} type="button" className="qyt-cc-number"
      style={{ left: rect.left, top: rect.top }}
      aria-label={t('marker', { number: rect.number, note: rect.note })} data-qyt-cc-number={rect.id}
      onMouseEnter={() => setHovered(rect.id)} onMouseLeave={() => setHovered(undefined)} onFocus={() => setHovered(rect.id)} onBlur={() => setHovered(undefined)}
      onClick={event => { const comment = comments.find(item => item.id === rect.id); if (comment) onEdit(comment, event.currentTarget.getBoundingClientRect()) }}>
      {rect.number}
    </button>)}
    {rects.filter(rect => rect.last && rect.id === hovered).map(rect => <span key={rect.id} className="qyt-cc-tooltip" role="tooltip" aria-hidden="true"
      style={{ left: Math.max(0, Math.min(rect.left, surface.root.clientWidth - Math.min(320, surface.root.clientWidth))), top: rect.top + rect.height + 8 }}>{rect.note}</span>)}
  </div>, surface.root)
}

export function ConversationComments({ sessionId, useChat, useSession, useInput, inputActions, useStore, actions, t,
  watchSubmitted, submissionCursor, sendComments, openQuestion }: ConversationCommentsProps) {
  const snapshot = useChat(value => value)
  const session = useSession(value => value)
  const input = useInput(value => value)
  const state = useStore(value => value)
  const anchor = useRef<HTMLDivElement>(null)
  const floating = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const sending = useRef(false)
  const asking = useRef(false)
  const [surfaces, setSurfaces] = useState<readonly ConversationMessageContent[]>([])
  const [selection, setSelection] = useState<SelectionDraft>()
  const [editor, setEditor] = useState<SelectionDraft>()
  const [note, setNote] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState('')
  const [questionBusy, setQuestionBusy] = useState(false)
  const [questionError, setQuestionError] = useState('')
  const english = t('add') === 'Add comment'
  const pending = state.staged.some(item => item.match !== 'includes')
  const insertedBatches = state.staged.filter(item => item.match === 'includes' && input.draft.includes(item.draft.split('\n')[0]!))
  const inserted = insertedBatches.length > 0
  const frozenIds = new Set(state.staged.filter(item => item.match !== 'includes' || insertedBatches.includes(item)).flatMap(item => item.ids))
  const locked = session.openState !== 'open' || session.removed || session.subagent !== null || input.phase !== 'plain' || state.sending || pending || inserted
  const close = useCallback(() => { setSelection(undefined); setEditor(undefined); setNote(''); setQuestionError(''); composing.current = false }, [])
  useEffect(() => watchSubmitted(actions.confirmSubmitted), [watchSubmitted, actions])
  useEffect(() => { close(); setExpanded(false); setStatus('') }, [sessionId, close])
  useLayoutEffect(() => {
    const container = anchor.current?.closest<HTMLElement>('[data-slot="main.conversation"]')
    if (!container) { setSurfaces([]); return }
    const refresh = (): void => {
      const next = discoverConversationMessages(container, snapshot)
      setSurfaces(previous => previous.length === next.length && previous.every((item, i) => item.root === next[i]?.root
        && item.messageId === next[i]?.messageId && item.contentId === next[i]?.contentId) ? previous : next)
    }
    refresh()
    const observer = new MutationObserver(refresh)
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'data-streaming', 'data-chat-node-key', 'data-chat-group-part', 'data-turn-process-inline'] })
    return () => observer.disconnect()
  }, [sessionId, snapshot])
  useEffect(() => {
    if (session.subagent !== null || session.removed) { close(); return }
    const select = (): void => {
      if (editor) return
      const selected = window.getSelection()
      if (!selected || selected.rangeCount === 0 || selected.isCollapsed) { setSelection(undefined); return }
      const range = selected.getRangeAt(0)
      for (const surface of surfaces) {
        const found = selectionConversationAnchor(surface.root, range)
        if (found) { setQuestionError(''); setSelection({ ...found, messageId: surface.messageId, contentId: surface.contentId, ...position(range.getBoundingClientRect(), 240) }); return }
      }
      setSelection(undefined)
    }
    const keyboard = (event: KeyboardEvent): void => { if (event.key === 'Shift' || event.key.startsWith('Arrow')) select() }
    for (const surface of surfaces) { surface.root.addEventListener('pointerup', select); surface.root.addEventListener('keyup', keyboard) }
    return () => { for (const surface of surfaces) { surface.root.removeEventListener('pointerup', select); surface.root.removeEventListener('keyup', keyboard) } }
  }, [surfaces, editor, session.subagent, session.removed, close])
  useEffect(() => {
    if (!selection && !editor) return
    const outside = (event: PointerEvent): void => { if (event.target instanceof Node && !floating.current?.contains(event.target)) close() }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !event.isComposing && !composing.current) { event.preventDefault(); close() } }
    const scroll = (event: Event): void => { if (selection && !(event.target instanceof Node && floating.current?.contains(event.target))) setSelection(undefined) }
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape); window.addEventListener('scroll', scroll, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); window.removeEventListener('scroll', scroll, true) }
  }, [selection, editor, close])
  useLayoutEffect(() => {
    if (!editor || !floating.current) return
    const bounds = floating.current.getBoundingClientRect()
    if (bounds.bottom > window.innerHeight - 12) setEditor({ ...editor, top: Math.max(12, window.innerHeight - bounds.height - 12) })
  }, [editor])
  const edit = (comment: ConversationComment, rect: DOMRect): void => { if (frozenIds.has(comment.id)) return; setSelection(undefined); setEditor({ ...comment, ...position(rect) }); setNote(comment.note) }
  const save = (): void => {
    if (!editor || !note.trim()) return
    const { left: _left, top: _top, ...comment } = editor
    actions.save({ ...comment, id: editor.id ?? crypto.randomUUID(), note: note.trim() })
    window.getSelection()?.removeAllRanges(); close(); setStatus('')
  }
  const batch = (): string => `${t('receipt')}：${crypto.randomUUID()}\n${conversationCommentsPrompt(state.comments, english ? 'en' : 'zh')}`
  const ask = async (): Promise<void> => {
    if (!selection || asking.current) return
    asking.current = true; setQuestionBusy(true); setQuestionError('')
    try { await openQuestion(selection.quote); close() }
    catch (error) { setQuestionError(error instanceof Error ? error.message : t('questionFailed')) }
    finally { asking.current = false; setQuestionBusy(false) }
  }
  const insert = (): void => {
    if (locked || !state.comments.length) return
    const text = batch(), cursor = submissionCursor()
    const addition = `${input.draft ? '\n\n' : ''}${text}`
    actions.stage(text, state.comments.map(item => item.id), cursor, 'includes')
    // The editor's detect projection counts each reference chip as one character.
    // The public draft expands it to clipboardText, so its length is not a caret offset.
    const end = input.draft.length - input.occurrences.reduce((count, item) => count + item.length - 1, 0)
    if (!inputActions.insertText(addition, { start: end, end, draftRev: input.draftRev })) {
      actions.unstage(text); setStatus(t('changed')); return
    }
    inputActions.persistDraft(); setStatus(t('inserted')); setExpanded(false)
  }
  const submit = async (): Promise<void> => {
    if (locked || !state.comments.length || sending.current) return
    const text = batch()
    sending.current = true; actions.setSending(true); setStatus('')
    actions.stage(text, state.comments.map(item => item.id), submissionCursor())
    try {
      const error = await sendComments(text)
      if (error !== null) { actions.unstage(text); setStatus(error) }
      else setStatus(t('pending'))
    } catch { setStatus(t('pending')) }
    finally { sending.current = false; actions.setSending(false) }
  }
  return <div ref={anchor} className="qyt-cc-dock" data-qyt-conversation-comments={sessionId}>
    {surfaces.map(surface => <MessageComments key={`${surface.messageId}:${surface.contentId}`} surface={surface} t={t} onEdit={edit}
      comments={state.comments.flatMap((comment, i) => comment.messageId === surface.messageId && comment.contentId === surface.contentId ? [{ ...comment, number: i + 1 }] : [])} />)}
    {state.comments.length > 0 && <>
      <button type="button" className="qyt-cc-chip" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>▤ {t('count', { count: state.comments.length })}</button>
      {expanded && <section className="qyt-cc-panel" aria-label={t('title')}>
        <header><h4>{t('title')}</h4><button type="button" className="qyt-cc-icon" aria-label={t('close')} onClick={() => setExpanded(false)}>×</button></header>
        <ol className="qyt-cc-list">{state.comments.map((comment, i) => <li key={comment.id} className="qyt-cc-item" data-qyt-cc-item={comment.id}>
          <span>{i + 1}.</span><div className="qyt-cc-item-body"><blockquote>{comment.quote}</blockquote><p>{comment.note}</p></div>
          <button type="button" className="qyt-cc-icon" aria-label={t('edit')} disabled={frozenIds.has(comment.id)} onClick={event => edit(comment, event.currentTarget.getBoundingClientRect())}>✎</button>
          <button type="button" className="qyt-cc-icon" aria-label={t('remove')} disabled={frozenIds.has(comment.id)} onClick={() => actions.remove([comment.id])}>×</button>
        </li>)}</ol>
        <p className="qyt-cc-hint">{t('hint')}</p>
        <div className="qyt-cc-actions"><button type="button" className="qyt-cc-action" disabled={locked} onClick={insert}>{t('insert')}</button>
          <button type="button" className="qyt-cc-action" data-primary disabled={locked} onClick={() => { void submit() }}>{t('send')}</button></div>
      </section>}
      {(pending || inserted || status) && <div className="qyt-cc-status" role="status">{pending ? t('pending') : inserted ? t('inserted') : status}</div>}
    </>}
    {(selection || editor) && createPortal(<div ref={floating} className="qyt-cc-floating" data-qyt-cc-floating style={{ left: (editor ?? selection)!.left, top: (editor ?? selection)!.top }}>
      {editor ? <div className="qyt-cc-editor" role="dialog" aria-label={editor.id ? t('edit') : t('add')}>
        <blockquote>{editor.quote}</blockquote><label>{t('note')}<textarea autoFocus value={note} placeholder={t('placeholder')}
          onChange={event => setNote(event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing && !composing.current) { event.preventDefault(); save() } }} /></label>
        <div className="qyt-cc-actions">{editor.id && <button type="button" className="qyt-cc-action" onClick={() => { actions.remove([editor.id!]); close() }}>{t('remove')}</button>}
          <button type="button" className="qyt-cc-action" onClick={close}>{t('cancel')}</button><button type="button" className="qyt-cc-action" data-primary disabled={!note.trim()} onClick={save}>{t('save')}</button></div>
      </div> : <div className="qyt-cc-selection">
        <button type="button" className="qyt-cc-action" disabled={questionBusy} onPointerDown={event => event.preventDefault()} onClick={() => { setEditor(selection); setSelection(undefined); setNote('') }}>{t('add')}</button>
        <button type="button" className="qyt-cc-action" disabled={questionBusy} onPointerDown={event => event.preventDefault()} onClick={() => { void ask() }}>{t('newQuestion')}</button>
        {questionError && <div className="qyt-cc-status" role="status">{questionError}</div>}
      </div>}
    </div>, document.body)}
  </div>
}
