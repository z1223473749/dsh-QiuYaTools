/** File payloads shared by Chromium (Windows/macOS) and browser WebViews. */
export function isFileTransfer(data: DataTransfer | null): data is DataTransfer {
  return data !== null && (Array.from(data.types).includes('Files')
    || Array.from(data.items ?? []).some(item => item.kind === 'file')
    || data.files.length > 0)
}

const imageTypes: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
}

/**
 * A fresh File retains bytes/name/time, but has no native path identity. This
 * deliberately requests a real attachment instead of the Desktop @path route.
 * Blob-backed construction is lazy; it does not read a large file into memory.
 */
export function attachmentFile(file: File, FileType: typeof File = File): File {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  return new FileType([file], file.name, {
    type: file.type || imageTypes[extension] || '', lastModified: file.lastModified,
  })
}

/** Snapshot protected drag data synchronously, before the drop handler returns. */
export function droppedFiles(data: DataTransfer): { files: File[]; directory: boolean } {
  const items = Array.from(data.items ?? []).filter(item => item.kind === 'file')
  let directory = false
  const fromItems: File[] = []
  for (const item of items) {
    if (typeof item.webkitGetAsEntry === 'function' && item.webkitGetAsEntry()?.isDirectory) directory = true
    const file = item.getAsFile()
    if (file !== null) fromItems.push(file)
  }
  // Some source applications/WebViews expose only one of the two collections.
  const listed = Array.from(data.files)
  return { files: listed.length > 0 ? listed : fromItems, directory }
}

export interface FileDropOptions {
  canAccept: () => boolean
  addFiles: (files: readonly File[]) => void
  onHover: (active: boolean) => void
  onError: (reason: 'directory' | 'unavailable' | 'failed' | 'blocked') => void
}

const owners = new WeakMap<HTMLElement, () => void>()

/** One capture owner per composer; never handles text drags or another card. */
export function installComposerFileDrop(card: HTMLElement, options: FileDropOptions): () => void {
  owners.get(card)?.()
  const page = card.ownerDocument.defaultView
  if (page === null) return () => {}
  const inside = (target: EventTarget | null): boolean => target instanceof page.Element
    && target.closest('[data-composer-card]') === card
  const reset = (): void => options.onHover(false)
  const over = (event: DragEvent): void => {
    if (!inside(event.target)) { reset(); return }
    if (event.defaultPrevented || !isFileTransfer(event.dataTransfer)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    event.dataTransfer.dropEffect = options.canAccept() ? 'copy' : 'none'
    options.onHover(true)
  }
  const leave = (event: DragEvent): void => {
    if (!inside(event.relatedTarget)) reset()
  }
  const drop = (event: DragEvent): void => {
    reset()
    if (!inside(event.target) || event.defaultPrevented || !isFileTransfer(event.dataTransfer)) return
    // Consume even refusals: the browser must not navigate to the dropped file,
    // nor should a second handler insert its path/text or attach it twice.
    event.preventDefault()
    event.stopImmediatePropagation()
    if (!options.canAccept()) { options.onError('blocked'); return }
    try {
      const { files, directory } = droppedFiles(event.dataTransfer)
      if (directory) { options.onError('directory'); return }
      if (files.length === 0) { options.onError('unavailable'); return }
      options.addFiles(files.map(file => attachmentFile(file, page.File)))
    } catch {
      options.onError('failed')
    }
  }
  const paste = (event: ClipboardEvent): void => {
    if (!inside(event.target) || event.defaultPrevented || !isFileTransfer(event.clipboardData)) return
    const target = event.target as Element
    if (!target.closest('[data-composer-input][contenteditable="true"]')) return
    event.preventDefault(); event.stopImmediatePropagation()
    if (!options.canAccept()) { options.onError('blocked'); return }
    try {
      const { files, directory } = droppedFiles(event.clipboardData)
      if (directory) { options.onError('directory'); return }
      if (!files.length) { options.onError('unavailable'); return }
      options.addFiles(files.map(file => attachmentFile(file, page.File)))
    } catch { options.onError('failed') }
  }
  const pick = (event: Event): void => {
    if (event.defaultPrevented || !inside(event.target) || !(event.target instanceof page.HTMLInputElement)
      || event.target.type !== 'file' || !event.target.files?.length) return
    const input = event.target
    const files = Array.from(input.files ?? [])
    event.stopImmediatePropagation()
    input.value = ''
    if (!options.canAccept()) { options.onError('blocked'); return }
    try { options.addFiles(files.map(file => attachmentFile(file, page.File))) }
    catch { options.onError('failed') }
  }
  page.addEventListener('dragenter', over, true)
  page.addEventListener('dragover', over, true)
  page.addEventListener('dragleave', leave, true)
  page.addEventListener('drop', drop, true)
  page.addEventListener('paste', paste, true)
  page.addEventListener('change', pick, true)
  page.addEventListener('dragend', reset)
  page.addEventListener('blur', reset)
  let active = true
  const dispose = (): void => {
    if (!active) return
    active = false
    page.removeEventListener('dragenter', over, true)
    page.removeEventListener('dragover', over, true)
    page.removeEventListener('dragleave', leave, true)
    page.removeEventListener('drop', drop, true)
    page.removeEventListener('paste', paste, true)
    page.removeEventListener('change', pick, true)
    page.removeEventListener('dragend', reset)
    page.removeEventListener('blur', reset)
    if (owners.get(card) === dispose) owners.delete(card)
    reset()
  }
  owners.set(card, dispose)
  return dispose
}
