import type { RunReadScope } from '../acceptance-runs/service.ts';
export interface WorkflowDrainAgent {
    readonly status: 'idle' | 'running';
    readonly inbox: {
        readonly nextTurn: readonly unknown[];
        readonly nextStep: readonly unknown[];
    };
    whenIdle(): Promise<void>;
}
export interface AgentDrainFacts {
    readonly agentIdle: boolean | null;
    readonly inboxEmpty: boolean | null;
}
/** Host-only actual Agent drain. status=idle alone cannot attest maintenance quiescence. */
export async function waitForWorkflowAgentDrain(agent: WorkflowDrainAgent, scope: RunReadScope, assertIdentity: () => void, deadlineAt: number): Promise<AgentDrainFacts> {
    const guard = () => { scope.signal.throwIfAborted(); scope.assertCurrent(); assertIdentity(); };
    const inboxEmpty = () => agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0;
    guard();
    const remaining = Math.floor(deadlineAt - Date.now());
    if (remaining <= 0)
        return { agentIdle: null, inboxEmpty: inboxEmpty() };
    const deadline = AbortSignal.timeout(remaining), signal = AbortSignal.any([scope.signal, deadline]);
    let abort = () => { }, settled = false;
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
    try {
        guard();
        signal.throwIfAborted();
        await Promise.race([agent.whenIdle(), cancelled]);
        settled = true;
    }
    catch (error) {
        guard();
        if (!deadline.aborted)
            throw error;
    }
    finally {
        signal.removeEventListener('abort', abort);
    }
    guard();
    // Snapshot only this captured Agent; preserved pending user work is never deleted to make this green.
    return { agentIdle: settled ? agent.status === 'idle' : null, inboxEmpty: inboxEmpty() };
}
