/** Public Host SDK proof; not imported into the Client graph. */
import type { SystemPrompt, AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
import type { ToolRuntime, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ComputerRoutingServices } from '../../src/features/computer-use/tool-routing.ts'
declare const prompt: SystemPrompt
declare const tools: ToolRuntime
declare const context: AssembleContext
declare const execution: ToolExecution
const promptFace: ComputerRoutingServices['systemPrompt'] = prompt
const toolsFace: ComputerRoutingServices['tools'] = tools
declare const section: Parameters<ComputerRoutingServices['systemPrompt']['section']>[0]
declare const guard: Parameters<ComputerRoutingServices['tools']['guard']>[0]
section.text(context)
guard(execution)
void [promptFace, toolsFace]
