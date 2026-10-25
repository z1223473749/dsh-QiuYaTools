/** The operation ID is opaque and remains separate from the owning SDK chat. */
export interface ComputerTaskIdentity { chatSessionId: string; taskId: string; taskLabel?: string }

/** Legacy default tasks keep their original sessionId; additional tasks must
 * carry both the owner chat and the exact operation ID returned by the Host. */
export function isComputerTaskForChat(snapshot: { sessionId?: unknown; chatSessionId?: unknown; taskId?: unknown } | null | undefined, chatSessionId: string): boolean {
  return !!snapshot && (snapshot.sessionId === chatSessionId || snapshot.chatSessionId === chatSessionId && typeof snapshot.taskId === 'string' && snapshot.taskId === snapshot.sessionId)
}
