/**
 * Large-text paste migrated from anywhere-labs/dsh-desktop, PR #1163.
 * Source: https://github.com/anywhere-labs/dsh-desktop/pull/1163
 * Original implementation: QiuYaTools / Qiu, MIT licensed.
 * The official composer remains the owner of every attachment and upload.
 */
import React, { useEffect, useRef } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRuntime, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

export interface PastedTextThresholds {
  /** Unicode code points, rather than UTF-16 code units. */
  characters: number
  /** Logical lines: CRLF counts as one line break. */
  lines: number
}

export const DEFAULT_PASTED_TEXT_THRESHOLDS: Readonly<PastedTextThresholds> = Object.freeze({
  characters: 1000,
  lines: 15,
})

export const PASTED_TEXT_THRESHOLD_RANGES = Object.freeze({
  characters: Object.freeze({ min: 1, max: 1_000_000 }),
  lines: Object.freeze({ min: 1, max: 100_000 }),
})

/** Treat an unavailable or invalid stored threshold as its published default. */
export function normalizePastedTextThresholds(value?: Partial<PastedTextThresholds>): PastedTextThresholds {
  const valid = (key: keyof PastedTextThresholds): number => {
    const limit = value?.[key]
    const range = PASTED_TEXT_THRESHOLD_RANGES[key]
    return typeof limit === 'number' && Number.isInteger(limit) && limit >= range.min && limit <= range.max
      ? limit
      : DEFAULT_PASTED_TEXT_THRESHOLDS[key]
  }
  return { characters: valid('characters'), lines: valid('lines') }
}

/** Preserve the original text while counting Unicode characters and logical lines. */
export function shouldAttachPastedText(text: string, limits?: Partial<PastedTextThresholds>): boolean {
  if (!/\S/u.test(text)) return false
  const thresholds = normalizePastedTextThresholds(limits)
  let characters = 0
  let lines = 1
  let previous = ''
  for (const character of text) {
    characters += 1
    if (character === '\r' || (character === '\n' && previous !== '\r')) lines += 1
    if (characters >= thresholds.characters || lines >= thresholds.lines) return true
    previous = character
  }
  return false
}

/** Browser-only file: no host path, filesystem write, or plugin-owned upload. */
export function createPastedTextFile(text: string, prefix = '粘贴文本'): File {
  const now = new Date()
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map(value => String(value).padStart(2, '0')).join('')
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(value => String(value).padStart(2, '0')).join('')
  return new File([text], `${prefix}-${date}-${time}-${crypto.randomUUID().slice(0, 8)}.txt`, {
    type: 'text/plain', endings: 'transparent', lastModified: now.getTime(),
  })
}

export type AddPastedTextFiles = (files: readonly File[]) => string | null

export interface PastedTextCaptureOptions {
  readThresholds: () => Partial<PastedTextThresholds> | undefined
  /** Must return null only after the official composer synchronously accepted the file. */
  addFiles: AddPastedTextFiles
  /** Translated filename stem, read at paste time so language changes take effect. */
  readFileNamePrefix?: () => string
}

/** A synchronous failure or refusal leaves the original browser paste untouched. */
export function acceptPastedTextFile(text: string, options: PastedTextCaptureOptions): boolean {
  try {
    if (!shouldAttachPastedText(text, options.readThresholds())) return false
    return options.addFiles([createPastedTextFile(text, options.readFileNamePrefix?.())]) === null
  } catch {
    return false
  }
}

const captureOwners = new WeakMap<HTMLElement, () => void>()

/**
 * One window-capture listener scoped to a concrete composer card. It runs
 * before React's delegated root capture and Lexical's editor handlers. Only
 * successful intake consumes the paste; other pastes keep the official path.
 */
export function installPastedTextCapture(card: HTMLElement, options: PastedTextCaptureOptions): () => void {
  captureOwners.get(card)?.()
  const page = card.ownerDocument.defaultView
  if (page === null) return () => {}
  const onPaste = (event: ClipboardEvent): void => {
    if (event.defaultPrevented || !event.cancelable || event.clipboardData === null) return
    if (!(event.target instanceof page.Element)) return
    const editor = event.target.closest('[data-composer-input]')
    if (!(editor instanceof page.HTMLElement) || editor.closest('[data-composer-card]') !== card) return
    if (editor.getAttribute('contenteditable') !== 'true' || editor.getAttribute('aria-disabled') === 'true') return
    const clipboard = event.clipboardData
    if (Array.from(clipboard.items).some(item => item.kind === 'file') || clipboard.files.length > 0) return
    const text = clipboard.getData('text/plain')
    if (!acceptPastedTextFile(text, options)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  page.addEventListener('paste', onPaste, true)
  let active = true
  const dispose = (): void => {
    if (!active) return
    active = false
    page.removeEventListener('paste', onPaste, true)
    if (captureOwners.get(card) === dispose) captureOwners.delete(card)
  }
  captureOwners.set(card, dispose)
  return dispose
}

/**
 * The pinned official composer exposes synchronous file admission in its
 * registry injection face. Do not mutate the entry or bundle.
 * An unavailable/changed face simply leaves ordinary paste in place.
 */
export function composerAddFiles(entries: readonly StoredEntry[], sessionId: string): AddPastedTextFiles | undefined {
  for (const entry of entries) {
    if (entry.inject === undefined) continue
    try {
      const injected = (entry.inject as (id: string) => Record<string, unknown>)(sessionId)
      if (typeof injected.addFiles === 'function') return injected.addFiles as AddPastedTextFiles
    } catch {
      // A provider that is not live for this session cannot admit this paste.
    }
  }
  return undefined
}

export interface InstallPastedTextOptions {
  ctx: Context
  readThresholds: PastedTextCaptureOptions['readThresholds']
  readFileNamePrefix?: PastedTextCaptureOptions['readFileNamePrefix']
}

/** Install an additive, session-scoped bridge; its disposer also unmounts every listener. */
export function installPastedText({ ctx, readThresholds, readFileNamePrefix }: InstallPastedTextOptions): () => void {
  function PastedTextBridge({ sessionId, useSession }: PropsRuntime<'conversation.input.overlay'>) {
    const anchor = useRef<HTMLSpanElement | null>(null)
    const subagent = useSession(snapshot => snapshot.subagent)
    useEffect(() => {
      const card = anchor.current?.closest('[data-composer-card]')
      if (!(card instanceof HTMLElement) || subagent !== null) return
      return installPastedTextCapture(card, {
        readThresholds,
        readFileNamePrefix,
        addFiles: files => {
          const receiver = composerAddFiles(ctx.slots.entriesOfSlot('conversation.composer.bar'), sessionId)
          // null is the composer's success result and must pass through intact.
          return receiver === undefined ? 'composer-unavailable' : receiver(files)
        },
      })
    }, [sessionId, subagent])
    return <span ref={anchor} hidden data-qyt-pasted-text="" aria-hidden="true" />
  }
  return ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'qiuya-tools-pasted-text',
    order: 100,
  }, PastedTextBridge))
}
