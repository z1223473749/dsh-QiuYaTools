/** Narrow adapter from the public Chat node identities to their rendered prose. */
import type { ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'

export interface ConversationMessageContent {
  readonly messageId: string
  /** Original assistant block index, retained when reasoning is folded or omitted. */
  readonly contentId: string
  readonly root: HTMLElement
}

const CONVERSATION_BOUNDARY = '[data-slot="main.conversation"]'

/**
 * Match only finalized text blocks inside the explicitly supplied conversation.
 * The host owns every node and its Markdown. A changed or ambiguous DOM shape
 * produces no match instead of attaching a comment to a neighboring message.
 */
export function discoverConversationMessages(container: HTMLElement, snapshot: Pick<ChatSnapshot, 'nodes'> | undefined): readonly ConversationMessageContent[] {
  if (snapshot === undefined) return []
  const found: ConversationMessageContent[] = []
  const boundary = container.closest(CONVERSATION_BOUNDARY)
  const rows = container.querySelectorAll<HTMLElement>('[data-chat-flow-kind="assistant-step"][data-chat-node-key]')
  for (const row of rows) {
    if (row.closest(CONVERSATION_BOUNDARY) !== boundary
      || row.dataset.chatGroupPart === 'reasoning'
      || row.closest('[hidden], [aria-hidden="true"], [data-turn-process-hidden="true"]') !== null) continue
    const key = row.dataset.chatNodeKey
    if (key === undefined) continue
    const node = snapshot.nodes.get(key) as ChatNode | undefined
    if (node?.kind !== 'assistant-step' || node.key !== key || node.visibility === 'hidden'
      || node.data.status === 'running' || node.data.finalNode?.messageId === undefined) continue

    // The public slot renderer inserts one display:contents anchor between
    // ChatNodeSeat and AssistantMarkdown. Accept that exact seat, as well as
    // the direct renderer shape, without traversing other nested slot owners.
    let wrapper = row.firstElementChild
    if (wrapper?.hasAttribute('data-slot')) {
      if (wrapper.getAttribute('data-slot') !== 'conversation.chat.node'
        || !(wrapper instanceof container.ownerDocument.defaultView!.HTMLElement)
        || wrapper.style.display !== 'contents' || wrapper.children.length !== 1) continue
      wrapper = wrapper.firstElementChild
    }
    // Reasoning has its own data-turn-process-inline wrapper and must never
    // become a selectable conversation-comment document.
    const body = wrapper?.firstElementChild
    if (wrapper === null || wrapper === undefined || body === null || body === undefined
      || wrapper.hasAttribute('data-streaming') || body.tagName !== 'DIV') continue
    const markdown = Array.from(body.children).filter(element =>
      element.tagName === 'DIV' && /markdown/iu.test(element.className)
      && !element.hasAttribute('data-turn-process-inline')) as HTMLElement[]
    const textBlocks = node.data.blocks.flatMap((block, index) => block.kind === 'text' ? [index] : [])
    if (markdown.length !== textBlocks.length) continue
    for (let index = 0; index < textBlocks.length; index++) {
      const root = markdown[index]
      const blockIndex = textBlocks[index]
      if (root === undefined || blockIndex === undefined) continue
      found.push({ messageId: String(node.data.finalNode.messageId), contentId: `text:${blockIndex}`, root })
    }
  }
  return found
}

// The plan adapter operates on one Markdown-only root and already excludes
// generated code banners, controls and decorative icons from text coordinates.
export {
  renderedPlanText as renderedConversationText,
  selectionPlanAnchor as selectionConversationAnchor,
  planTextRange as conversationTextRange,
  planHighlightRanges as conversationHighlightRanges,
} from '../plan-comments/comment-dom.ts'
export type { PlanTextAnchor as ConversationTextAnchor } from '../plan-comments/comment-dom.ts'
