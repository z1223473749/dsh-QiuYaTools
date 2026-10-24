/** Compile-only proof using public installed SDK types; no ambient declaration replacements. */
import type {AgentRegistry} from '@deepseek-ai/dsh-agent'
import type {ToolRuntime,ToolRunContext} from '@deepseek-ai/dsh-tools'
import type {ProfileContext} from '@deepseek-ai/dsh-app-boot'
import type {SessionQueryEngine} from '@deepseek-ai/dsh-session-query'
import type {WorkflowAgents,WorkflowIntegrationOptions} from '../../src/features/acceptance-workflows/integration.ts'
import type {RunToolsService,RunProfile,RunSessionQuery} from '../../src/features/acceptance-runs/sdk-host-seams.ts'
import type {RunExec} from '../../src/features/acceptance-runs/service.ts'
import type {ModelTargetRegistry} from '../../src/features/workbench/model-target.ts'
import type {WorkflowTarget} from '../../src/features/acceptance-workflows/service.ts'
declare const agents:AgentRegistry
const face:WorkflowAgents=agents
const actual=agents.roots()[0]
actual?.cancel({kind:'user'},{keepInbox:true})
declare const tools:ToolRuntime
const toolFace:RunToolsService=tools
declare const profile:ProfileContext
const profileFace:RunProfile=profile
declare const query:SessionQueryEngine
const queryFace:RunSessionQuery=query
declare const exec:ToolRunContext
const runExec:RunExec=exec
declare const target:ModelTargetRegistry
const device=target.captureTarget(exec,()=>actual?.cancel({kind:'user'},{keepInbox:true}));
const opaque:WorkflowTarget={...device,async settleAgent(){await actual?.whenIdle();return{agentIdle:actual?.status==='idle',inboxEmpty:!!actual&&actual.inbox.nextTurn.length===0&&actual.inbox.nextStep.length===0}}}
const admission:WorkflowIntegrationOptions['target']=target
void[face,toolFace,profileFace,queryFace,runExec,opaque,admission]
