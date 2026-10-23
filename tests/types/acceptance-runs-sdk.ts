/** Compile-only public SDK proof. This file is not imported by production or the Client graph. */
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { ToolDefinition, ToolRuntime, ToolRunContext, JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { RootAgentRegistry, RunProfile, RunAttachmentStore, RunSessionQuery, RunToolDefinition, RunToolsService, RunJsonSchema } from '../../src/features/acceptance-runs/sdk-host-seams.ts'
import type { RunExec } from '../../src/features/acceptance-runs/service.ts'
import type { ComputerToolsRecorder } from '../../src/features/computer-use/tools.ts'
declare const agents: AgentRegistry
declare const profile: ProfileContext
declare const attachments: AttachmentStore
declare const query: SessionQueryEngine
declare const tools: ToolRuntime
declare const definition: RunToolDefinition
declare const schema: RunJsonSchema
declare const exec: ToolRunContext
const registryFace: RootAgentRegistry = agents
const profileFace: RunProfile = profile
const attachmentFace: RunAttachmentStore = attachments
const queryFace: RunSessionQuery = query
const toolsFace: RunToolsService = tools
const admittedDefinition: ToolDefinition = definition
const admittedSchema: JsonSchemaNode = schema
const actualExec: RunExec = exec
declare const recorder: ComputerToolsRecorder
recorder.issuing(exec, { actionId: 'proof-only', frameId: 'proof-only', action: { kind: 'move', x: 0, y: 0 } })
void [registryFace, profileFace, attachmentFace, queryFace, toolsFace, admittedDefinition, admittedSchema, actualExec]
