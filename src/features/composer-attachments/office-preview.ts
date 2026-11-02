import { Inflate } from 'fflate'
import type { FilePreview } from './preview.ts'

const MAX_PART = 4 * 1024 * 1024
const MAX_TOTAL = 12 * 1024 * 1024
type Entry = { name: string; offset: number; compressed: number; size: number; method: number }

/** Read selected ZIP members, with explicit compressed and inflated byte caps. */
export async function officeParts(file: File): Promise<(name: string) => Promise<Uint8Array | undefined>> {
  const start = Math.max(0, file.size - 65557)
  const tail = new Uint8Array(await file.slice(start).arrayBuffer())
  const view = new DataView(tail.buffer)
  let end = tail.length - 22
  for (; end >= 0; end--) {
    if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === tail.length) break
  }
  if (end < 0) throw Error('Invalid Office archive')
  const count = view.getUint16(end + 10, true)
  const length = view.getUint32(end + 12, true), offset = view.getUint32(end + 16, true)
  if (count > 4096 || length > MAX_PART || offset + length > start + end) throw Error('Office directory too large')
  const directory = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
  const central = new DataView(directory.buffer), entries = new Map<string, Entry>()
  let index = 0
  for (let i = 0; i < count; i++) {
    if (index + 46 > directory.length || central.getUint32(index, true) !== 0x02014b50) throw Error('Invalid ZIP entry')
    const nameLength = central.getUint16(index + 28, true)
    const next = index + 46 + nameLength + central.getUint16(index + 30, true) + central.getUint16(index + 32, true)
    if (next > directory.length) throw Error('Invalid ZIP directory')
    const name = new TextDecoder().decode(directory.subarray(index + 46, index + 46 + nameLength))
    if ((central.getUint16(index + 8, true) & 1) === 0) entries.set(name, {
      name, method: central.getUint16(index + 10, true), compressed: central.getUint32(index + 20, true),
      size: central.getUint32(index + 24, true), offset: central.getUint32(index + 42, true),
    })
    index = next
  }
  let total = 0
  const loaded = new Map<string, Uint8Array>()
  return async name => {
    if (loaded.has(name)) return loaded.get(name)
    const entry = entries.get(name)
    if (!entry) return undefined
    if (entry.size > MAX_PART || entry.compressed > MAX_PART || total + entry.size > MAX_TOTAL || ![0, 8].includes(entry.method)) throw Error('Office preview limit')
    const header = new DataView(await file.slice(entry.offset, entry.offset + 30).arrayBuffer())
    if (header.byteLength !== 30 || header.getUint32(0, true) !== 0x04034b50) throw Error('Invalid ZIP header')
    const begin = entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true)
    if (begin + entry.compressed > offset) throw Error('Invalid ZIP data range')
    const compressed = new Uint8Array(await file.slice(begin, begin + entry.compressed).arrayBuffer())
    let data = compressed
    if (entry.method === 8) {
      data = new Uint8Array(entry.size)
      let written = 0
      const stream = new Inflate(chunk => {
        if (written + chunk.length > entry.size) throw Error('Office part exceeds declared size')
        data.set(chunk, written); written += chunk.length
      })
      // Bound each inflate step as well as the declared output. A forged ZIP
      // size must not make a tiny compressed member expand without a ceiling.
      for (let offset = 0; offset < compressed.length; offset += 1024) {
        stream.push(compressed.subarray(offset, offset + 1024), offset + 1024 >= compressed.length)
      }
      if (written !== entry.size) throw Error('Invalid deflate output size')
    }
    if (data.length !== entry.size) throw Error('Invalid ZIP part size')
    total += data.length
    loaded.set(name, data)
    return data
  }
}

function xml(bytes: Uint8Array | undefined): Document {
  if (!bytes) throw Error('Office part missing')
  const text = new TextDecoder().decode(bytes)
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw Error('Unsupported XML declaration')
  const document = new DOMParser().parseFromString(text, 'application/xml')
  if (document.getElementsByTagName('parsererror').length) throw Error('Invalid Office XML')
  return document
}
const elements = (parent: Element | Document, tag: string): Element[] => Array.from(parent.getElementsByTagNameNS('*', tag))
const content = (parent: Element, tag: string): string => elements(parent, tag).map(node => node.textContent ?? '').join('')

/** Word paragraphs and the first worksheet's saved cell values, all inert text. */
export async function readOfficePreview(file: File, extension: string): Promise<FilePreview> {
  const read = await officeParts(file)
  // Native document thumbnails preserve page layout when the author saved one.
  for (const name of ['docProps/thumbnail.jpeg', 'docProps/thumbnail.jpg', 'docProps/thumbnail.png']) {
    const bytes = await read(name)
    if (bytes && bytes.length <= 512 * 1024) {
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return { kind: 'page', url: `data:image/${name.endsWith('.png') ? 'png' : 'jpeg'};base64,${btoa(binary)}` }
    }
  }
  if (extension === 'docx') {
    const document = xml(await read('word/document.xml'))
    const blocks = elements(document, 'p').slice(0, 60).map(paragraph => ({
      text: elements(paragraph, 'r').map(run => Array.from(run.children).map(child => child.localName === 't' ? child.textContent ?? '' : child.localName === 'tab' ? '    ' : child.localName === 'br' ? '\n' : '').join('')).join('').slice(0, 500),
      bold: elements(paragraph, 'b').length > 0 || elements(paragraph, 'pStyle').some(style => /heading|title/i.test(style.getAttribute('w:val') ?? '')),
      center: elements(paragraph, 'jc').some(align => align.getAttribute('w:val') === 'center'),
    }))
    return { kind: 'document', blocks }
  }
  if (extension === 'pptx') {
    const document = xml(await read('ppt/slides/slide1.xml'))
    return { kind: 'document', blocks: elements(document, 'p').slice(0, 40).map((p, i) => ({ text: content(p, 't').slice(0, 500), bold: i === 0, center: false })) }
  }
  const shared = await read('xl/sharedStrings.xml')
  const strings = shared ? elements(xml(shared), 'si').map(si => content(si, 't')) : []
  let sheetPath = 'xl/worksheets/sheet1.xml'
  const workbook = await read('xl/workbook.xml'), relations = await read('xl/_rels/workbook.xml.rels')
  if (workbook && relations) {
    const first = elements(xml(workbook), 'sheet')[0]
    const id = first?.getAttribute('r:id')
    const target = elements(xml(relations), 'Relationship').find(relation => relation.getAttribute('Id') === id)?.getAttribute('Target')
    if (target && !target.includes('..') && !target.includes(':')) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`
  }
  const sheet = xml(await read(sheetPath))
  const rows: string[][] = []
  for (const row of elements(sheet, 'row').slice(0, 12)) {
    const values: string[] = []
    for (const cell of elements(row, 'c')) {
      const address = cell.getAttribute('r')?.match(/^[A-Z]+/i)?.[0] ?? ''
      let column = 0
      for (const letter of address.toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64
      if (column > 8) continue
      const type = cell.getAttribute('t'), raw = content(cell, 'v')
      const value = type === 's' ? strings[Number(raw)] ?? '' : type === 'inlineStr' ? content(cell, 't') : type === 'b' ? raw === '1' ? 'TRUE' : 'FALSE' : raw
      values[Math.max(0, column - 1)] = value.slice(0, 160)
    }
    rows.push(Array.from({ length: Math.max(1, values.length) }, (_, i) => values[i] ?? ''))
  }
  return { kind: 'table', rows }
}
