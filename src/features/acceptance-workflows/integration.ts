import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { randomUUID } from 'node:crypto';
import { hostServiceIdentity } from '../../host-service-identity.ts';
import type { RunExec, RunReadScope } from '../acceptance-runs/service.ts';
import type { RunProfile, RunSessionQuery } from '../acceptance-runs/sdk-host-seams.ts';
import type { ModelTargetRegistry } from '../workbench/model-target.ts';
import { RunError } from '../acceptance-runs/contract.ts';
import { WorkflowStore } from './storage.ts';
import { AcceptanceWorkflowService, type WorkflowOptions } from './service.ts';
import { WorkflowEvidenceVerifier } from './verifier.ts';
import { installAcceptanceWorkflowHost } from './host.ts';
import { installAcceptanceWorkflowTools } from './tools.ts';
import { waitForWorkflowAgentDrain, type WorkflowDrainAgent } from './agent-drain.ts';
export interface WorkflowAgent extends WorkflowDrainAgent {
    readonly id: string;
    cancel(cause: {
        kind: 'user';
    }, options?: {
        keepInbox?: boolean;
    }): void;
}
export interface WorkflowAgents {
    get(id: SessionId): WorkflowAgent | undefined;
    roots(): readonly WorkflowAgent[];
}
interface Connection {
    browserPeer?: {
        principal: {
            kind: string;
        };
    };
}
export interface WorkflowIntegrationOptions {
    enabled(): boolean;
    target: Pick<ModelTargetRegistry, 'captureTarget'>;
    verifier: WorkflowEvidenceVerifier;
    ledger: WorkflowOptions['h1'];
}
/** Reuses the real root Agent, public cancellation, exact H2 selection and H1 evidence ledger. */
export async function installAcceptanceWorkflows(ctx: Context, options: WorkflowIntegrationOptions) {
    const agents = ctx.get('agents') as WorkflowAgents | undefined, profile = ctx.get('profileContext') as RunProfile | undefined, query = ctx.get('sessionQuery') as RunSessionQuery | undefined, connection = ctx.get('connection') as Connection | undefined;
    const connectionIdentity = hostServiceIdentity(connection);
    if (!agents || !profile?.dir || !query || !connection || !connectionIdentity)
        throw new RunError('WORKFLOW_SERVICES_UNAVAILABLE');
    const instances = new WeakMap<object, string>(), lifetime = new AbortController();
    let disposed = false;
    const live = () => {
        if (disposed || lifetime.signal.aborted || !options.enabled())
            throw new RunError('WORKFLOW_DISABLED');
    };
    const authenticate = (exec: RunExec) => {
        live();
        exec.signal.throwIfAborted();
        const agent = exec.agent && agents.get(SessionId(exec.agent.id));
        if (!agent || agent !== exec.agent || !agents.roots().includes(agent))
            throw new RunError('CALLER_NOT_LIVE');
        let instanceId = instances.get(agent);
        if (!instanceId) {
            instanceId = randomUUID();
            instances.set(agent, instanceId);
        }
        return { agent, instanceId, chatSessionId: agent.id, assertCurrent() {
                live();
                if (agents.get(SessionId(agent.id)) !== agent || !agents.roots().includes(agent))
                    throw new RunError('CALLER_NOT_LIVE');
            } };
    };
    const service = new AcceptanceWorkflowService({ enabled: options.enabled, authenticate, capture(exec) {
            const owner = authenticate(exec);
            const agent = agents.get(SessionId(owner.chatSessionId))!;
            let cancelIssued = false;
            const target = options.target.captureTarget(exec, () => { owner.assertCurrent(); agent.cancel({ kind: 'user' }, { keepInbox: true }); cancelIssued = true; });
            return { ...target, async settleAgent(scope, deadlineAt) {
                    if (!cancelIssued)
                        return { agentIdle: null, inboxEmpty: null };
                    return waitForWorkflowAgentDrain(agent, scope, () => owner.assertCurrent(), deadlineAt);
                } };
        }, store: new WorkflowStore({ profileDirectory: profile.dir }), verifier: options.verifier, h1: options.ledger });
    const resolveScope = async (chatSessionId: string, signal: AbortSignal): Promise<RunReadScope> => {
        const peer = connection.browserPeer, principal = peer?.principal;
        const current = () => {
            live();
            signal.throwIfAborted();
            if (hostServiceIdentity(ctx.get('connection')) !== connectionIdentity || connection.browserPeer !== peer || peer?.principal !== principal || principal?.kind !== 'owner')
                throw new RunError('OWNER_CHANGED');
        };
        current();
        const child = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(2000)]);
        let abort = () => { };
        const canceled = new Promise<never>((_, reject) => { abort = () => reject(new RunError('READ_CANCELLED')); child.addEventListener('abort', abort, { once: true }); });
        try {
            const observation = await Promise.race([query.observeSession(SessionId(chatSessionId), { signal: child, projectionMode: 'none' }).then(value => {
                    if (child.aborted) {
                        value[Symbol.dispose]();
                        throw new RunError('READ_CANCELLED');
                    }
                    return value;
                }), canceled]);
            try {
                current();
                if (observation.header.id !== chatSessionId)
                    throw new RunError('WORKFLOW_NOT_FOUND');
            }
            finally {
                observation[Symbol.dispose]();
            }
        }
        finally {
            child.removeEventListener('abort', abort);
        }
        current();
        return { chatSessionId, signal, assertCurrent: current };
    };
    let removeTools: (() => void) | undefined, removeHost: (() => Promise<void>) | undefined;
    try {
        removeHost = installAcceptanceWorkflowHost(ctx, service, { resolveScope });
        removeTools = installAcceptanceWorkflowTools(ctx, service);
    }
    catch (error) {
        service.dispose();
        lifetime.abort();
        const failures = [error];
        try {
            removeTools?.();
        }
        catch (failure) {
            failures.push(failure);
        }
        ;
        try {
            await removeHost?.();
        }
        catch (failure) {
            failures.push(failure);
        }
        ;
        throw new AggregateError(failures, '自动验收初始化未完成。');
    }
    let enabled = options.enabled();
    const poll = setInterval(() => {
        const next = options.enabled();
        if (enabled && !next)
            service.interruptAll();
        enabled = next;
    }, 100);
    poll.unref();
    return { service, async dispose() {
            if (disposed)
                return;
            disposed = true;
            lifetime.abort();
            clearInterval(poll);
            service.dispose();
            const failures: unknown[] = [];
            for (const work of [() => removeTools?.(), () => removeHost?.()])
                try {
                    await work();
                }
                catch (error) {
                    failures.push(error);
                }
            if (failures.length)
                throw new AggregateError(failures, '自动验收清理未完成。');
        } };
}
