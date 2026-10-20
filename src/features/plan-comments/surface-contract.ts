import type { ReactNode } from 'react'
import type { PendingQuestion, PlanReview } from '@deepseek-ai/dsh-client-ui-user-questions/client'

export interface PlanReviewSurfaceOwner {
  pending: PendingQuestion
  review: PlanReview
  requestKey: string
  preview: ReactNode
  card: ReturnType<PendingQuestion['snapshot']>
  busy: boolean
  error: string | null
  approve: () => void
  dismiss: () => Promise<boolean>
}
