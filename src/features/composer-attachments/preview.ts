import { readOfficePreview } from './office-preview.ts'

export type FilePreview = { kind: 'text'; text: string } | { kind: 'table'; rows: string[][] }
  | { kind: 'document'; blocks: { text: string; bold: boolean; center: boolean }[] }
  | { kind: 'page'; url: string } | { kind: 'file' }

const textExtensions = new Set(('txt md markdown log json jsonl ndjson yaml yml toml ini cfg conf csv tsv xml html htm css scss less js jsx mjs cjs ts tsx py go rs java kt swift c h cpp hpp cs rb php sh bash zsh ps1 sql vue svelte env gitignore dockerfile').split(' '))
export const PREVIEW_BYTES = 16 * 1024

export function fileExtension(name: string): string {
  return (name.split('.').pop() || name).toLowerCase()
}

/** A small CSV/TSV window, including quoted delimiters and multiline cells. */
export function tablePreview(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  const pushCell = (): void => { if (row.length < 5) row.push(cell.slice(0, 100)); cell = '' }
  for (let i = 0; i < text.length && rows.length < 5; i++) {
    const c = text[i]
    if (c === '"' && (quoted || cell === '')) {
      if (quoted && text[i + 1] === '"') { if (cell.length < 100) cell += '"'; i++ }
      else quoted = !quoted
    } else if (!quoted && c === delimiter) pushCell()
    else if (!quoted && (c === '\r' || c === '\n')) {
      pushCell(); rows.push(row); row = []
      if (c === '\r' && text[i + 1] === '\n') i++
    } else if (cell.length < 100) cell += c
  }
  if (rows.length < 5 && (cell || row.length)) { pushCell(); rows.push(row) }
  return rows
}

/** Bounded, local-only reads. Rendering uses React text nodes, never file HTML. */
export async function readFilePreview(file: File): Promise<FilePreview> {
  const extension = fileExtension(file.name)
  if (['docx', 'xlsx', 'pptx'].includes(extension)) return readOfficePreview(file, extension).catch(() => ({ kind: 'file' }))
  if (extension === 'pdf' || file.type === 'application/pdf') {
    const { readPdfPreview } = await import('./pdf-preview.ts')
    return readPdfPreview(file)
  }
  if (!file.type.startsWith('text/') && !textExtensions.has(extension)
    && !/\b(json|xml|javascript|typescript|yaml)\b/i.test(file.type)) return { kind: 'file' }
  const bytes = new Uint8Array(await file.slice(0, PREVIEW_BYTES).arrayBuffer())
  let encoding = 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'
  let text = new TextDecoder(encoding).decode(bytes)
  // Keep binary files with misleading names out of the text thumbnail.
  if (text.includes('\0')) return { kind: 'file' }
  text = text.replace(/\r\n?/g, '\n')
  if (extension === 'csv' || extension === 'tsv' || /(?:csv|tab-separated-values)/.test(file.type)) {
    return { kind: 'table', rows: tablePreview(text, extension === 'tsv' || file.type.includes('tab-separated') ? '\t' : ',') }
  }
  return { kind: 'text', text: text.split('\n').slice(0, 40).map(line => line.slice(0, 180)).join('\n') }
}

const previews = new WeakMap<File, Promise<FilePreview>>()
/** The same file uses one parse/render operation in the rail and its dialog. */
export function filePreview(file: File): Promise<FilePreview> {
  let pending = previews.get(file)
  if (!pending) {
    pending = readFilePreview(file).catch((): FilePreview => ({ kind: 'file' }))
    previews.set(file, pending)
  }
  return pending
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}
