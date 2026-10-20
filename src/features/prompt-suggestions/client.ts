/** A suggestion is a decoration until the public, revision-guarded insert succeeds. */
export interface PromptSuggestionState {
  sessionId: string
  contextKey: string
  language: 'zh' | 'en'
  ready: boolean
  draft: string
  draftRev: number
  phase: string
  attachmentCount: number
  occurrenceCount: number
}
export interface PromptInsertion { readonly start: number; readonly end: number; readonly draftRev: number }
export interface PromptSuggestionRequest { sessionId: string; requestId: string; language: 'zh' | 'en' }
export interface PromptSuggestionReply { suggestion: string | null; anchorMessageId: string | null }
export interface PromptSuggestionOptions {
  read(): PromptSuggestionState
  captureInsertion(): PromptInsertion
  insertText(text: string, span: PromptInsertion): boolean
  request(payload: PromptSuggestionRequest, signal: AbortSignal): Promise<PromptSuggestionReply>
  cancel(requestId: string): Promise<unknown>
  nativeMenuOpen?(): boolean
  createRequestId?(): string
  debounceMs?: number
}
export interface PromptSuggestionController { sync(): void; dispose(): void }

const owners = new WeakMap<HTMLElement, PromptSuggestionController>()

/** Only plain, empty drafts participate. Attachments and references remain entirely native. */
export function canSuggest(state: PromptSuggestionState): boolean {
  return state.ready && !!state.sessionId && !!state.contextKey && state.phase === 'plain'
    && state.draft === '' && state.attachmentCount === 0 && state.occurrenceCount === 0
}

/** Reject malformed transport output without interpreting markup or executing suggested actions. */
export function suggestionText(value: unknown): string | undefined {
  if (typeof value !== 'string') return
  const text = value.trim()
  if (!text || Array.from(text).length > 120 || /[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(text)) return
  return text
}

/** One editor-card owner; all listeners, requests and decorations leave together. */
export function attachPromptSuggestion(card: HTMLElement, options: PromptSuggestionOptions): PromptSuggestionController {
  owners.get(card)?.dispose()
  const doc = card.ownerDocument
  const page = doc.defaultView
  if (!page) return { sync() {}, dispose() {} }
  const ghost = doc.createElement('div')
  ghost.className = 'qyt-prompt-suggestion'
  ghost.setAttribute('aria-hidden', 'true')
  ghost.hidden = true
  const text = doc.createElement('span')
  text.className = 'qyt-prompt-suggestion-text'
  const key = doc.createElement('kbd')
  key.textContent = 'Tab'
  ghost.append(text, key)
  const announcement = doc.createElement('span')
  announcement.className = 'qyt-prompt-suggestion-sr'
  announcement.setAttribute('role', 'status')
  announcement.setAttribute('aria-live', 'polite')
  let grow: HTMLElement | null = null
  let editor: HTMLElement | null = null
  let disposed = false
  let composing = false
  let compositionUntil = 0
  let compositionTimer: number | undefined
  let timer: number | undefined
  let epoch = 0
  let currentKey = ''
  let dismissedKey = ''
  let candidate: string | undefined
  let attemptedKey = ''
  let attemptedAt = 0
  let pending: { id: string; abort: AbortController } | undefined

  const identity = (state: PromptSuggestionState): string => JSON.stringify([state.sessionId, state.contextKey, state.language])
  const hide = (): void => {
    if (!ghost.hidden) ghost.hidden = true
    grow?.removeAttribute('data-qyt-prompt-visible')
    if (announcement.textContent) announcement.textContent = ''
  }
  const stopRequest = (): void => {
    epoch += 1
    if (timer !== undefined) { page.clearTimeout(timer); timer = undefined }
    const operation = pending
    pending = undefined
    if (operation) {
      operation.abort.abort()
      void options.cancel(operation.id).catch(() => {})
      attemptedKey = ''
    }
  }
  const locate = (): void => {
    const found = card.querySelector<HTMLElement>('[data-composer-input]')
    const parent = found?.parentElement ?? null
    if (parent !== grow) {
      grow?.removeAttribute('data-qyt-prompt-visible')
      ghost.remove(); announcement.remove()
      grow = parent
    }
    editor = found
  }
  const menuSelector = '[role="menu"], [role="dialog"], [role="alertdialog"]'
  const triggerSelector = '[aria-expanded="true"][aria-haspopup], [aria-expanded="true"][aria-controls]'
  const portalMenuOpen = (): boolean => {
    if (card.querySelector(triggerSelector)) return true
    return Array.from(doc.querySelectorAll<HTMLElement>(menuSelector)).some(element =>
      element.getClientRects().length > 0 && !element.closest('[hidden], [aria-hidden="true"]'))
  }
  const eligible = (state: PromptSuggestionState): boolean => {
    if (!canSuggest(state) || !card.isConnected || card.getClientRects().length === 0 || !editor || !grow || disposed) return false
    if (doc.visibilityState === 'hidden' || !doc.hasFocus() || doc.activeElement !== editor) return false
    if (composing || Date.now() < compositionUntil || editor.hasAttribute('data-composer-composing')) return false
    if (editor.getAttribute('contenteditable') !== 'true' || editor.getAttribute('aria-disabled') === 'true') return false
    if (editor.textContent !== '' || card.closest('[hidden], [aria-hidden="true"]')) return false
    try { if (options.nativeMenuOpen?.()) return false } catch { return false }
    if (card.querySelector('[data-trigger-menu], [data-popup-select], [role="listbox"]') || portalMenuOpen()) return false
    const selection = doc.getSelection()
    if (!selection?.isCollapsed || !selection.anchorNode || !editor.contains(selection.anchorNode)) return false
    try {
      const span = options.captureInsertion()
      return span.start === 0 && span.end === 0 && span.draftRev === state.draftRev
    } catch { return false }
  }
  const show = (state: PromptSuggestionState): void => {
    if (!candidate || !grow || !eligible(state) || dismissedKey === currentKey) { hide(); return }
    if (ghost.parentElement !== grow) grow.append(ghost)
    if (announcement.parentElement !== grow) grow.append(announcement)
    if (text.textContent !== candidate) text.textContent = candidate
    if (ghost.hidden) ghost.hidden = false
    if (!grow.hasAttribute('data-qyt-prompt-visible')) grow.setAttribute('data-qyt-prompt-visible', '')
    const hint = state.language === 'zh' ? `建议：${candidate}（按 Tab 填入，按 Esc 隐藏）` : `Suggestion: ${candidate} (Press Tab to insert, Escape to dismiss.)`
    if (announcement.textContent !== hint) announcement.textContent = hint
  }
  const sync = (): void => {
    if (disposed) return
    locate()
    const state = options.read()
    const nextKey = identity(state)
    if (nextKey !== currentKey) {
      stopRequest(); hide(); candidate = undefined; attemptedKey = ''; currentKey = nextKey
    }
    if (!eligible(state) || dismissedKey === currentKey) { hide(); stopRequest(); return }
    if (candidate) { show(state); return }
    if (pending || timer !== undefined || attemptedKey === currentKey && Date.now() - attemptedAt < 15_000) return
    const scheduledKey = currentKey
    timer = page.setTimeout(() => {
      timer = undefined
      const current = options.read()
      if (disposed || identity(current) !== scheduledKey || !eligible(current) || dismissedKey === scheduledKey) return
      const id = options.createRequestId?.() ?? page.crypto.randomUUID()
      const abort = new AbortController()
      const generation = ++epoch
      attemptedKey = scheduledKey; attemptedAt = Date.now()
      pending = { id, abort }
      void options.request({ sessionId: current.sessionId, requestId: id, language: current.language }, abort.signal)
        .then(result => {
          if (disposed || epoch !== generation || abort.signal.aborted || identity(options.read()) !== scheduledKey) return
          candidate = suggestionText(result.suggestion)
          show(options.read())
        }).catch(() => { /* A failed helper request leaves the native placeholder and draft alone. */ })
        .finally(() => { if (pending?.id === id) pending = undefined })
    }, options.debounceMs ?? 500)
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || !event.cancelable || !candidate || ghost.hidden || event.repeat
      || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.keyCode === 229) return
    if (event.key !== 'Tab' && event.key !== 'Escape') return
    locate()
    const state = options.read()
    if (!editor || event.target !== editor && !(event.target instanceof page.Node && editor.contains(event.target))
      || identity(state) !== currentKey || !eligible(state)) { hide(); return }
    if (event.key === 'Escape') {
      dismissedKey = currentKey; hide(); stopRequest(); event.preventDefault(); return
    }
    try {
      const span = options.captureInsertion()
      if (span.start !== 0 || span.end !== 0 || span.draftRev !== state.draftRev || !options.insertText(candidate, span)) { dismissedKey = currentKey; hide(); return }
      dismissedKey = currentKey
      hide(); stopRequest()
      event.preventDefault()
      event.stopPropagation()
    } catch { dismissedKey = currentKey; hide() }
  }
  const onInput = (): void => { hide(); stopRequest(); queueMicrotask(sync) }
  const onCompositionStart = (): void => { composing = true; hide(); stopRequest() }
  const onCompositionEnd = (): void => {
    composing = false; compositionUntil = Date.now() + 10
    if (compositionTimer !== undefined) page.clearTimeout(compositionTimer)
    compositionTimer = page.setTimeout(sync, 11)
  }
  const observer = new page.MutationObserver(sync)
  observer.observe(card, { subtree: true, childList: true, attributes: true, attributeFilter: ['contenteditable', 'aria-disabled', 'data-composer-composing', 'hidden', 'data-trigger-menu', 'data-popup-select'] })
  // Native toolbar menus are portaled to body and can retain editor focus on WebKit.
  // Ignore ordinary conversation mutations; only menu/trigger changes resync the helper.
  const portalSelector = `${menuSelector}, ${triggerSelector}`
  const portalObserver = new page.MutationObserver(records => {
    const touchesMenu = (node: Node): boolean => node instanceof page.Element
      && (!!node.closest(portalSelector) || !!node.querySelector(portalSelector))
    if (records.some(record => record.type === 'attributes'
      ? (record.target instanceof page.Element && (card.contains(record.target) || touchesMenu(record.target)))
      : touchesMenu(record.target) || [...record.addedNodes, ...record.removedNodes].some(touchesMenu))) sync()
  })
  portalObserver.observe(doc.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['aria-expanded', 'aria-controls', 'aria-hidden', 'hidden', 'role'] })
  card.addEventListener('keydown', onKeyDown)
  card.addEventListener('input', onInput)
  card.addEventListener('focusin', sync)
  card.addEventListener('focusout', sync)
  card.addEventListener('compositionstart', onCompositionStart)
  card.addEventListener('compositionend', onCompositionEnd)
  doc.addEventListener('selectionchange', sync)
  doc.addEventListener('visibilitychange', sync)
  page.addEventListener('focus', sync)
  page.addEventListener('blur', sync)
  const controller: PromptSuggestionController = {
    sync,
    dispose() {
      if (disposed) return
      disposed = true; stopRequest(); hide(); observer.disconnect(); portalObserver.disconnect()
      if (compositionTimer !== undefined) page.clearTimeout(compositionTimer)
      card.removeEventListener('keydown', onKeyDown)
      card.removeEventListener('input', onInput)
      card.removeEventListener('focusin', sync)
      card.removeEventListener('focusout', sync)
      card.removeEventListener('compositionstart', onCompositionStart)
      card.removeEventListener('compositionend', onCompositionEnd)
      doc.removeEventListener('selectionchange', sync)
      doc.removeEventListener('visibilitychange', sync)
      page.removeEventListener('focus', sync)
      page.removeEventListener('blur', sync)
      ghost.remove(); announcement.remove()
      if (owners.get(card) === controller) owners.delete(card)
    },
  }
  owners.set(card, controller)
  sync()
  return controller
}
