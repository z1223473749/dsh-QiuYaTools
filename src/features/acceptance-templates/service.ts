import { createHash } from 'node:crypto';
import { canonicalJSON, object, text, uuid, integer } from '../acceptance-runs/contract.ts';
import type { RunExec, RunReadScope } from '../acceptance-runs/service.ts';
import type { AcceptanceWorkflowService, WorkflowIdentity, WorkflowStartPrerequisite } from '../acceptance-workflows/service.ts';
import type { WorkflowView, WorkflowCheck } from '../acceptance-workflows/contract.ts';
import { fail } from '../acceptance-workflows/contract.ts';
import type { TemplateRecord, TemplateView, TemplatePrepared, TemplateComparison } from './contract.ts';
import { TemplateStore } from './storage.ts';
export interface TemplateObservation {
    environmentId: string;
    epoch: number;
    targetId: string;
    frameId: string;
    observationGeneration: number;
}
export interface TemplateOptions {
    enabled(): boolean;
    authenticate(exec: RunExec): WorkflowIdentity;
    /** Host-only: actual selected model service, permission and current Agent guards; never a UI preview or supplied frame. */
    observation(identity: WorkflowIdentity): TemplateObservation | null;
    /** Host process issued-observe boundary, never supplied by the model or a frame DTO. */
    observationGeneration(): number;
    workflows: Pick<AcceptanceWorkflowService, 'propose' | 'get' | 'read'>;
    store: TemplateStore;
    clock?(): number;
}
interface Preparing {
    identity: WorkflowIdentity;
    fingerprint: string;
    prerequisite: WorkflowStartPrerequisite;
    armed: boolean;
    baselineFrameId: string | null;
    baselineObservationGeneration: number;
    workflowId?: string;
    uncertain: boolean;
}
const hash = (v: unknown) => createHash('sha256').update(canonicalJSON(v)).digest('hex');
/** Reusable plan data around H3. It never copies a lease/grant, performs an action, creates an Agent or supplies a verdict. */
export class AcceptanceTemplateService {
    private readonly tails = new Map<string, Promise<unknown>>();
    private readonly preparing = new WeakMap<object, Map<string, Preparing>>();
    private readonly blocked = new Set<string>();
    private disposed = false;
    constructor(private readonly options: TemplateOptions) { }
    private now() { return this.options.clock?.() ?? Date.now(); }
    private live() { if (this.disposed || !this.options.enabled())
        fail('TEMPLATES_DISABLED'); }
    private identity(exec: RunExec) { this.live(); exec.signal.throwIfAborted(); const identity = this.options.authenticate(exec); identity.assertCurrent(); if (identity.agent !== exec.agent || identity.chatSessionId !== exec.agent?.id)
        fail('CALLER_NOT_LIVE'); return identity; }
    private owner(scope: RunReadScope) { this.live(); scope.signal.throwIfAborted(); scope.assertCurrent(); }
    private async serial<T>(id: string, work: () => Promise<T>) { const before = this.tails.get(id) ?? Promise.resolve(), next = before.catch(() => { }).then(work); this.tails.set(id, next); try {
        return await next;
    }
    finally {
        if (this.tails.get(id) === next)
            this.tails.delete(id);
    } }
    private async load(id: string) { const record = await this.options.store.load(uuid(id)); if (!record)
        fail('TEMPLATE_NOT_FOUND'); for (const version of record.versions)
        if (hash(version.plan) !== version.planSHA256)
            fail('STORE_INTEGRITY'); return record; }
    private view(record: TemplateRecord, chat: string): TemplateView { const value = structuredClone(record); value.executions = value.executions.filter(row => row.chatSessionId === chat); return { record: value, readOnly: record.revokedAt !== null || this.blocked.has(record.templateId), canPrepare: !this.disposed && this.options.enabled() && record.revokedAt === null && !this.blocked.has(record.templateId), replayPermitted: false }; }
    private version(record: TemplateRecord, id: unknown) { const version = record.versions.find(v => v.versionId === uuid(id)); if (!version)
        fail('VERSION_NOT_FOUND'); return version; }
    private available(record: TemplateRecord) { if (record.revokedAt !== null || this.blocked.has(record.templateId))
        fail('TEMPLATE_REVOKED'); }
    private async save(record: TemplateRecord, expected: number, current: () => void) { if (expected >= 256)
        fail('REVISION_LIMIT'); current(); record.revision = expected + 1; record.updatedAt = this.now(); const saved = await this.options.store.compareAndSwap(record, expected, current); current(); return saved; }
    async list(scope: RunReadScope): Promise<TemplateView[]> { this.owner(scope); const rows = await this.options.store.list(); this.owner(scope); const out = []; for (const row of rows) {
        const record = await this.load(row.templateId);
        this.owner(scope);
        out.push(this.view(record, scope.chatSessionId));
    } return out.sort((a, b) => b.record.updatedAt - a.record.updatedAt); }
    async read(scope: RunReadScope, id: unknown) { this.owner(scope); const record = await this.load(uuid(id)); this.owner(scope); return this.view(record, scope.chatSessionId); }
    async modelList(exec: RunExec) { const identity = this.identity(exec); const records = await this.options.store.list(); this.identity(exec); identity.assertCurrent(); const out = []; for (const row of records) {
        const record = await this.load(row.templateId);
        this.identity(exec);
        identity.assertCurrent();
        out.push(this.view(record, identity.chatSessionId));
    } return out; }
    /** Explicit owner save. New versions copy only the actual referenced workflow's editable/frozen checklist. */
    async saveVersion(scope: RunReadScope, input: unknown): Promise<TemplateView> {
        const v = object(input, ['templateId', 'expectedRevision', 'workflowId', 'name', 'description', 'label', 'operationId']);
        const operationId = uuid(v.operationId), templateId = v.templateId === null ? operationId : uuid(v.templateId), expected = integer(v.expectedRevision, 256), name = text(v.name, 120), description = v.description === '' ? '' : text(v.description, 500), label = text(v.label, 80), workflowId = uuid(v.workflowId);
        this.owner(scope);
        return this.serial(templateId, async () => {
            this.owner(scope);
            const workflow = await this.options.workflows.read(scope, workflowId);
            this.owner(scope);
            const existing = await this.options.store.load(templateId);
            this.owner(scope);
            if (!existing && (expected !== 0 || v.templateId !== null))
                fail('REVISION_CONFLICT');
            const now = this.now(), record = existing ? await this.load(templateId) : { schemaVersion: 1 as const, templateId, revision: 0, name, description, createdAt: now, updatedAt: now, revokedAt: null, versions: [], executions: [] };
            this.owner(scope);
            this.available(record);
            const versionId = operationId, previous = record.versions.find(row => row.versionId === versionId), planSHA256 = hash(workflow.record.plan);
            if (previous) {
                if (previous.label !== label || previous.planSHA256 !== planSHA256 || record.name !== name || record.description !== description)
                    fail('IDEMPOTENCY_CONFLICT');
                return this.view(record, scope.chatSessionId);
            }
            if (record.revision !== expected)
                fail('REVISION_CONFLICT');
            if (record.versions.length >= 16 || record.executions.length >= 64)
                fail('TEMPLATE_LIMIT');
            record.name = name;
            record.description = description;
            record.versions.push({ versionId, number: record.versions.length + 1, label, createdAt: now, plan: structuredClone(workflow.record.plan), planSHA256 });
            if (!record.executions.some(row => row.workflowId === workflowId))
                record.executions.push({ workflowId, chatSessionId: scope.chatSessionId, versionId, versionLabel: label, createdAt: now });
            const saved = await this.save(record, expected, () => this.owner(scope));
            return this.view(saved, scope.chatSessionId);
        });
    }
    async revoke(scope: RunReadScope, input: unknown) {
        const v = object(input, ['templateId', 'expectedRevision']), id = uuid(v.templateId), expected = integer(v.expectedRevision, 256, 1);
        this.owner(scope);
        return this.serial(id, async () => { const record = await this.load(id); this.owner(scope); if (record.revision !== expected)
            fail('REVISION_CONFLICT'); if (record.revokedAt !== null)
            return this.view(record, scope.chatSessionId); this.blocked.add(id); record.revokedAt = this.now(); const saved = await this.save(record, expected, () => this.owner(scope)); return this.view(saved, scope.chatSessionId); });
    }
    async prepare(exec: RunExec, input: unknown): Promise<TemplatePrepared> {
        const v = object(input, ['templateId', 'versionId', 'versionLabel', 'previousWorkflowId']), id = uuid(v.templateId), versionId = uuid(v.versionId), versionLabel = text(v.versionLabel, 120), previousId = v.previousWorkflowId === null ? null : uuid(v.previousWorkflowId), identity = this.identity(exec), callId = text(exec.callId), fingerprint = hash({ id, versionId, versionLabel, previousId });
        let calls = this.preparing.get(identity.agent);
        if (!calls) {
            calls = new Map();
            this.preparing.set(identity.agent, calls);
        }
        const prior = calls.get(callId);
        if (prior) {
            if (prior.fingerprint !== fingerprint)
                fail('IDEMPOTENCY_CONFLICT');
            fail('PREPARATION_ALREADY_ISSUED');
        }
        if (calls.size >= 128)
            fail('TEMPLATE_LIMIT');
        const preparing: Preparing = { identity, fingerprint, armed: false, baselineFrameId: null, baselineObservationGeneration: -1, uncertain: false, prerequisite: () => { } };
        preparing.prerequisite = target => {
            this.live();
            identity.assertCurrent();
            if (this.blocked.has(id))
                fail('TEMPLATE_REVOKED');
            if (!preparing.armed || preparing.uncertain)
                fail('FRESH_OBSERVATION_REQUIRED');
            const current = this.options.observation(identity);
            if (!current || !Number.isSafeInteger(current.observationGeneration) || current.observationGeneration <= preparing.baselineObservationGeneration || current.frameId === preparing.baselineFrameId)
                fail('FRESH_OBSERVATION_REQUIRED');
            if (target && (current.environmentId !== target.environmentId || current.epoch !== target.epoch || current.targetId !== target.targetId))
                fail('OWNER_CHANGED');
        };
        calls.set(callId, preparing);
        try {
            return await this.serial(id, async () => {
                const current = () => { this.identity(exec); identity.assertCurrent(); if (this.blocked.has(id))
                    fail('TEMPLATE_REVOKED'); };
                const record = await this.load(id);
                current();
                this.available(record);
                const version = this.version(record, versionId);
                if (record.executions.length >= 64)
                    fail('TEMPLATE_LIMIT');
                let previousWorkflowId = previousId;
                if (previousWorkflowId) {
                    const previous = await this.options.workflows.get(exec, previousWorkflowId);
                    current();
                    if (previous.record.chatSessionId !== identity.chatSessionId)
                        fail('WORKFLOW_NOT_FOUND');
                }
                else
                    previousWorkflowId = record.executions.filter(row => row.chatSessionId === identity.chatSessionId).at(-1)?.workflowId ?? null;
                const workflow = await this.options.workflows.propose(exec, { plan: structuredClone(version.plan), previousWorkflowId }, preparing.prerequisite);
                current();
                preparing.workflowId = workflow.record.workflowId;
                if (workflow.record.phase !== 'draft' || workflow.readOnly || record.executions.some(row => row.workflowId === workflow.record.workflowId))
                    fail('PREPARATION_ALREADY_ISSUED');
                record.executions.push({ workflowId: workflow.record.workflowId, chatSessionId: identity.chatSessionId, versionId, versionLabel, createdAt: this.now() });
                const saved = await this.save(record, record.revision, current);
                current();
                this.available(saved);
                // Establish the boundary only after the new draft and durable link exist. The next real observe must produce a different frame.
                preparing.baselineFrameId = this.options.observation(identity)?.frameId ?? null;
                preparing.baselineObservationGeneration = this.options.observationGeneration();
                if (!Number.isSafeInteger(preparing.baselineObservationGeneration) || preparing.baselineObservationGeneration < 0)
                    fail('FRESH_OBSERVATION_REQUIRED');
                current();
                preparing.armed = true;
                return { template: this.view(saved, identity.chatSessionId), versionId, versionLabel, workflow, requiresFreshObservation: true };
            });
        }
        catch (error) {
            preparing.uncertain = true;
            preparing.armed = false;
            throw error;
        }
    }
    async compare(scope: RunReadScope, input: unknown): Promise<TemplateComparison> {
        const v = object(input, ['templateId', 'leftWorkflowId', 'rightWorkflowId']), id = uuid(v.templateId), leftId = uuid(v.leftWorkflowId), rightId = uuid(v.rightWorkflowId);
        this.owner(scope);
        const record = await this.load(id);
        this.owner(scope);
        const ref = (workflowId: string) => { const row = record.executions.find(row => row.chatSessionId === scope.chatSessionId && row.workflowId === workflowId); if (!row)
            fail('WORKFLOW_NOT_FOUND'); return row; };
        const leftRef = ref(leftId), rightRef = ref(rightId), left = await this.options.workflows.read(scope, leftId);
        this.owner(scope);
        const right = await this.options.workflows.read(scope, rightId);
        this.owner(scope);
        const leftVersion = this.version(record, leftRef.versionId), rightVersion = this.version(record, rightRef.versionId);
        const checks = [...new Set([...left.record.plan.checks.map(c => c.checkId), ...right.record.plan.checks.map(c => c.checkId)])].map(checkId => {
            const a = left.record.plan.checks.find(c => c.checkId === checkId), b = right.record.plan.checks.find(c => c.checkId === checkId);
            return { checkId, title: b?.title ?? a!.title, comparable: !!a && !!b && comparableRule(a, b), left: lastVerdict(left, checkId), right: lastVerdict(right, checkId) };
        });
        return { readOnly: true, replayPermitted: false, left, right, leftTemplatePlanMatches: hash(left.record.plan) === leftVersion.planSHA256, rightTemplatePlanMatches: hash(right.record.plan) === rightVersion.planSHA256, checks };
    }
    dispose() { this.disposed = true; }
}
function comparableRule(a: WorkflowCheck, b: WorkflowCheck) { return hash({ expected: a.expected, required: a.required, minimumEvidence: a.minimumEvidence, rule: a.rule }) === hash({ expected: b.expected, required: b.required, minimumEvidence: b.minimumEvidence, rule: b.rule }); }
function lastVerdict(view: WorkflowView, checkId: string) { const attempt = view.run?.record.attempts.filter(row => row.checkId === checkId).at(-1); return attempt ? attempt.verdict ?? (view.run?.readOnly ? 'inconclusive' : 'pending') : 'not-run'; }
