/** Cleanup annotations only when an ordinary user message is recorded. */
import { useEffect } from 'react'
import type { InjectFace, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { createPlanCommentsStore } from './plan-comments.ts'

/** Session-bound observation of recorded user submissions. */
export interface PlanRevisionReceiptInjected {
  /** Observe recorded user text, including a restored successful submission. */
  watchSubmitted: (onSubmitted: (text: string, seq: number) => void) => () => void
}

/**
 * Retain comments through failed sends and queue admission.
 * @param props - Framework-bound comment store and durable submission observer.
 * @returns no additional input or review UI.
 */
export function PlanRevisionReceipt({ actions, watchSubmitted }: PropsStore<ReturnType<typeof createPlanCommentsStore>> & InjectFace<PlanRevisionReceiptInjected>) {
  useEffect(() => watchSubmitted(actions.confirmSubmitted), [actions, watchSubmitted])
  return null
}
