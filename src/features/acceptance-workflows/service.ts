import { createHash, randomUUID } from 'node:crypto';
import { canonicalJSON, object, uuid, integer, key, text, TERMINAL_STATES } from '../acceptance-runs/contract.ts';
import type { RunView } from '../acceptance-runs/contract.ts';
import type { AcceptanceRunService, RunExec, RunHistoryReader, RunReadScope, MutationResult } from '../acceptance-runs/service.ts';
import { fail, parseWorkflowPlan, WORKFLOW_VERIFIER_ID } from './contract.ts';
import type { WorkflowRecord, WorkflowView, WorkflowPlan, WorkflowCancellationFacts } from './contract.ts';
import { WorkflowStore } from './storage.ts';
import { WorkflowEvidenceVerifier } from './verifier.ts';
export interface WorkflowIdentity {
    readonly agent: object;
    readonly instanceId: string;
    readonly chatSessionId: string;
    assertCurrent(): void;
}
export interface WorkflowTarget {
    readonly kind: 'browser' | 'desktop';
    readonly environmentId: string;
    readonly targetId: string;
    readonly appId: string;
    readonly epoch: number;
    assertCurrent(): void;
    assertIdentity(): void;
    /** Host-only exact captured service stop; this boolean attests device input release only, never Agent drain or a DTO claim. */
    stop(owner: RunReadScope): Promise<boolean>;
    settleAgent(owner: RunReadScope, deadlineAt: number): Promise<{
        agentIdle: boolean | null;
        inboxEmpty: boolean | null;
    }>;
}
export interface WorkflowOptions {
    enabled(): boolean;
    authenticate(exec: RunExec): WorkflowIdentity;
    capture(exec: RunExec): WorkflowTarget;
    store: WorkflowStore;
    verifier: WorkflowEvidenceVerifier;
    h1: {
        service: AcceptanceRunService;
        reader: RunHistoryReader;
        onBegin(exec: RunExec, result: MutationResult): Promise<MutationResult>;
        interrupt(runId: string): void;
    };
    clock?(): number;
}
/** Host-only; never parsed from a tool argument or persisted as authority. */
export type WorkflowStartPrerequisite = (target?: WorkflowTarget) => void;
interface Active {
    identity: WorkflowIdentity;
    target?: WorkflowTarget;
    runId?: string;
    interrupted: boolean;
}
interface RepairWait {
    resolve(): void;
    reject(error: unknown): void;
    signal: AbortSignal;
    abort(): void;
    timer: ReturnType<typeof setTimeout>;
}
const hash = (v: unknown) => createHash('sha256').update(canonicalJSON(v)).digest('hex');
const clone = <T>(v: T): T => structuredClone(v);
/** Workflow policy around the existing H1 ledger. It does not create an Agent, execute code, or replay device input. */
export class AcceptanceWorkflowService {
    private readonly active = new Map<string, Active>();
    private readonly tails = new Map<string, Promise<unknown>>();
    private readonly repairWaits = new Map<string, RepairWait>();
    private disposed = false;
    private readonly startPrerequisites = new Map<string, WorkflowStartPrerequisite>();
    constructor(private readonly options: WorkflowOptions) { }
    private now() { return this.options.clock?.() ?? Date.now(); }
    private live() {
        if (this.disposed || !this.options.enabled())
            fail('WORKFLOW_DISABLED');
    }
    private identity(exec: RunExec) {
        this.live();
        exec.signal.throwIfAborted();
        const identity = this.options.authenticate(exec);
        identity.assertCurrent();
        if (exec.agent !== identity.agent || exec.agent.id !== identity.chatSessionId)
            fail('CALLER_NOT_LIVE');
        return identity;
    }
    private guard(exec: RunExec, record: WorkflowRecord, target = true): Active {
        const identity = this.identity(exec), active = this.active.get(record.workflowId);
        if (!active || active.interrupted || active.identity.agent !== identity.agent || identity.instanceId !== record.creatorInstanceId || record.chatSessionId !== identity.chatSessionId)
            fail('HISTORY_READ_ONLY');
        active.identity.assertCurrent();
        if (target && record.phase !== 'draft') {
            if (!active.target)
                fail('OWNER_CHANGED');
            active.target.assertCurrent();
        }
        return active;
    }
    private async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
        const prior = this.tails.get(id) ?? Promise.resolve(), next = prior.catch(() => { }).then(work);
        this.tails.set(id, next);
        try {
            return await next;
        }
        finally {
            if (this.tails.get(id) === next)
                this.tails.delete(id);
        }
    }
    private async load(id: unknown): Promise<WorkflowRecord> {
        const record = await this.options.store.load(uuid(id));
        if (!record)
            fail('WORKFLOW_NOT_FOUND');
        return record;
    }
    private mutation(record: WorkflowRecord, input: Record<string, unknown>) {
        if (integer(input.expectedRevision, 128, 1) !== record.revision)
            fail('REVISION_CONFLICT');
        if (record.revision >= 128)
            fail('REVISION_LIMIT');
    }
    private async save(record: WorkflowRecord, expectedRevision: number, guard: () => void): Promise<WorkflowRecord> {
        record.revision = expectedRevision + 1;
        record.updatedAt = this.now();
        guard();
        try {
            const value = await this.options.store.compareAndSwap(record, expectedRevision, guard);
            guard();
            return value;
        }
        catch (error) {
            this.interrupt(record);
            throw error;
        }
    }
    private interrupt(record: WorkflowRecord) {
        const active = this.active.get(record.workflowId);
        if (active)
            active.interrupted = true;
        if (record.runId) {
            this.options.h1.interrupt(record.runId);
            this.options.verifier.interrupt(record.runId);
        }
    }
    private async run(exec: RunExec, record: WorkflowRecord): Promise<RunView> {
        if (!record.runId)
            fail('WORKFLOW_NOT_STARTED');
        this.guard(exec, record);
        const view = await this.options.h1.service.get(exec, record.runId);
        this.guard(exec, record);
        if (view.readOnly && !TERMINAL_STATES.includes(view.state)) {
            this.interrupt(record);
            fail('HISTORY_READ_ONLY');
        }
        return view;
    }
    private async ledgerMutation(exec: RunExec, record: WorkflowRecord, work: () => Promise<MutationResult>): Promise<MutationResult> {
        try {
            const result = await work();
            this.guard(exec, record);
            return result;
        }
        catch (error) {
            // These errors prove rejection before a ledger mutation. Unknown storage/authority completion is never retried.
            const rejected = error && typeof error === 'object' && 'code' in error && ['INVALID_REQUEST', 'REVISION_CONFLICT', 'EVIDENCE_BINDING_MISMATCH', 'ATTEMPT_NOT_CURRENT', 'CHECK_ALREADY_RUNNING', 'CHECK_NOT_FOUND'].includes(String(error.code));
            if (!rejected)
                this.interrupt(record);
            throw error;
        }
    }
    private coreMutation(view: RunView) { return { runId: view.record.runId, expectedRevision: view.record.revision, idempotencyKey: 'workflow:' + randomUUID() }; }
    private summary(record: WorkflowRecord, run?: RunView): WorkflowView {
        const active = this.active.get(record.workflowId);
        let interrupted = !active || active.interrupted, changed = false;
        if (!interrupted && active)
            try {
                active.identity.assertCurrent();
                if (['running', 'awaitingRepair'].includes(record.phase))
                    active.target?.assertCurrent();
            }
            catch {
                this.interrupt(record);
                interrupted = true;
                changed = true;
            }
        const completeCancel = record.cancel?.quiescent === true && !!record.cancel.facts && Object.values(record.cancel.facts).every(value => value === true);
        const recovery = record.phase === 'discarded' ? 'none' : record.cancel && !completeCancel ? 'cancel-unconfirmed' : completeCancel ? 'none' : changed ? 'target-changed' : interrupted ? 'restart-interrupted' : 'none';
        return { record: clone(record), ...(run ? { run } : {}), readOnly: interrupted || ['discarded', 'closed', 'cancelRequested', 'interrupted'].includes(record.phase) || !!run && TERMINAL_STATES.includes(run.state), replayPermitted: false, recovery };
    }
    async propose(exec: RunExec, input: unknown, prerequisite?: WorkflowStartPrerequisite): Promise<WorkflowView> {
        const v = object(input, ['plan', 'previousWorkflowId']), plan = parseWorkflowPlan(v.plan), identity = this.identity(exec), previousWorkflowId = v.previousWorkflowId === null ? null : uuid(v.previousWorkflowId);
        const h = hash({ chat: identity.chatSessionId, instance: identity.instanceId, callId: text(exec.callId), domain: 'workflow-v1' }).slice(0, 32), workflowId = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
        return this.serial(workflowId, async () => {
            const prior = await this.options.store.load(workflowId);
            identity.assertCurrent();
            exec.signal.throwIfAborted();
            if (prior) {
                if (prior.creatorInstanceId !== identity.instanceId || hash(prior.plan) !== hash(plan) || prior.previousWorkflowId !== previousWorkflowId)
                    fail('IDEMPOTENCY_CONFLICT');
                if (prerequisite && this.startPrerequisites.get(workflowId) !== prerequisite)
                    fail('IDEMPOTENCY_CONFLICT');
                return this.summary(prior);
            }
            if (previousWorkflowId) {
                const previous = await this.load(previousWorkflowId);
                identity.assertCurrent();
                if (previous.chatSessionId !== identity.chatSessionId)
                    fail('WORKFLOW_NOT_FOUND');
            }
            const now = this.now(), record: WorkflowRecord = { schemaVersion: 1, workflowId, chatSessionId: identity.chatSessionId, creatorInstanceId: identity.instanceId, revision: 1, phase: 'draft', plan, planSHA256: null, runId: null, previousWorkflowId, createdAt: now, updatedAt: now, frozenAt: null, repairs: [], authorizedAttempts: [], cancel: null };
            const saved = await this.options.store.compareAndSwap(record, 0, () => { this.identity(exec); identity.assertCurrent(); });
            this.identity(exec);
            if (prerequisite)
                this.startPrerequisites.set(workflowId, prerequisite);
            this.active.set(workflowId, { identity, interrupted: false });
            return this.summary(saved);
        });
    }
    async get(exec: RunExec, input: unknown): Promise<WorkflowView> {
        const id = uuid(input);
        return this.serial(id, async () => {
            const identity = this.identity(exec), record = await this.load(id);
            identity.assertCurrent();
            if (record.chatSessionId !== identity.chatSessionId)
                fail('WORKFLOW_NOT_FOUND');
            let run: RunView | undefined;
            try {
                if (record.runId)
                    run = await this.options.h1.service.get(exec, record.runId);
            }
            catch {
                return { ...this.summary(record), readOnly: true, recovery: 'target-changed' };
            }
            identity.assertCurrent();
            return this.summary(record, run);
        });
    }
    async start(exec: RunExec, input: unknown): Promise<WorkflowView> {
        const v = object(input, ['workflowId', 'expectedRevision']), id = uuid(v.workflowId);
        return this.serial(id, async () => {
            let record = await this.load(id);
            this.guard(exec, record, false);
            this.mutation(record, v);
            if (record.phase !== 'draft')
                fail('PLAN_FROZEN');
            let target: WorkflowTarget | undefined;
            const fresh = () => this.startPrerequisites.get(id)?.(target);
            fresh();
            const captured = this.options.capture(exec);
            target = captured;
            captured.assertCurrent();
            fresh();
            const previous = record.previousWorkflowId ? await this.load(record.previousWorkflowId) : undefined;
            captured.assertCurrent();
            fresh();
            this.guard(exec, record, false);
            if (previous && previous.chatSessionId !== record.chatSessionId)
                fail('WORKFLOW_NOT_FOUND');
            const priorActive = record.previousWorkflowId ? this.active.get(record.previousWorkflowId) : undefined;
            const previousRunId = previous?.runId ?? (priorActive && priorActive.identity.agent === exec.agent ? priorActive.runId : undefined) ?? null;
            const latest = [...this.active.entries()].reverse().find(([otherId, value]) => otherId !== id && value.identity.agent === exec.agent && value.runId)?.[1];
            if (latest?.interrupted && previousRunId !== latest.runId)
                fail('PREVIOUS_WORKFLOW_REQUIRED');
            const existing = await this.options.h1.service.list(exec);
            captured.assertCurrent();
            fresh();
            this.guard(exec, record, false);
            if (existing.some(row => !TERMINAL_STATES.includes(row.state)))
                fail('RUN_ALREADY_RUNNING');
            let begun: MutationResult | undefined;
            try {
                const checks = record.plan.checks.map(({ rule: _rule, ...check }) => ({ ...check, verifierId: WORKFLOW_VERIFIER_ID }));
                begun = await this.options.h1.service.begin(exec, { title: record.plan.title, checks, budget: record.plan.budget, idempotencyKey: 'workflow-start:' + id, previousRunId });
                captured.assertCurrent();
                fresh();
                this.guard(exec, record, false);
                if (begun.readOnly || begun.record.binding.environmentId !== captured.environmentId || begun.record.binding.epoch !== captured.epoch || begun.record.binding.targetIds.length !== 1 || begun.record.binding.targetIds[0] !== captured.targetId)
                    fail('OWNER_CHANGED');
                this.options.verifier.attach(begun.record.runId, begun.record.binding, exec.agent!, record.plan, captured.kind, () => captured.assertCurrent());
                this.active.get(id)!.target = captured;
                this.active.get(id)!.runId = begun.record.runId;
                record.phase = 'running';
                record.runId = begun.record.runId;
                record.planSHA256 = hash(record.plan);
                record.frozenAt = begun.record.createdAt;
                record = await this.save(record, record.revision, () => { captured.assertCurrent(); fresh(); this.guard(exec, record, false); });
                begun = await this.options.h1.onBegin(exec, begun);
                captured.assertCurrent();
                fresh();
                this.guard(exec, record);
                return this.summary(record, { record: begun.record, state: begun.record.state, readOnly: begun.readOnly, recovery: 'none', unavailableEvidenceIds: [], replayPermitted: false });
            }
            catch (error) {
                if (begun) {
                    this.options.h1.interrupt(begun.record.runId);
                    this.options.verifier.interrupt(begun.record.runId);
                }
                this.interrupt(record);
                throw error;
            }
        });
    }
    async checkpoint(exec: RunExec, input: unknown): Promise<WorkflowView> {
        const v = object(input, ['workflowId', 'expectedRevision', 'phase', 'checkId', 'attemptId', 'evidenceIds', 'repairRequestId']), id = uuid(v.workflowId), checkId = key(v.checkId);
        return this.serial(id, async () => {
            let record = await this.load(id);
            this.guard(exec, record);
            this.mutation(record, v);
            if (!['running', 'awaitingRepair'].includes(record.phase) || !record.plan.checks.some(c => c.checkId === checkId))
                fail('WORKFLOW_NOT_RUNNING');
            let run = await this.run(exec, record);
            if (v.phase === 'start') {
                object(input, ['workflowId', 'expectedRevision', 'phase', 'checkId', 'repairRequestId']);
                if (run.readOnly || run.record.attempts.some(a => a.verdict === null))
                    fail('ATTEMPT_NOT_CURRENT');
                const latest = run.record.attempts.filter(a => a.checkId === checkId).at(-1);
                if (latest?.verdict === 'passed')
                    fail('CHECK_ALREADY_VERIFIED');
                if (latest && latest.verdict !== 'failed')
                    fail('CHECK_NEEDS_INFORMATION');
                const repair = v.repairRequestId === undefined || v.repairRequestId === null ? undefined : record.repairs.find(r => r.requestId === uuid(v.repairRequestId) && r.checkId === checkId && r.state === 'allowed');
                if (latest?.verdict === 'failed' && !repair || v.repairRequestId != null && !repair || record.phase === 'awaitingRepair' && !repair)
                    fail('REPAIR_PERMISSION_REQUIRED');
                const result = await this.ledgerMutation(exec, record, () => this.options.h1.service.checkpoint(exec, { ...this.coreMutation(run), phase: 'start', checkId }));
                const attempt = result.record.attempts.at(-1)!;
                if (attempt.checkId !== checkId || attempt.verdict !== null)
                    fail('ATTEMPT_NOT_CURRENT');
                if (repair) {
                    repair.state = 'consumed';
                    repair.attemptId = attempt.attemptId;
                }
                record.authorizedAttempts.push({ checkId, attemptId: attempt.attemptId, repairRequestId: repair?.requestId ?? null });
                record.phase = 'running';
                record = await this.save(record, record.revision, () => { this.guard(exec, record); });
                this.options.verifier.authorize(result.record.runId, checkId, attempt.attemptId);
                run = { record: result.record, state: result.record.state, readOnly: result.readOnly, recovery: 'none', unavailableEvidenceIds: [], replayPermitted: false };
            }
            else if (v.phase === 'verify') {
                object(input, ['workflowId', 'expectedRevision', 'phase', 'checkId', 'attemptId', 'evidenceIds']);
                const attemptId = uuid(v.attemptId);
                if (!record.authorizedAttempts.some(a => a.checkId === checkId && a.attemptId === attemptId))
                    fail('ATTEMPT_NOT_CURRENT');
                const result = await this.ledgerMutation(exec, record, () => this.options.h1.service.checkpoint(exec, { ...this.coreMutation(run), phase: 'verify', checkId, attemptId, evidenceIds: v.evidenceIds, assessment: { proposal: 'inconclusive', summaryCode: 'NEEDS_EVIDENCE' } }));
                record = await this.save(record, record.revision, () => { this.guard(exec, record); });
                run = { record: result.record, state: result.record.state, readOnly: result.readOnly, recovery: 'none', unavailableEvidenceIds: [], replayPermitted: false };
            }
            else
                fail('INVALID_REQUEST');
            return this.summary(record, run);
        });
    }
    async requestRepair(exec: RunExec, input: unknown): Promise<WorkflowView> {
        const v = object(input, ['workflowId', 'expectedRevision', 'checkId', 'reason']), id = uuid(v.workflowId), checkId = key(v.checkId), reason = text(v.reason, 600);
        const result = await this.serial(id, async () => {
            let record = await this.load(id);
            this.guard(exec, record);
            this.mutation(record, v);
            if (record.phase !== 'running')
                fail('WORKFLOW_NOT_RUNNING');
            const run = await this.run(exec, record), latest = run.record.attempts.filter(a => a.checkId === checkId).at(-1);
            if (run.readOnly || latest?.verdict !== 'failed' || record.repairs.length >= record.plan.maxRepairAttempts || run.record.attempts.some(a => a.verdict === null))
                fail('REPAIR_NOT_AVAILABLE');
            const requestId = randomUUID();
            record.repairs.push({ requestId, checkId, reason, state: 'pending', createdAt: this.now(), attemptId: null });
            record.phase = 'awaitingRepair';
            record = await this.save(record, record.revision, () => { this.guard(exec, record); });
            const remaining = record.plan.budget.deadlineMs - (this.now() - record.frozenAt!);
            if (remaining <= 0) {
                this.interrupt(record);
                fail('BUDGET_EXHAUSTED');
            }
            const waiting = new Promise<void>((resolve, reject) => {
                const remove = () => {
                    const wait = this.repairWaits.get(requestId);
                    if (wait) {
                        clearTimeout(wait.timer);
                        wait.signal.removeEventListener('abort', wait.abort);
                        this.repairWaits.delete(requestId);
                    }
                };
                const finish = () => { remove(); resolve(); }, abort = () => { remove(); this.interrupt(record); reject(new Error('WORKFLOW_CANCELLED')); }, timer = setTimeout(abort, remaining);
                this.repairWaits.set(requestId, { resolve: finish, reject, signal: exec.signal, abort, timer });
                exec.signal.addEventListener('abort', abort, { once: true });
                if (exec.signal.aborted)
                    abort();
            });
            void waiting.catch(() => { });
            return { record, requestId, waiting };
        });
        await result.waiting;
        return this.get(exec, id);
    }
    async finish(exec: RunExec, input: unknown): Promise<WorkflowView> {
        const v = object(input, ['workflowId', 'expectedRevision']), id = uuid(v.workflowId);
        return this.serial(id, async () => {
            let record = await this.load(id);
            this.guard(exec, record);
            this.mutation(record, v);
            if (record.phase !== 'running')
                fail('WORKFLOW_NOT_RUNNING');
            const run = await this.run(exec, record), result = await this.ledgerMutation(exec, record, () => this.options.h1.service.finish(exec, this.coreMutation(run)));
            record.phase = 'closed';
            record = await this.save(record, record.revision, () => { this.guard(exec, record); });
            this.options.verifier.interrupt(result.record.runId);
            return this.summary(record, { record: result.record, state: result.record.state, readOnly: true, recovery: 'none', unavailableEvidenceIds: [], replayPermitted: false });
        });
    }
    private owner(scope: RunReadScope, record: Pick<WorkflowRecord, 'chatSessionId'>) {
        this.live();
        scope.signal.throwIfAborted();
        scope.assertCurrent();
        if (scope.chatSessionId !== record.chatSessionId)
            fail('WORKFLOW_NOT_FOUND');
    }
    async read(scope: RunReadScope, input: unknown): Promise<WorkflowView> { const id = uuid(input); return this.serial(id, async () => { scope.assertCurrent(); const record = await this.load(id); this.owner(scope, record); const run = record.runId ? await this.options.h1.reader.get(scope, record.runId) : undefined; this.owner(scope, record); return this.summary(record, run); }); }
    async list(scope: RunReadScope): Promise<WorkflowView[]> {
        this.owner(scope, { chatSessionId: scope.chatSessionId });
        const rows = await this.options.store.list();
        scope.assertCurrent();
        const out: WorkflowView[] = [];
        for (const record of rows.filter(r => r.chatSessionId === scope.chatSessionId).sort((a, b) => b.createdAt - a.createdAt))
            out.push(await this.read(scope, record.workflowId));
        return out;
    }
    async edit(scope: RunReadScope, input: unknown): Promise<WorkflowView> {
        const v = object(input, ['workflowId', 'expectedRevision', 'plan']), id = uuid(v.workflowId), plan = parseWorkflowPlan(v.plan);
        return this.serial(id, async () => {
            let record = await this.load(id);
            this.owner(scope, record);
            this.mutation(record, v);
            const active = this.active.get(id);
            if (record.phase !== 'draft' || !active || active.interrupted)
                fail('PLAN_FROZEN');
            const current = () => {
                this.owner(scope, record);
                if (this.active.get(id) !== active || active.interrupted)
                    fail('HISTORY_READ_ONLY');
                active.identity.assertCurrent();
            };
            current();
            record.plan = plan;
            record = await this.save(record, record.revision, current);
            return this.summary(record);
        });
    }
    async decideRepair(scope: RunReadScope, input: unknown): Promise<WorkflowView> {
        const v = object(input, ['workflowId', 'expectedRevision', 'requestId', 'allowed']), id = uuid(v.workflowId), requestId = uuid(v.requestId);
        if (typeof v.allowed !== 'boolean')
            fail('INVALID_REQUEST');
        return this.serial(id, async () => {
            let record = await this.load(id);
            this.owner(scope, record);
            this.mutation(record, v);
            const active = this.active.get(id);
            if (!active || active.interrupted)
                fail('HISTORY_READ_ONLY');
            active.target?.assertCurrent();
            const request = record.repairs.find(r => r.requestId === requestId && r.state === 'pending');
            if (record.phase !== 'awaitingRepair' || !request || !this.repairWaits.has(requestId))
                fail('REQUEST_STALE');
            request.state = v.allowed ? 'allowed' : 'denied';
            if (!v.allowed)
                record.phase = 'running';
            record = await this.save(record, record.revision, () => { this.owner(scope, record); active.target?.assertCurrent(); });
            this.repairWaits.get(requestId)?.resolve();
            return this.summary(record);
        });
    }
    async cancel(scope: RunReadScope, input: unknown): Promise<WorkflowView> {
        const v = object(input, ['workflowId', 'expectedRevision']), id = uuid(v.workflowId);
        return this.serial(id, async () => {
            let record = await this.load(id);
            this.owner(scope, record);
            this.mutation(record, v);
            const active = this.active.get(id);
            if (record.phase === 'draft') {
                if (!active || active.interrupted)
                    fail('HISTORY_READ_ONLY');
                active.identity.assertCurrent();
                record.phase = 'discarded';
                record = await this.save(record, record.revision, () => { this.owner(scope, record); active.identity.assertCurrent(); });
                this.interrupt(record);
                return this.summary(record);
            }
            if (!active || active.interrupted || !active.target || !record.runId || !['running', 'awaitingRepair'].includes(record.phase))
                fail('HISTORY_READ_ONLY');
            active.target.assertCurrent();
            record.phase = 'cancelRequested';
            record.cancel = { requestedAt: this.now(), quiescent: null, facts: { deviceReleased: null, agentIdle: null, inboxEmpty: null } };
            record = await this.save(record, record.revision, () => { this.owner(scope, record); active.target!.assertCurrent(); });
            this.interrupt(record);
            for (const request of record.repairs)
                this.repairWaits.get(request.requestId)?.abort();
            const facts: WorkflowCancellationFacts = { deviceReleased: null, agentIdle: null, inboxEmpty: null };
            try {
                const released = await active.target.stop(scope);
                facts.deviceReleased = typeof released === 'boolean' ? released : null;
                this.owner(scope, record);
                active.target.assertIdentity();
                const agent = await active.target.settleAgent(scope, record.frozenAt! + record.plan.budget.deadlineMs);
                this.owner(scope, record);
                active.target.assertIdentity();
                if (![agent.agentIdle, agent.inboxEmpty].every(value => value === null || typeof value === 'boolean'))
                    fail('INVALID_RECEIPT');
                facts.agentIdle = agent.agentIdle;
                facts.inboxEmpty = agent.inboxEmpty;
            }
            catch { /* Preserve confirmed device release separately; Agent drain stays unknown. */ }
            const quiescent = Object.values(facts).every(value => value === true);
            record.cancel!.facts = facts;
            record.cancel!.quiescent = quiescent;
            record.phase = quiescent ? 'closed' : 'interrupted';
            record = await this.save(record, record.revision, () => { this.owner(scope, record); });
            return this.summary(record);
        });
    }
    interruptAll(): void {
        for (const wait of [...this.repairWaits.values()])
            wait.abort();
        for (const active of this.active.values()) {
            active.interrupted = true;
            if (active.runId) {
                this.options.h1.interrupt(active.runId);
                this.options.verifier.interrupt(active.runId);
            }
        }
    }
    dispose(): void {
        if (this.disposed)
            return;
        this.disposed = true;
        this.interruptAll();
        this.startPrerequisites.clear();
    }
}
