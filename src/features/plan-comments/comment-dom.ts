/** Read plan text and create browser Ranges without changing Markdown's DOM. */
import type { PlanComment } from './plan-comments.ts'

/** Text offsets and surrounding context captured from a plan selection. */
export type PlanTextAnchor = Pick<PlanComment, 'quote' | 'start' | 'end' | 'prefix' | 'suffix'>

function textNodes(root: HTMLElement): Text[] {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let node = walker.nextNode()
  while (node !== null) {
    // Markdown controls and decorative icons are not part of the plan text.
    if (node.parentElement?.closest('button, input, textarea, select, script, style, svg, [aria-hidden="true"], [data-code-block-banner]') === null) nodes.push(node as Text)
    node = walker.nextNode()
  }
  return nodes
}

/**
 * Read selectable Markdown content, excluding its generated controls.
 * @param root - Markdown-only document element.
 * @returns the text whose offsets identify comments.
 */
export function renderedPlanText(root: HTMLElement): string {
  return textNodes(root).map(node => node.data).join('')
}

function offsetAt(root: HTMLElement, container: Node, offset: number, nodes: readonly Text[]): number {
  const prefix = root.ownerDocument.createRange()
  prefix.selectNodeContents(root)
  prefix.setEnd(container, offset)
  let cursor = 0
  for (const node of nodes) {
    if (prefix.comparePoint(node, node.length) <= 0) cursor += node.length
    else if (prefix.comparePoint(node, 0) <= 0) return cursor + (node === container ? offset : 0)
    else return cursor
  }
  return cursor
}

/**
 * Capture a selection with trimmed text and matching offsets across inline nodes.
 * @param root - Markdown-only document element.
 * @param range - User selection, in either selection direction.
 * @returns a nonempty anchor when both endpoints belong to the document.
 */
export function selectionPlanAnchor(root: HTMLElement, range: Range): PlanTextAnchor | undefined {
  if (range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return undefined
  const nodes = textNodes(root)
  const text = nodes.map(node => node.data).join('')
  let start = offsetAt(root, range.startContainer, range.startOffset, nodes)
  let end = offsetAt(root, range.endContainer, range.endOffset, nodes)
  const raw = text.slice(start, end)
  start += raw.length - raw.trimStart().length
  end -= raw.length - raw.trimEnd().length
  if (end <= start) return undefined
  return { quote: text.slice(start, end), start, end, prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(end, end + 32) }
}

/**
 * Resolve rendered-text offsets into a Range, retaining inline Markdown nodes.
 * @param root - Markdown-only document element.
 * @param start - Inclusive text offset.
 * @param end - Exclusive text offset.
 * @returns the anchored Range or undefined when offsets exceed the document.
 */
export function planTextRange(root: HTMLElement, start: number, end: number): Range | undefined {
  if (start < 0 || end <= start) return undefined
  const range = root.ownerDocument.createRange()
  let cursor = 0
  let started = false
  for (const node of textNodes(root)) {
    const next = cursor + node.length
    if (!started && start < next) {
      range.setStart(node, start - cursor)
      started = true
    }
    if (started && end <= next) {
      range.setEnd(node, end - cursor)
      return range
    }
    cursor = next
  }
  return undefined
}

/**
 * Split a comment into text-only Ranges so highlights exclude banners and block boxes.
 * @param root - Markdown-only document element.
 * @param start - Inclusive text offset.
 * @param end - Exclusive text offset.
 * @returns each inline text segment, or an empty array for invalid offsets.
 */
export function planHighlightRanges(root: HTMLElement, start: number, end: number): readonly Range[] {
  if (planTextRange(root, start, end) === undefined) return []
  const ranges: Range[] = []
  let cursor = 0
  for (const node of textNodes(root)) {
    const first = Math.max(0, start - cursor)
    const last = Math.min(node.length, end - cursor)
    if (last > first) {
      const range = root.ownerDocument.createRange()
      range.setStart(node, first)
      range.setEnd(node, last)
      ranges.push(range)
    }
    cursor += node.length
    if (cursor >= end) break
  }
  return ranges
}
