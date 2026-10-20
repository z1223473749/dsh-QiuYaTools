/** Durable user-message acknowledgements for staged plan revisions. */
import type { SessionEventSource, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'

function submittedText(entry: SessionEventLikeEntry): string | undefined {
  if (entry.type !== 'event' || entry.event.type !== 'user/message' || entry.event.data.source.kind !== 'user') return undefined
  return entry.event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

/**
 * Read history once on mount, then consume only the feed's exact deltas.
 * @param source - The Session's contiguous event window.
 * @param onSubmitted - Called only for durably recorded user text.
 * @returns subscription disposer.
 */
export function watchRevisionSubmissions(source: SessionEventSource, onSubmitted: (text: string, seq: number) => void): () => void {
  const inspect = (entries: readonly SessionEventLikeEntry[]): void => {
    for (const entry of entries) {
      const text = submittedText(entry)
      if (text !== undefined) onSubmitted(text, entry.event.seq)
    }
  }
  let revision = source.getSnapshot().revision
  const dispose = source.subscribe(() => {
    const snapshot = source.getSnapshot()
    if (snapshot.revision === revision) return
    revision = snapshot.revision
    if (snapshot.change.kind !== 'settle-assistant') inspect(snapshot.change.entries)
  })
  inspect(source.getSnapshot().entries)
  return dispose
}
