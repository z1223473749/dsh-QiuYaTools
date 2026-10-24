import { object, text, key, uuid, integer, enumeration, array, parseBudget, canonicalJSON, RunError } from '../acceptance-runs/contract.ts';
import type { RunBudget, RunView } from '../acceptance-runs/contract.ts';
export const WORKFLOW_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_VERIFIER_ID = 'qiuya-workflow-observation-v1';
export type WorkflowRule = {
    kind: 'nativeText';
    expected: string;
    failure: string | null;
} | {
    kind: 'browserValue';
    role: string;
    name: string;
    expected: string;
} | {
    kind: 'unavailable';
    reason: string;
};
export interface WorkflowCheck {
    checkId: string;
    title: string;
    expected: string;
    required: boolean;
    minimumEvidence: number;
    rule: WorkflowRule;
}
export interface WorkflowPlan {
    title: string;
    checks: WorkflowCheck[];
    budget: RunBudget;
    maxRepairAttempts: number;
}
export type WorkflowPhase = 'draft' | 'discarded' | 'running' | 'awaitingRepair' | 'cancelRequested' | 'closed' | 'interrupted';
export interface RepairRequest {
    requestId: string;
    checkId: string;
    reason: string;
    state: 'pending' | 'allowed' | 'denied' | 'consumed';
    createdAt: number;
    attemptId: string | null;
}
export interface WorkflowCancellationFacts {
    deviceReleased: boolean | null;
    agentIdle: boolean | null;
    inboxEmpty: boolean | null;
}
export interface WorkflowRecord {
    schemaVersion: 1;
    workflowId: string;
    chatSessionId: string;
    creatorInstanceId: string;
    revision: number;
    phase: WorkflowPhase;
    plan: WorkflowPlan;
    planSHA256: string | null;
    runId: string | null;
    previousWorkflowId: string | null;
    createdAt: number;
    updatedAt: number;
    frozenAt: number | null;
    repairs: RepairRequest[];
    authorizedAttempts: {
        checkId: string;
        attemptId: string;
        repairRequestId: string | null;
    }[];
    cancel: {
        requestedAt: number;
        quiescent: boolean | null;
        facts?: WorkflowCancellationFacts;
    } | null;
}
export interface WorkflowView {
    record: WorkflowRecord;
    run?: RunView;
    readOnly: boolean;
    replayPermitted: false;
    recovery: 'none' | 'restart-interrupted' | 'target-changed' | 'cancel-unconfirmed';
}
export function fail(code: string): never { throw new RunError(code); }
function literal(value: unknown, maximum = 500, empty = false): string {
    if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > maximum || /[\x00-\x1f\x7f]/u.test(value))
        fail('INVALID_RULE');
    return value;
}
export function parseRule(input: unknown): WorkflowRule {
    const v = object(input, ['kind', 'expected', 'failure', 'role', 'name', 'reason']);
    if (v.kind === 'nativeText') {
        object(input, ['kind', 'expected', 'failure']);
        const expected = literal(v.expected), failure = v.failure === null ? null : literal(v.failure);
        if (expected.includes(' | ') || failure?.includes(' | ') || failure === expected)
            fail('INVALID_RULE');
        return { kind: 'nativeText', expected, failure };
    }
    if (v.kind === 'browserValue') {
        object(input, ['kind', 'role', 'name', 'expected']);
        return { kind: 'browserValue', role: literal(v.role, 120), name: literal(v.name, 500, true), expected: literal(v.expected, 4000, true) };
    }
    if (v.kind === 'unavailable') {
        object(input, ['kind', 'reason']);
        return { kind: 'unavailable', reason: literal(v.reason, 300) };
    }
    return fail('INVALID_RULE');
}
export function parseWorkflowCheck(input: unknown): WorkflowCheck {
    const v = object(input, ['checkId', 'title', 'expected', 'required', 'minimumEvidence', 'rule']);
    if (typeof v.required !== 'boolean')
        fail('INVALID_REQUEST');
    return { checkId: key(v.checkId), title: text(v.title, 120), expected: text(v.expected, 500), required: v.required, minimumEvidence: integer(v.minimumEvidence, 8, 1), rule: parseRule(v.rule) };
}
export function parseWorkflowPlan(input: unknown): WorkflowPlan {
    const v = object(input, ['title', 'checks', 'budget', 'maxRepairAttempts']), checks = array(v.checks, parseWorkflowCheck, 32);
    if (!checks.length || !checks.some(c => c.required) || new Set(checks.map(c => c.checkId)).size !== checks.length)
        fail('INVALID_PLAN');
    const budget = parseBudget(v.budget), maxRepairAttempts = integer(v.maxRepairAttempts, 4);
    if (budget.maxAttempts < checks.length || budget.maxEvidence < checks.reduce((sum, c) => sum + c.minimumEvidence, 0))
        fail('INSUFFICIENT_BUDGET');
    return { title: text(v.title, 160), checks, budget, maxRepairAttempts };
}
export function parseWorkflowRecord(input: unknown): WorkflowRecord {
    const v = object(input, ['schemaVersion', 'workflowId', 'chatSessionId', 'creatorInstanceId', 'revision', 'phase', 'plan', 'planSHA256', 'runId', 'previousWorkflowId', 'createdAt', 'updatedAt', 'frozenAt', 'repairs', 'authorizedAttempts', 'cancel']);
    if (v.schemaVersion !== 1)
        fail('UNSUPPORTED_SCHEMA');
    const digest = (value: unknown) => {
        if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
            fail('INVALID_RECORD');
        return value;
    };
    const record: WorkflowRecord = { schemaVersion: 1, workflowId: uuid(v.workflowId), chatSessionId: text(v.chatSessionId), creatorInstanceId: uuid(v.creatorInstanceId), revision: integer(v.revision, 128, 1), phase: enumeration(v.phase, ['draft', 'discarded', 'running', 'awaitingRepair', 'cancelRequested', 'closed', 'interrupted']), plan: parseWorkflowPlan(v.plan), planSHA256: v.planSHA256 === null ? null : digest(v.planSHA256), runId: v.runId === null ? null : uuid(v.runId), previousWorkflowId: v.previousWorkflowId === null ? null : uuid(v.previousWorkflowId), createdAt: integer(v.createdAt), updatedAt: integer(v.updatedAt), frozenAt: v.frozenAt === null ? null : integer(v.frozenAt), repairs: array(v.repairs, raw => { const r = object(raw, ['requestId', 'checkId', 'reason', 'state', 'createdAt', 'attemptId']); return { requestId: uuid(r.requestId), checkId: key(r.checkId), reason: text(r.reason, 600), state: enumeration(r.state, ['pending', 'allowed', 'denied', 'consumed']), createdAt: integer(r.createdAt), attemptId: r.attemptId === null ? null : uuid(r.attemptId) }; }, 4), authorizedAttempts: array(v.authorizedAttempts, raw => { const a = object(raw, ['checkId', 'attemptId', 'repairRequestId']); return { checkId: key(a.checkId), attemptId: uuid(a.attemptId), repairRequestId: a.repairRequestId === null ? null : uuid(a.repairRequestId) }; }, 64), cancel: v.cancel === null ? null : (() => {
            const c = object(v.cancel, ['requestedAt', 'quiescent', 'facts']);
            if (c.quiescent !== null && typeof c.quiescent !== 'boolean')
                fail('INVALID_RECORD');
            let facts: WorkflowCancellationFacts | undefined;
            if (c.facts !== undefined) {
                const f = object(c.facts, ['deviceReleased', 'agentIdle', 'inboxEmpty']);
                for (const value of Object.values(f))
                    if (value !== null && typeof value !== 'boolean')
                        fail('INVALID_RECORD');
                if (!['deviceReleased', 'agentIdle', 'inboxEmpty'].every(key => key in f))
                    fail('INVALID_RECORD');
                facts = { deviceReleased: f.deviceReleased as boolean | null, agentIdle: f.agentIdle as boolean | null, inboxEmpty: f.inboxEmpty as boolean | null };
                if (c.quiescent === true && !Object.values(facts).every(value => value === true))
                    fail('INVALID_RECORD');
            }
            return { requestedAt: integer(c.requestedAt), quiescent: c.quiescent, ...(facts ? { facts } : {}) };
        })() };
    if (['draft', 'discarded'].includes(record.phase) && (record.runId || record.frozenAt || record.planSHA256 || record.repairs.length || record.authorizedAttempts.length || record.cancel))
        fail('INVALID_RECORD');
    if (!['draft', 'discarded'].includes(record.phase) && (!record.runId || record.frozenAt === null || !record.planSHA256))
        fail('INVALID_RECORD');
    if (record.updatedAt < record.createdAt || record.repairs.length > record.plan.maxRepairAttempts || new Set(record.repairs.map(r => r.requestId)).size !== record.repairs.length || new Set(record.authorizedAttempts.map(a => a.attemptId)).size !== record.authorizedAttempts.length)
        fail('INVALID_RECORD');
    const checks = new Set(record.plan.checks.map(c => c.checkId));
    if (record.repairs.some(r => !checks.has(r.checkId)) || record.authorizedAttempts.some(a => !checks.has(a.checkId) || a.repairRequestId !== null && !record.repairs.some(r => r.requestId === a.repairRequestId && r.checkId === a.checkId && r.attemptId === a.attemptId && r.state === 'consumed')))
        fail('INVALID_RECORD');
    return record;
}
export const sameJSON = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
