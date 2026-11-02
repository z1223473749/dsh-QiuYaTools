import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { ComposerAttachment, ComposerAttachmentsOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { installComposerFileDrop } from './drop.ts'
import { fileExtension, fileSize, filePreview, type FilePreview } from './preview.ts'

type Props = ComposerAttachmentsOwnerProps & PropsRuntime<'conversation.input.attachments'> & PropsLocale<'qiuyaTools'>

function FileThumbnail({ attachment }: { attachment: ComposerAttachment }) {
  const file = attachment.file
  const [preview, setPreview] = useState<{ file: File; value: FilePreview } | null>(null)
  useEffect(() => {
    let current = true
    if (attachment.kind !== 'image') void filePreview(file).then(value => {
      if (current) setPreview({ file, value })
    }).catch(() => { if (current) setPreview({ file, value: { kind: 'file' } }) })
    return () => { current = false }
  }, [file, attachment.kind])
  if (attachment.kind === 'image') return <img className="qyt-attachment-image" src={attachment.previewUrl} alt={file.name} />
  const value = preview?.file === file ? preview.value : undefined
  if (value?.kind === 'page') return <img className="qyt-attachment-page" src={value.url} alt={file.name}/>
  if (value?.kind === 'document') return <div className="qyt-attachment-document">{value.blocks.map((block, index) => <p key={index} data-bold={block.bold} data-center={block.center}>{block.text || '\u00a0'}</p>)}</div>
  if (value?.kind === 'text') return <pre className="qyt-attachment-text">{value.text}</pre>
  if (value?.kind === 'table') return <div className="qyt-attachment-table"><table><tbody>{value.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>
  return <span className="qyt-attachment-file" aria-hidden="true"><svg viewBox="0 0 32 38" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20 2H5a2 2 0 0 0-2 2v30a2 2 0 0 0 2 2h22a2 2 0 0 0 2-2V11zM20 2v10h9M9 21h14M9 27h10"/></svg><b>{fileExtension(file.name).slice(0, 7).toUpperCase()}</b></span>
}

/** Small type marks share the reference layout; content owns the thumbnail. */
function FileTypeMark({ name }: { name: string }) {
  const extension = fileExtension(name)
  const table = ['xlsx', 'xls', 'csv', 'tsv', 'ods'].includes(extension)
  const pdf = extension === 'pdf'
  return <svg className="qyt-attachment-type" data-type={table ? 'table' : pdf ? 'pdf' : 'document'} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M6 2h6a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"/><rect x="2" y="5" width="7" height="6" rx="1"/>{table ? <path d="M4 7h3M4 9h3M5.5 5v6"/> : <path d="M4 7h3M4 9h2M10 5h1M10 8h1"/>}</svg>
}

function PreviewDialog({ attachment, t, onClose }: { attachment: ComposerAttachment; t: Props['t']; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const node = dialog.current
    if (!node) return
    const previous = node.ownerDocument.activeElement
    node.showModal()
    return () => { node.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  return createPortal(<dialog ref={dialog} className="qyt-attachment-dialog" onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <header><strong>{attachment.file.name}</strong><button type="button" onClick={onClose} aria-label={t('attachmentClose')}>×</button></header>
    <div className="qyt-attachment-dialog-content"><FileThumbnail attachment={attachment}/></div>
    <footer>{fileSize(attachment.file.size)}</footer>
  </dialog>, document.body)
}

/** Presentation only: uploads, draft identity, removal and retry stay official. */
export function ComposerAttachments(props: Props) {
  const { attachments, uploads, canAcceptDrop, onRemoveAttachment, onRetryFile, t, sessionId } = props
  const anchor = useRef<HTMLDivElement>(null)
  const latest = useRef(props)
  latest.current = props
  const [hover, setHover] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const preview = attachments.find(attachment => attachment.id === previewId)
  useEffect(() => {
    setError(null)
    setPreviewId(null)
    const card = anchor.current?.closest('[data-composer-card]')
    if (!(card instanceof HTMLElement)) return
    return installComposerFileDrop(card, {
      canAccept: () => latest.current.canAcceptDrop,
      addFiles: files => { setError(null); latest.current.onAddFiles(files) },
      onHover: setHover,
      onError: reason => setError(latest.current.t(reason === 'directory' ? 'attachmentDirectory'
        : reason === 'unavailable' ? 'attachmentUnavailable' : reason === 'blocked' ? 'attachmentBlocked' : 'attachmentFailed')),
    })
  }, [sessionId])
  return <div ref={anchor} className="qyt-attachments" data-qyt-attachments="">
    {hover && <div className="qyt-attachment-drop" data-blocked={!canAcceptDrop} role="status"><span>＋</span><strong>{t(canAcceptDrop ? 'attachmentDrop' : 'attachmentBlocked')}</strong>{canAcceptDrop && <small>{t('attachmentDropHint')}</small>}</div>}
    {error && <div className="qyt-attachment-error" role="alert">{error}<button type="button" onClick={() => setError(null)} aria-label={t('attachmentClose')}>×</button></div>}
    {attachments.length > 0 && <div className="qyt-attachment-rail" role="list" aria-label={t('attachmentList')}>
      {attachments.map(attachment => {
        const upload = attachment.kind === 'file' ? uploads[attachment.id] : undefined
        const progress = upload?.status === 'uploading' && upload.total ? Math.min(100, Math.round(upload.loaded / upload.total * 100)) : undefined
        const status = upload?.status === 'error' ? 'error' : attachment.kind === 'image' || upload?.status === 'ready' ? 'ready' : 'uploading'
        const statusText = `${fileSize(attachment.file.size)} · ${t(status === 'ready' ? 'attachmentReady' : status === 'error' ? 'attachmentUploadFailed' : 'attachmentUploading')}${progress === undefined ? '' : ` ${progress}%`}`
        return <div key={attachment.id} className="qyt-attachment-card" role="listitem" data-status={status} data-kind={attachment.kind} title={`${attachment.file.name}\n${statusText}`} onClick={event => { if (!(event.target as Element).closest('button')) setPreviewId(attachment.id) }}>
          <button type="button" className="qyt-attachment-open" title={`${attachment.file.name}\n${statusText}`} aria-label={`${t('attachmentPreview')} ${attachment.file.name}`} onClick={() => setPreviewId(attachment.id)}><FileThumbnail attachment={attachment}/></button>
          <button type="button" className="qyt-attachment-remove" disabled={!canAcceptDrop} aria-label={`${t('attachmentRemove')} ${attachment.file.name}`} onClick={() => onRemoveAttachment(attachment.id)}>×</button>
          {attachment.kind !== 'image' && <div className="qyt-attachment-info"><FileTypeMark name={attachment.file.name}/><strong>{attachment.file.name}</strong></div>}
          {status !== 'ready' && <span className="qyt-attachment-state" role="status">{statusText}</span>}
          {upload?.status === 'error' && <div className="qyt-attachment-retry"><span title={upload.message}>{upload.message}</span><button type="button" disabled={!canAcceptDrop} onClick={() => onRetryFile(attachment.id)}>{t('attachmentRetry')}</button></div>}
        </div>
      })}
    </div>}
    {preview && <PreviewDialog key={preview.id} attachment={preview} t={t} onClose={() => setPreviewId(null)}/>}
  </div>
}

/** Lower priority wins the optional presentation slot; unload restores its owner. */
export function installComposerAttachments(ctx: Context): () => void {
  return ctx.slots.inject('conversation.input.attachments', () => ctx.slots.register({
    name: 'conversation.input.attachments', locale: 'qiuyaTools', priority: -100,
  }, ComposerAttachments))
}
