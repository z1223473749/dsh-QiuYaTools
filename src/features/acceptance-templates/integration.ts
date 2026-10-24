import { currentModelObservationGeneration } from '../computer-use/model-observation.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { RunProfile } from '../acceptance-runs/sdk-host-seams.ts';
import type { RunReadScope, RunExec } from '../acceptance-runs/service.ts';
import type { AcceptanceWorkflowService, WorkflowIdentity } from '../acceptance-workflows/service.ts';
import type { ModelTargetRegistry } from '../workbench/model-target.ts';
import { RunError } from '../acceptance-runs/contract.ts';
import { TemplateStore } from './storage.ts';
import { AcceptanceTemplateService } from './service.ts';
import { installAcceptanceTemplateHost } from './host.ts';
import { installAcceptanceTemplateTools } from './tools.ts';
export interface TemplateIntegrationOptions {
    enabled(): boolean;
    workflows: AcceptanceWorkflowService;
    authenticate(exec: RunExec): WorkflowIdentity;
    resolveOwnerScope(chat: string, signal: AbortSignal): Promise<RunReadScope>;
    modelTarget: Pick<ModelTargetRegistry, 'runEnvironment' | 'modelObservationGeneration'>;
}
export async function installAcceptanceTemplates(ctx: Context, options: TemplateIntegrationOptions) {
    const profile = ctx.get('profileContext') as RunProfile | undefined;
    if (!profile?.dir)
        throw new RunError('TEMPLATE_SERVICES_UNAVAILABLE');
    let disposed = false;
    const service = new AcceptanceTemplateService({ enabled: () => !disposed && options.enabled(), authenticate: options.authenticate, workflows: options.workflows, store: new TemplateStore({ profileDirectory: profile.dir }), observationGeneration: currentModelObservationGeneration, observation(identity) {
            identity.assertCurrent();
            const environment = options.modelTarget.runEnvironment(identity.chatSessionId);
            const observationGeneration = options.modelTarget.modelObservationGeneration(identity.chatSessionId);
            identity.assertCurrent();
            if (!environment?.observation || observationGeneration === undefined || environment.observation.targetId !== environment.target.id)
                return null;
            return { environmentId: environment.environmentId, epoch: environment.epoch, targetId: environment.target.id, frameId: environment.observation.frameId, observationGeneration };
        } });
    let removeHost: (() => Promise<void>) | undefined, removeTools: (() => void) | undefined;
    const dispose = async () => { if (disposed)
        return; disposed = true; service.dispose(); const errors: unknown[] = []; for (const work of [() => removeTools?.(), () => removeHost?.()])
        try {
            await work();
        }
        catch (error) {
            errors.push(error);
        } if (errors.length)
        throw new AggregateError(errors, '验收模板清理尚未确认。'); };
    try {
        removeHost = installAcceptanceTemplateHost(ctx, service, { resolveScope: options.resolveOwnerScope });
        removeTools = installAcceptanceTemplateTools(ctx, service);
    }
    catch (error) {
        service.dispose();
        disposed = true;
        const errors = [error];
        try {
            removeTools?.();
        }
        catch (failure) {
            errors.push(failure);
        }
        try {
            await removeHost?.();
        }
        catch (failure) {
            errors.push(failure);
        }
        throw new AggregateError(errors, '验收模板初始化未完成。');
    }
    return { service, dispose };
}
