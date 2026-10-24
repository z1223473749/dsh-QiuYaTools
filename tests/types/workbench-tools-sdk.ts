/** Compile-only proof against the actual public SDK. No production declaration replacements. */
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolDefinition, ToolRunContext, ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm/types'
import type { BrowserToolDefinition, BrowserToolServices, BrowserToolsRecorder } from '../../src/features/workbench/tools.ts'
import type { HostWorkbenchContext } from '../../src/features/workbench/browser-registry.ts'
import type { ComputerToolRunContext } from '../../src/features/computer-use/tools.ts'
declare const runtime: ToolRuntime
declare const attachments: AttachmentStore
declare const definition: BrowserToolDefinition
declare const exec: ToolRunContext
declare const image: ImageAttachmentRef
declare const context: HostWorkbenchContext
declare const recorder: BrowserToolsRecorder
const services: BrowserToolServices = { tools: runtime, attachments }
const admittedDefinition: ToolDefinition = definition
const admittedSchema: ToolSchema = definition
const admittedExec: ComputerToolRunContext = exec
const content: ContentBlock = { type: 'image', attachment: image }
recorder.issuing(exec, context, { actionId: 'compile-only', frameId: 'compile-only', action: { kind: 'move', x: 0, y: 0 } })
void [services, admittedDefinition, admittedSchema, admittedExec, content]
