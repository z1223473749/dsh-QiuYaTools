import { object, text, uuid, integer, array, digest } from '../acceptance-runs/contract.ts';
import { fail, parseWorkflowPlan } from '../acceptance-workflows/contract.ts';
import type { WorkflowPlan, WorkflowView } from '../acceptance-workflows/contract.ts';
export const TEMPLATE_SCHEMA_VERSION = 1 as const;
export const TEMPLATE_ENDPOINT = 'qiuya-tools.acceptance-templates';
export interface TemplateVersion {
    versionId: string;
    number: number;
    label: string;
    createdAt: number;
    plan: WorkflowPlan;
    planSHA256: string;
}
export interface TemplateExecution {
    workflowId: string;
    chatSessionId: string;
    versionId: string;
    versionLabel: string;
    createdAt: number;
}
/** Plan data only. No device/environment/frame/lease/grant, attachments, model verdict or action is persisted. */
export interface TemplateRecord {
    schemaVersion: 1;
    templateId: string;
    revision: number;
    name: string;
    description: string;
    createdAt: number;
    updatedAt: number;
    revokedAt: number | null;
    versions: TemplateVersion[];
    executions: TemplateExecution[];
}
export interface TemplateView {
    record: TemplateRecord;
    readOnly: boolean;
    canPrepare: boolean;
    replayPermitted: false;
}
export function parseTemplateRecord(input: unknown): TemplateRecord {
    const v = object(input, ['schemaVersion', 'templateId', 'revision', 'name', 'description', 'createdAt', 'updatedAt', 'revokedAt', 'versions', 'executions']);
    if (v.schemaVersion !== 1)
        fail('UNSUPPORTED_SCHEMA');
    const versions = array(v.versions, raw => { const r = object(raw, ['versionId', 'number', 'label', 'createdAt', 'plan', 'planSHA256']); return { versionId: uuid(r.versionId), number: integer(r.number, 16, 1), label: text(r.label, 80), createdAt: integer(r.createdAt), plan: parseWorkflowPlan(r.plan), planSHA256: digest(r.planSHA256) }; }, 16);
    const executions = array(v.executions, raw => { const r = object(raw, ['workflowId', 'chatSessionId', 'versionId', 'versionLabel', 'createdAt']); return { workflowId: uuid(r.workflowId), chatSessionId: text(r.chatSessionId), versionId: uuid(r.versionId), versionLabel: text(r.versionLabel, 120), createdAt: integer(r.createdAt) }; }, 64);
    const record: TemplateRecord = { schemaVersion: 1, templateId: uuid(v.templateId), revision: integer(v.revision, 256, 1), name: text(v.name, 120), description: typeof v.description === 'string' && v.description === '' ? '' : text(v.description, 500), createdAt: integer(v.createdAt), updatedAt: integer(v.updatedAt), revokedAt: v.revokedAt === null ? null : integer(v.revokedAt), versions, executions };
    if (!versions.length || new Set(versions.map(x => x.versionId)).size !== versions.length || versions.some((x, i) => x.number !== i + 1 || x.createdAt < record.createdAt) || new Set(executions.map(x => x.workflowId)).size !== executions.length || executions.some(x => !versions.some(v => v.versionId === x.versionId)) || record.updatedAt < record.createdAt || record.revokedAt !== null && record.revokedAt < record.createdAt)
        fail('INVALID_TEMPLATE');
    return record;
}
export function parseTemplateView(input: unknown): TemplateView { const v = object(input, ['record', 'readOnly', 'canPrepare', 'replayPermitted']); if (typeof v.readOnly !== 'boolean' || typeof v.canPrepare !== 'boolean' || v.replayPermitted !== false)
    fail('INVALID_TEMPLATE'); const record = parseTemplateRecord(v.record); if ((record.revokedAt !== null || v.readOnly) && v.canPrepare)
    fail('INVALID_TEMPLATE'); return { record, readOnly: v.readOnly, canPrepare: v.canPrepare, replayPermitted: false }; }
export interface TemplatePrepared {
    template: TemplateView;
    versionId: string;
    versionLabel: string;
    workflow: WorkflowView;
    requiresFreshObservation: true;
}
export interface TemplateComparison {
    readOnly: true;
    replayPermitted: false;
    left: WorkflowView;
    right: WorkflowView;
    leftTemplatePlanMatches: boolean;
    rightTemplatePlanMatches: boolean;
    checks: Array<{
        checkId: string;
        title: string;
        comparable: boolean;
        left: string;
        right: string;
    }>;
}
