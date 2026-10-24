/** Cosmetic layout only: this module has no Host, control, frame or device capability. */
export interface InlinePreviewPoint { x: number; y: number }
export interface InlinePreviewSize { width: number; height: number }
export interface InlinePreviewBounds extends InlinePreviewSize { left: number; top: number; right: number; bottom: number }
const phases = new Set(['hero', 'active', 'settling'])
const finite = (value: number) => Number.isFinite(value) ? value : 0
/** Kept for existing callers that deliberately have only a viewport. */
export function clampInlinePreviewPosition(position: InlinePreviewPoint, size: InlinePreviewSize, viewport: InlinePreviewSize): InlinePreviewPoint {
  return { x: Math.min(Math.max(8, viewport.width - size.width - 8), Math.max(8, position.x)), y: Math.min(Math.max(8, viewport.height - size.height - 8), Math.max(8, position.y)) }
}
/** The official main-panel marker plus this chat's actual content is the ownership witness.
 * Never borrow another chat's content or a nested custom panel merely sharing data-phase. */
function inlineConversationScope(anchor: HTMLElement, chat: string): { root?: HTMLElement; blocked?: HTMLElement } {
  for (let node: HTMLElement | null = anchor.parentElement; node; node = node.parentElement) {
    if (!phases.has(node.getAttribute('data-phase') ?? '')) continue
    const contents = [...node.querySelectorAll<HTMLElement>('[data-conversation-content][data-conversation-session]')].filter(content => content.closest('[data-phase]') === node)
    if (contents.length === 1 && contents[0]!.getAttribute('data-conversation-session') === chat) return { root: node }
    // An identified main root for another chat is a boundary, never a reason to climb outward.
    if (contents.length) return { blocked: node }
  }
  return {}
}
export function inlineConversationRoot(anchor: HTMLElement, chat: string): HTMLElement | undefined { return inlineConversationScope(anchor, chat).root }
export function inlinePreviewBounds(anchor: HTMLElement, chat: string): InlinePreviewBounds {
  const view = anchor.ownerDocument.defaultView, width = Math.max(0, finite(view?.innerWidth ?? 0)), height = Math.max(0, finite(view?.innerHeight ?? 0)), scope = inlineConversationScope(anchor, chat), root = scope.root
  if (scope.blocked) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  if (!root) return { left: 0, top: 0, right: width, bottom: height, width, height }
  const box = root.getBoundingClientRect(), left = Math.min(width, Math.max(0, finite(box.left))), top = Math.min(height, Math.max(0, finite(box.top))), right = Math.max(left, Math.min(width, finite(box.right))), bottom = Math.max(top, Math.min(height, finite(box.bottom)))
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}
/** A very narrow known panel shrinks the frame; an unknown custom root retains viewport compatibility. */
export function containInlinePreview(position: InlinePreviewPoint, size: InlinePreviewSize, bounds: InlinePreviewBounds): InlinePreviewPoint & { maxWidth: number; maxHeight: number } {
  const insetX = Math.min(8, bounds.width / 2), insetY = Math.min(8, bounds.height / 2), maxWidth = Math.max(0, bounds.width - insetX * 2), maxHeight = Math.max(0, bounds.height - insetY * 2), width = Math.min(maxWidth, Math.max(0, finite(size.width))), height = Math.min(maxHeight, Math.max(0, finite(size.height)))
  return { x: Math.max(bounds.left + insetX, Math.min(bounds.right - insetX - width, finite(position.x))), y: Math.max(bounds.top + insetY, Math.min(bounds.bottom - insetY - height, finite(position.y))), maxWidth, maxHeight }
}
export function inlinePreviewLayout(anchor: HTMLElement, card: HTMLElement | null, chat: string, point: InlinePreviewPoint) {
  const box = card?.getBoundingClientRect()
  return containInlinePreview(point, { width: box?.width || 300, height: box?.height || 180 }, inlinePreviewBounds(anchor, chat))
}
/** Root + frame ResizeObserver covers dock/split sizing. Layout mutations and capture scroll
 * cover translations with unchanged size. Reads are bounded to this own panel's geometry. */
export function observeInlinePreviewLayout(anchor: HTMLElement, card: HTMLElement | null, chat: string, changed: () => void): () => void {
  const view = anchor.ownerDocument.defaultView
  if (!view) return () => {}
  let live = true
  const notify = () => { if (live && anchor.isConnected) changed() }, scope = inlineConversationScope(anchor, chat), root = scope.root ?? scope.blocked, resized = typeof ResizeObserver === 'function' ? new ResizeObserver(notify) : undefined
  const nodes = new Set<HTMLElement>([anchor, ...(root ? [root] : []), ...(card ? [card] : [])])
  for (const node of nodes) resized?.observe(node)
  // Native layout can move a fixed preview's panel without resizing that panel.
  const mutated = new view.MutationObserver(records => { if (records.some(record => record.type === 'childList' || record.target !== card)) notify() })
  if (root) {
    for (let node = root.parentElement; node; node = node.parentElement) mutated.observe(node, { attributes: true, attributeFilter: ['class', 'style'] })
    mutated.observe(root.parentElement ?? root, { attributes: true, childList: true, subtree: true, attributeFilter: ['class', 'style', 'data-phase', 'data-conversation-session'] })
  }
  view.addEventListener('resize', notify); view.addEventListener('scroll', notify, true)
  return () => { live = false; resized?.disconnect(); mutated.disconnect(); view.removeEventListener('resize', notify); view.removeEventListener('scroll', notify, true) }
}
