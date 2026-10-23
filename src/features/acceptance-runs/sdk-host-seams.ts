/** Used public SDK members only. Host-only Context augmentations stay in tests/types, out of the Client graph.
 * tests/types/acceptance-runs-sdk.ts checks real SDK assignability with skipLibCheck:false.
 * These are local capability interfaces, not ambient replacements for SDK declarations. */
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm/types'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools/presentation'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment/types'
import type { RunExec } from './service.ts'
export interface RootAgentRegistry {
  get(id: SessionId): { readonly id: string } | undefined
  roots(): ReadonlyArray<{ readonly id: string }>
}
export interface RunAttachmentStore { readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> }
export interface RunProfile { readonly dir: string }
export interface RunSessionQuery {
  observeSession(id: SessionId, options: { signal?: AbortSignal; projectionMode: 'none' }): Promise<{ readonly header: { readonly id: SessionId }; [Symbol.dispose](): void }>
}
/** The schema subset actually emitted below; the real SDK checks both type compatibility and runtime admission. */
export interface RunJsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  oneOf?: RunJsonSchema[]
  properties?: Record<string, RunJsonSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: RunJsonSchema
  enum?: Array<string | number | boolean | null>
  description?: string
}
export interface RunToolDefinition extends ToolSchema {
  output: { schema: RunJsonSchema; render(args: unknown, value: JsonValue): ContentBlock[]; presentationMeta?(args: unknown, value: JsonValue): JsonValue }
  execute(args: unknown, exec: RunExec): Promise<unknown>
  presentCall?(args: unknown): ToolCallView | undefined
  presentResult?(args: unknown, result: { isError: boolean; meta?: JsonValue }): ToolResultView | undefined
}
export interface RunToolsService { register(definition: RunToolDefinition): () => void }
