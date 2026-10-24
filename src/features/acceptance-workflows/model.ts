import { parseWorkflowRecord } from './contract.ts';
import { parseRunView } from '../acceptance-runs/model.ts';
import type { WorkflowView } from './contract.ts';
import { object, text, integer, uuid, enumeration } from '../acceptance-runs/contract.ts';
import { runToolValue } from '../acceptance-runs/model.ts';
export interface WorkflowSummary {
    workflowId: string;
    chatSessionId: string;
    revision: number;
    title: string;
    phase: string;
    readOnly: boolean;
    runId: string | null;
}
export function workflowSummary(view: WorkflowView): WorkflowSummary { const r = view.record; return { workflowId: r.workflowId, chatSessionId: r.chatSessionId, revision: r.revision, title: r.plan.title, phase: r.phase, readOnly: view.readOnly, runId: r.runId }; }
export function parseWorkflowSummary(input: unknown): WorkflowSummary {
    const v = object(input, ['workflowId', 'chatSessionId', 'revision', 'title', 'phase', 'readOnly', 'runId']);
    if (typeof v.readOnly !== 'boolean')
        throw Error('INVALID_WORKFLOW_META');
    return { workflowId: uuid(v.workflowId), chatSessionId: text(v.chatSessionId), revision: integer(v.revision, 128, 1), title: text(v.title, 160), phase: enumeration(v.phase, ['draft', 'discarded', 'running', 'awaitingRepair', 'cancelRequested', 'closed', 'interrupted']), readOnly: v.readOnly, runId: v.runId === null ? null : uuid(v.runId) };
}
export function workflowToolValue(view: WorkflowView) { return { workflow: { ...workflowSummary(view), plan: view.record.plan, planSHA256: view.record.planSHA256, repairs: view.record.repairs, authorizedAttempts: view.record.authorizedAttempts, cancel: view.record.cancel, recovery: view.recovery }, ...(view.run ? { run: runToolValue(view.run) } : {}) }; }
export function workflowMeta(input: unknown): WorkflowSummary | undefined {
    try {
        const v = object(input, ['kind', 'version', 'workflow']);
        if (v.kind !== 'qiuya-workflow' || v.version !== 1)
            return;
        return parseWorkflowSummary(v.workflow);
    }
    catch {
        return undefined;
    }
}
export const WORKFLOW_ENDPOINT = 'qiuya-tools.acceptance-workflows';
export function parseWorkflowView(input: unknown): WorkflowView {
    const v = object(input, ['record', 'run', 'readOnly', 'replayPermitted', 'recovery']);
    if (typeof v.readOnly !== 'boolean' || v.replayPermitted !== false)
        throw Error('INVALID_WORKFLOW_VIEW');
    const record = parseWorkflowRecord(v.record), run = v.run === undefined ? undefined : parseRunView(v.run);
    if (run && (run.record.runId !== record.runId || run.record.binding.chatSessionId !== record.chatSessionId))
        throw Error('INVALID_WORKFLOW_VIEW');
    return { record, ...(run ? { run } : {}), readOnly: v.readOnly, replayPermitted: false, recovery: enumeration(v.recovery, ['none', 'restart-interrupted', 'target-changed', 'cancel-unconfirmed']) };
}
