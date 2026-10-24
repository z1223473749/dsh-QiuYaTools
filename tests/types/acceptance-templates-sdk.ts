/** Compile-only assignments to real public Host and ToolRuntime contracts. No declaration stubs. */
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRuntime, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
import type { RunToolsService } from '../../src/features/acceptance-runs/sdk-host-seams.ts';
import type { TemplateIntegrationOptions } from '../../src/features/acceptance-templates/integration.ts';
import { installAcceptanceTemplateTools } from '../../src/features/acceptance-templates/tools.ts';
import type { ModelTargetRegistry } from '../../src/features/workbench/model-target.ts';
import type { installAcceptanceWorkflows } from '../../src/features/acceptance-workflows/integration.ts';
declare const ctx: Context, tools: ToolRuntime, exec: ToolRunContext, connection: HostConnectionService, target: ModelTargetRegistry;
declare const workflow: Awaited<ReturnType<typeof installAcceptanceWorkflows>>;
const toolService: RunToolsService = tools;
const options: TemplateIntegrationOptions = {enabled:()=>true,workflows:workflow.service,authenticate:workflow.authenticate,resolveOwnerScope:workflow.resolveOwnerScope,modelTarget:target};
workflow.authenticate(exec).assertCurrent();
const environment=options.modelTarget.runEnvironment(exec.agent?.id??'');
void[ctx,connection,toolService,environment,installAcceptanceTemplateTools];
