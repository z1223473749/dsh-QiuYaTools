/** Compile-only proof against the installed, exported Session API and generated remote augmentation. */
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type { SessionBinding, ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { AnnotationSubmissionOptions } from '../../src/features/annotations/submission.ts'
import type { AnnotationAnchor } from '../../src/features/annotations/contract.ts'
declare const sessions: ISessions
declare const binding: SessionBinding
declare const signal: AbortSignal
declare const anchor: AnnotationAnchor
declare const verifyCurrent: (a: AnnotationAnchor, signal: AbortSignal) => Promise<AnnotationAnchor>
const options: AnnotationSubmissionOptions = {
  currentChat: () => binding.sessionId,
  binding: chat => chat === binding.sessionId ? sessions.binding(binding.sessionId) : undefined,
  currentAnchor: () => anchor,
  verifyCurrent,
  signal,
}
void options
