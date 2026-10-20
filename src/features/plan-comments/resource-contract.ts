import type { SubmittedPlan } from './plan.ts'
import type {} from '@deepseek-ai/dsh-client-resources/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    plan: SubmittedPlan
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'plan/invalid-address': Record<string, never>
    'plan/unavailable': Record<string, never>
    'plan/not-found': Record<string, never>
    'plan/read-failed': Record<string, never>
  }
}
