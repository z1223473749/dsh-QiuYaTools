import { uuid, integer } from '../acceptance-runs/contract.ts';
import { parseWorkflowView, WORKFLOW_ENDPOINT } from './model.ts';
import type { WorkflowView, WorkflowPlan } from './contract.ts';
import type { RunReadConnection } from '../acceptance-runs/client-api.ts';
export interface WorkflowAPI {
    get(chat: string, id: string, signal: AbortSignal): Promise<WorkflowView>;
    edit(chat: string, id: string, revision: number, plan: WorkflowPlan, signal: AbortSignal): Promise<WorkflowView>;
    repair(chat: string, id: string, revision: number, requestId: string, allowed: boolean, signal: AbortSignal): Promise<WorkflowView>;
    cancel(chat: string, id: string, revision: number, signal: AbortSignal): Promise<WorkflowView>;
}
export function createWorkflowAPI(connection: () => RunReadConnection | undefined): WorkflowAPI {
    async function call(op: string, chatSessionId: string, id: string, signal: AbortSignal, extra: Record<string, unknown> = {}) {
        signal.throwIfAborted();
        const peer = connection();
        if (!peer)
            throw Error('连接尚未就绪');
        const value = await peer.rpc.call('/api', WORKFLOW_ENDPOINT, { op, chatSessionId, workflowId: uuid(id), ...extra }, signal);
        signal.throwIfAborted();
        if (connection() !== peer || !value.ok)
            throw Error('验收任务已变化，请刷新后查看。');
        const view = parseWorkflowView(value.value);
        if (view.record.chatSessionId !== chatSessionId || view.record.workflowId !== id)
            throw Error('验收任务已变化');
        return view;
    }
    return { get: (chat, id, signal) => call('get', chat, id, signal), edit: (chat, id, revision, plan, signal) => call('edit', chat, id, signal, { expectedRevision: integer(revision, 128, 1), plan }), repair: (chat, id, revision, requestId, allowed, signal) => call('repair', chat, id, signal, { expectedRevision: integer(revision, 128, 1), requestId: uuid(requestId), allowed }), cancel: (chat, id, revision, signal) => call('cancel', chat, id, signal, { expectedRevision: integer(revision, 128, 1) }) };
}
