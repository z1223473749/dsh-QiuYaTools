import { createHash, randomUUID } from 'node:crypto';
import { AcceptanceRunStore } from './storage.ts';
import { aggregateRun, canonicalJSON, enumeration, fail, integer, object, parseAction, parseBegin, parseBinding, parseCheckpoint, parseEvidence, parseMutation, TERMINAL_STATES, uuid, VERIFY_CODES } from './contract.ts';
import type { ActionReceipt, AgentBinding, CheckAttempt, CheckPlan, EvidenceRef, MutationInput, RunRecord, RunState, RunView, Verdict, VerifyCode } from './contract.ts';
export interface RunExec {
    callId: string;
    agent?: {
        id: string;
    };
    signal: AbortSignal;
}
/** Trusted Host adapter: resolve must reuse the live-root owner coordinator; current is a synchronous generation fence. */
export interface RunAuthority {
    resolve(exec: RunExec): Promise<AgentBinding & {
        agentHandle: object;
    }> | AgentBinding & {
        agentHandle: object;
    };
    current(binding: AgentBinding, agentHandle: object): boolean;
}
export interface EvidenceInspector {
    inspect(ref: Readonly<EvidenceRef>, signal: AbortSignal): Promise<{
        attachmentId: string;
        sha256: string;
        mediaType: string;
        bytes: number;
        width: number;
        height: number;
    }>;
}
export interface RunVerifier {
    id: string;
    version: string;
    verify(input: Readonly<{
        run: RunRecord;
        check: CheckPlan;
        attempt: CheckAttempt;
        evidence: EvidenceRef[];
    }>, signal: AbortSignal): Promise<{
        verdict: Verdict;
        code: VerifyCode;
    }>;
}
export interface RunServiceOptions {
    store: AcceptanceRunStore;
    authority: RunAuthority;
    evidence: EvidenceInspector;
    verifiers?: readonly RunVerifier[];
    clock?: () => number;
    versions?: RunRecord['versions'];
}
export interface MutationResult {
    record: RunRecord;
    replayed: boolean;
    readOnly: boolean;
}
/** Construct only after owner RPC authentication; never accept this scope in model arguments. */
export interface RunReadScope {
    chatSessionId: string;
    signal: AbortSignal;
    assertCurrent(): void;
}
export interface RunHistoryReader {
    get(scope: RunReadScope, runId: unknown): Promise<RunView>;
    list(scope: RunReadScope): Promise<Array<{
        runId: string;
        title: string;
        state: RunState;
        revision: number;
        readOnly: true;
    }>>;
    export(scope: RunReadScope, runId: unknown): Promise<unknown>;
    evidence(scope: RunReadScope, runId: unknown, evidenceId: unknown): Promise<EvidenceRef>;
}
export interface RunRecorder {
    /** Trusted Host revocation only: retain durable facts, revoke all future mutations after uncertain storage/input completion. */
    interrupt(runId: string): void;
    setState(exec: RunExec, input: MutationInput & {
        state: 'awaitingPermission' | 'running' | 'paused' | 'humanControl';
    }): Promise<MutationResult>;
    commitEvidence(exec: RunExec, input: MutationInput & {
        evidence: unknown;
    }): Promise<MutationResult>;
    recordAction(exec: RunExec, input: MutationInput & {
        receipt: unknown;
    }): Promise<MutationResult>;
    requestCancel(exec: RunExec, input: MutationInput): Promise<MutationResult>;
    confirmCancelled(exec: RunExec, input: MutationInput & {
        epoch: number;
        quiescent: boolean;
    }): Promise<MutationResult>;
}
const hash = (v: unknown) => createHash('sha256').update(canonicalJSON(v)).digest('hex');
const clone = <T>(v: T): T => structuredClone(v);
function sameBinding(a: AgentBinding, b: AgentBinding, epoch = true): boolean { return a.chatSessionId === b.chatSessionId && a.agentId === b.agentId && a.rootAgentId === b.rootAgentId && a.agentInstanceId === b.agentInstanceId && a.environmentId === b.environmentId && (!epoch || a.epoch === b.epoch) && canonicalJSON(a.targetIds) === canonicalJSON(b.targetIds); }
function deterministicRunId(binding: AgentBinding, idempotencyKey: string): string { const h = hash({ domain: 'qiuya-run-v1', chat: binding.chatSessionId, instance: binding.agentInstanceId, key: idempotencyKey }).slice(0, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`; }
/** Model surface has no setPassed, verifier selection at checkpoint, arbitrary paths, control or replay method. */
export class AcceptanceRunService {
    #o: RunServiceOptions;
    #verifiers = new Map<string, RunVerifier>();
    #live = new Set<string>();
    #diagnosticSnapshots = new Map<string, { record: RunRecord; handle: object }>();
    #queues = new Map<string, Promise<unknown>>();
    constructor(options: RunServiceOptions) { this.#o = options; for (const v of options.verifiers ?? []) {
        if (!v.id || !v.version || this.#verifiers.has(v.id))
            fail('INVALID_VERIFIER');
        this.#verifiers.set(v.id, Object.freeze({ ...v }));
    } }
    #now(): number { return integer((this.#o.clock ?? Date.now)()); }
    async #caller(exec: RunExec) { if (!exec.agent || !exec.signal || exec.signal.aborted)
        fail('CALLER_NOT_LIVE'); const resolved = await this.#o.authority.resolve(exec), { agentHandle, ...rawBinding } = resolved, binding = parseBinding(rawBinding); if (resolved.agentHandle !== exec.agent || binding.agentId !== exec.agent.id)
        fail('CALLER_NOT_LIVE'); this.#guard(exec, binding, resolved.agentHandle); return { binding, handle: resolved.agentHandle }; }
    #guard(exec: RunExec, binding: AgentBinding, handle: object) { if (exec.signal.aborted || exec.agent !== handle || !this.#o.authority.current(binding, handle))
        fail('CALLER_NOT_LIVE'); }
    async #serial<T>(id: string, run: () => Promise<T>): Promise<T> { const prior = this.#queues.get(id) ?? Promise.resolve(); const next = prior.catch(() => { }).then(run); this.#queues.set(id, next); try {
        return await next;
    }
    finally {
        if (this.#queues.get(id) === next)
            this.#queues.delete(id);
    } }
    #receipt(record: RunRecord, key: string, digest: string, operation: string) { const snapshotId = randomUUID(); record.revision++; record.receipts.push({ key, digest, revision: record.revision, snapshotId, operation }); record.updatedAt = this.#now(); }
    async #replay(record: RunRecord, key: string, digest: string): Promise<MutationResult | undefined> { const prior = record.receipts.find(x => x.key === key); if (!prior)
        return; if (prior.digest !== digest)
        fail('IDEMPOTENCY_CONFLICT'); return { record: await this.#o.store.revision(record.runId, prior.snapshotId, prior.revision), replayed: true, readOnly: !this.#live.has(record.runId) || TERMINAL_STATES.includes(record.state) }; }
    async begin(exec: RunExec, input: unknown): Promise<MutationResult> {
        const args = parseBegin(input), caller = await this.#caller(exec), id = deterministicRunId(caller.binding, args.idempotencyKey), content = hash({ operation: 'begin', args, binding: caller.binding });
        return this.#serial(id, async () => {
            const current = await this.#o.store.load(id);
            this.#guard(exec, caller.binding, caller.handle);
            if (current) {
                if (!sameBinding(current.binding, caller.binding))
                    fail('OWNER_CHANGED');
                const replay = await this.#replay(current, args.idempotencyKey, content);
                this.#guard(exec, caller.binding, caller.handle);
                if (!replay)
                    fail('IDEMPOTENCY_CONFLICT');
                return replay;
            }
            if (args.previousRunId) {
                const previous = await this.#o.store.load(args.previousRunId);
                this.#guard(exec, caller.binding, caller.handle);
                if (!previous || previous.binding.chatSessionId !== caller.binding.chatSessionId)
                    fail('RUN_NOT_FOUND');
            }
            const now = this.#now(), versions = this.#o.versions ?? { plugin: 'unknown', runtime: 'unknown', helper: 'unknown', protocol: 'unknown', model: 'unknown' };
            const record: RunRecord = { schemaVersion: 1, runId: id, binding: caller.binding, title: args.title, previousRunId: args.previousRunId, planRevision: 1, planSHA256: hash(args.checks), checks: args.checks, attempts: [], evidence: [], actions: [], receipts: [], revision: 0, createdAt: now, updatedAt: now, endedAt: null, state: 'queued', budget: args.budget, versions: clone(versions), cancel: null };
            this.#receipt(record, args.idempotencyKey, content, 'begin');
            const saved = await this.#o.store.compareAndSwap(record, 0, () => this.#guard(exec, caller.binding, caller.handle));
            this.#guard(exec, caller.binding, caller.handle);
            this.#live.add(id);
            this.#diagnosticSnapshots.set(id, { record: clone(saved), handle: caller.handle });
            return { record: saved, replayed: false, readOnly: false };
        });
    }
    async #mutate(exec: RunExec, args: MutationInput, operation: string, payload: unknown, update: (record: RunRecord, checkpoint: () => void) => Promise<void> | void, allowCancelEpoch = false): Promise<MutationResult> { const caller = await this.#caller(exec), content = hash({ operation, payload, binding: caller.binding }); return this.#serial(args.runId, async () => { const record = await this.#o.store.load(args.runId); this.#guard(exec, caller.binding, caller.handle); if (!record || record.binding.chatSessionId !== caller.binding.chatSessionId)
        fail('RUN_NOT_FOUND'); if (!sameBinding(record.binding, caller.binding, !allowCancelEpoch))
        fail('OWNER_CHANGED'); const replay = await this.#replay(record, args.idempotencyKey, content); this.#guard(exec, caller.binding, caller.handle); if (replay)
        return replay; if (!this.#live.has(record.runId) || TERMINAL_STATES.includes(record.state))
        fail('HISTORY_READ_ONLY'); if (record.revision !== args.expectedRevision)
        fail('REVISION_CONFLICT'); if (record.revision >= 128)
        fail('REVISION_LIMIT'); const checkpoint = () => { this.#guard(exec, caller.binding, caller.handle); if (!this.#live.has(record.runId)) fail('HISTORY_READ_ONLY'); }; await update(record, checkpoint); checkpoint(); this.#receipt(record, args.idempotencyKey, content, operation); this.#diagnosticSnapshots.delete(record.runId); const saved = await this.#o.store.compareAndSwap(record, args.expectedRevision, checkpoint); checkpoint(); this.#diagnosticSnapshots.set(saved.runId, { record: clone(saved), handle: caller.handle }); return { record: saved, replayed: false, readOnly: TERMINAL_STATES.includes(saved.state) }; }); }
    /** Host-only synchronous association with the last committed current checkpoint; no mutation/verdict authority. */
    diagnosticAssociation(exec: RunExec, expected: { environmentId: string; targetId: string; epoch: number }): { runId: string; checkId: string; attemptId: string } | undefined {
        if (!exec.agent || exec.signal.aborted) fail('CALLER_NOT_LIVE');
        const candidates = [...this.#diagnosticSnapshots.values()].filter(item => item.handle === exec.agent).map(item => item.record).filter(record => this.#live.has(record.runId) && record.binding.chatSessionId === exec.agent!.id && record.state === 'running' && !record.cancel && !TERMINAL_STATES.includes(record.state));
        const out: Array<{ runId: string; checkId: string; attemptId: string }> = [];
        for (const record of candidates) {
            this.#guard(exec, record.binding, exec.agent);
            if (record.binding.environmentId !== expected.environmentId || record.binding.epoch !== expected.epoch || !record.binding.targetIds.includes(expected.targetId)) continue;
            const attempts = record.attempts.filter(attempt => attempt.verdict === null);
            if (attempts.length === 1) out.push({ runId: record.runId, checkId: attempts[0]!.checkId, attemptId: attempts[0]!.attemptId });
        }
        return out.length === 1 ? out[0] : undefined;
    }
    #running(record: RunRecord) { if (record.cancel || record.state !== 'running')
        fail('RUN_NOT_RUNNING'); if (this.#now() - record.createdAt >= record.budget.deadlineMs)
        fail('BUDGET_EXHAUSTED'); }
    async checkpoint(exec: RunExec, input: unknown): Promise<MutationResult> {
        const args = parseCheckpoint(input);
        return this.#mutate(exec, args, 'checkpoint', args, async (record, checkpoint) => {
            this.#running(record);
            const check = record.checks.find(x => x.checkId === args.checkId);
            if (!check)
                fail('CHECK_NOT_FOUND');
            if (args.phase === 'start') {
                if (record.attempts.some(a => a.checkId === check.checkId && a.verdict === null))
                    fail('CHECK_ALREADY_RUNNING');
                if (record.attempts.length >= record.budget.maxAttempts)
                    fail('BUDGET_EXHAUSTED');
                record.attempts.push({ attemptId: randomUUID(), checkId: check.checkId, startedAt: this.#now(), endedAt: null, verdict: null, verificationCode: null, verifier: null, evidenceIds: [], assessment: null });
                return;
            }
            const attempt = record.attempts.find(x => x.attemptId === args.attemptId && x.checkId === check.checkId);
            if (!attempt || attempt.verdict !== null)
                fail('ATTEMPT_NOT_CURRENT');
            const refs = args.evidenceIds.map(id => { const e = record.evidence.find(x => x.evidenceId === id && x.attemptId === attempt.attemptId && x.checkId === check.checkId); if (!e)
                fail('EVIDENCE_BINDING_MISMATCH'); return e; });
            let verdict: Verdict = 'inconclusive', code: VerifyCode = 'VERIFIER_UNAVAILABLE';
            const verifier = check.verifierId ? this.#verifiers.get(check.verifierId) : undefined;
            let evidenceAvailable = refs.length >= check.minimumEvidence;
            if (evidenceAvailable)
                for (const ref of refs) {
                    const available = await this.#evidenceAvailable(ref, exec.signal);
                    checkpoint();
                    if (!available) {
                        evidenceAvailable = false;
                        break;
                    }
                }
            if (!evidenceAvailable)
                code = refs.length < check.minimumEvidence ? 'MISSING_EVIDENCE' : 'EVIDENCE_UNAVAILABLE';
            else if (verifier) {
                checkpoint();
                try {
                    const result = object(await this.#bounded(childSignal => verifier.verify(Object.freeze(clone({ run: record, check, attempt, evidence: refs })), childSignal), exec.signal, 5000), ['verdict', 'code']);
                    checkpoint();
                    verdict = enumeration(result.verdict, ['passed', 'failed', 'blocked', 'inconclusive']);
                    code = enumeration(result.code, VERIFY_CODES);
                    if ((verdict === 'passed') !== (code === 'VERIFIED'))
                        fail('INVALID_VERIFIER_RESULT');
                }
                catch {
                    verdict = 'inconclusive';
                    code = 'VERIFIER_FAILED';
                }
            }
            attempt.assessment = args.assessment;
            attempt.evidenceIds = args.evidenceIds;
            attempt.verdict = verdict;
            attempt.verificationCode = code;
            attempt.verifier = verifier && evidenceAvailable ? { id: verifier.id, version: verifier.version } : null;
            attempt.endedAt = this.#now();
        });
    }
    async finish(exec: RunExec, input: unknown): Promise<MutationResult> { const args = parseMutation(input); return this.#mutate(exec, args, 'finish', args, async (record, checkpoint) => { let state: Verdict = aggregateRun(record); if (this.#now() - record.createdAt >= record.budget.deadlineMs)
        state = 'inconclusive'; if (state === 'passed')
        for (const ref of record.evidence) {
            const available = await this.#evidenceAvailable(ref, exec.signal);
            checkpoint();
            if (!available) {
                state = 'inconclusive';
                break;
            }
        } record.state = state; record.endedAt = this.#now(); }); }
    async #bounded<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, ms: number): Promise<T> { const timeout = AbortSignal.timeout(ms), child = AbortSignal.any([signal, timeout]); child.throwIfAborted(); let rejectAbort: () => void = () => { }; const cancelled = new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error('BOUNDED_READ_ABORTED')); child.addEventListener('abort', rejectAbort, { once: true }); }); try {
        return await Promise.race([work(child), cancelled]);
    }
    finally {
        child.removeEventListener('abort', rejectAbort);
    } }
    async #evidenceAvailable(ref: EvidenceRef, signal: AbortSignal): Promise<boolean> { try {
        const actual = await this.#bounded(childSignal => this.#o.evidence.inspect(Object.freeze(clone(ref)), childSignal), signal, 2000);
        return actual.attachmentId === ref.attachmentId && actual.sha256 === ref.sha256 && actual.bytes === ref.bytes && actual.mediaType === ref.mediaType && actual.width === ref.width && actual.height === ref.height;
    }
    catch {
        return false;
    } }
    async get(exec: RunExec, runId: unknown): Promise<RunView> { const id = uuid(runId), caller = await this.#caller(exec), record = await this.#o.store.load(id); this.#guard(exec, caller.binding, caller.handle); if (!record || record.binding.chatSessionId !== caller.binding.chatSessionId)
        fail('RUN_NOT_FOUND'); const unavailable: string[] = []; for (const e of record.evidence) {
        if (!await this.#evidenceAvailable(e, exec.signal))
            unavailable.push(e.evidenceId);
        this.#guard(exec, caller.binding, caller.handle);
    } const historical = !this.#live.has(id) || !sameBinding(record.binding, caller.binding); const interrupted = historical && !TERMINAL_STATES.includes(record.state); const missing = record.state === 'passed' && unavailable.length > 0; return { record, state: interrupted || missing ? 'inconclusive' : record.state, readOnly: historical || TERMINAL_STATES.includes(record.state), recovery: missing ? 'evidence-unavailable' : interrupted ? 'restart-interrupted' : historical ? 'historical' : 'none', unavailableEvidenceIds: unavailable, replayPermitted: false }; }
    async list(exec: RunExec): Promise<Array<{
        runId: string;
        title: string;
        state: RunState;
        revision: number;
        readOnly: true;
    }>> { const caller = await this.#caller(exec), records = await this.#o.store.list(); this.#guard(exec, caller.binding, caller.handle); const result: Array<{
        runId: string;
        title: string;
        state: RunState;
        revision: number;
        readOnly: true;
    }> = []; for (const r of records.filter(x => x.binding.chatSessionId === caller.binding.chatSessionId).sort((a, b) => b.createdAt - a.createdAt)) {
        const view = await this.get(exec, r.runId);
        this.#guard(exec, caller.binding, caller.handle);
        result.push({ runId: r.runId, title: r.title, state: view.state, revision: r.revision, readOnly: true });
    } return result; }
    async export(exec: RunExec, runId: unknown): Promise<unknown> { const caller = await this.#caller(exec), view = await this.get(exec, runId); this.#guard(exec, caller.binding, caller.handle); return this.#exportView(view); }
    #exportView(view: RunView): unknown { const r = view.record; return { schemaVersion: 1, runId: r.runId, state: view.state, readOnly: true, revision: r.revision, createdAt: r.createdAt, endedAt: r.endedAt, recovery: view.recovery, replayPermitted: false, checks: r.checks.map((c, index) => ({ number: index + 1, required: c.required, attempts: r.attempts.filter(a => a.checkId === c.checkId).map(a => ({ attemptId: a.attemptId, startedAt: a.startedAt, endedAt: a.endedAt, verdict: a.verdict, verificationCode: a.verificationCode, evidenceIds: a.evidenceIds })) })), evidence: r.evidence.map(e => ({ evidenceId: e.evidenceId, sha256: e.sha256, mediaType: e.mediaType, bytes: e.bytes, width: e.width, height: e.height, available: !view.unavailableEvidenceIds.includes(e.evidenceId) })), actions: r.actions.map(a => ({ kind: a.kind, phase: a.phase, at: a.at, errorCode: a.errorCode })) }; }
    #readGuard(scope: RunReadScope): void { if (scope.signal.aborted)
        fail('READ_CANCELLED'); scope.assertCurrent(); }
    async #readHistory(scope: RunReadScope, runId: unknown): Promise<RunView> { const id = uuid(runId); this.#readGuard(scope); const record = await this.#o.store.load(id); this.#readGuard(scope); if (!record || record.binding.chatSessionId !== scope.chatSessionId)
        fail('RUN_NOT_FOUND'); const unavailable: string[] = []; for (const e of record.evidence) {
        const available = await this.#evidenceAvailable(e, scope.signal);
        this.#readGuard(scope);
        if (!available)
            unavailable.push(e.evidenceId);
    } const interrupted = !this.#live.has(id) && !TERMINAL_STATES.includes(record.state), missing = record.state === 'passed' && unavailable.length > 0; return { record, state: interrupted || missing ? 'inconclusive' : record.state, readOnly: true, recovery: missing ? 'evidence-unavailable' : interrupted ? 'restart-interrupted' : this.#live.has(id) ? 'none' : 'historical', unavailableEvidenceIds: unavailable, replayPermitted: false }; }
    /** Only the factory gives this closed recorder capability to trusted Host integration. */
    static create(options: RunServiceOptions): {
        service: AcceptanceRunService;
        recorder: RunRecorder;
        reader: RunHistoryReader;
    } {
        const service = new AcceptanceRunService(options);
        const mutation = (input: unknown, extra: string[]) => { const v = object(input, ['runId', 'expectedRevision', 'idempotencyKey', ...extra]); return { raw: v, args: parseMutation({ runId: v.runId, expectedRevision: v.expectedRevision, idempotencyKey: v.idempotencyKey }) }; };
        const recorder: RunRecorder = {
            interrupt(runId) { service.#live.delete(uuid(runId)); service.#diagnosticSnapshots.delete(uuid(runId)); },
            async setState(exec, input) { const { raw, args } = mutation(input, ['state']); const state = enumeration(raw.state, ['awaitingPermission', 'running', 'paused', 'humanControl']); return service.#mutate(exec, args, 'state', { ...args, state }, record => { if (record.cancel)
                fail('CANCEL_PENDING'); const transitions: Record<string, readonly string[]> = { queued: ['awaitingPermission', 'running'], awaitingPermission: ['running', 'paused'], running: ['paused', 'humanControl'], paused: ['running', 'humanControl'], humanControl: ['paused', 'running'] }; if (!transitions[record.state]?.includes(state))
                fail('INVALID_TRANSITION'); record.state = state; }); },
            async commitEvidence(exec, input) { const { raw, args } = mutation(input, ['evidence']); const evidence = parseEvidence(raw.evidence); return service.#mutate(exec, args, 'evidence', { ...args, evidence }, async (record, checkpoint) => { service.#running(record); if (evidence.runId !== record.runId || evidence.environmentId !== record.binding.environmentId || evidence.epoch !== record.binding.epoch || !record.binding.targetIds.includes(evidence.targetId) || evidence.geometryDigest !== hash(evidence.geometry))
                fail('EVIDENCE_BINDING_MISMATCH'); const attempt = record.attempts.find(x => x.attemptId === evidence.attemptId && x.checkId === evidence.checkId && x.verdict === null); if (!attempt || evidence.capturedAt < attempt.startedAt || evidence.capturedAt > service.#now())
                fail('EVIDENCE_BINDING_MISMATCH'); if (record.evidence.some(x => x.evidenceId === evidence.evidenceId))
                fail('DUPLICATE_ID'); if (record.evidence.length >= record.budget.maxEvidence)
                fail('BUDGET_EXHAUSTED'); const available = await service.#evidenceAvailable(evidence, exec.signal); checkpoint(); if (!available)
                fail('EVIDENCE_UNAVAILABLE'); record.evidence.push(evidence); }); },
            async recordAction(exec, input) { const { raw, args } = mutation(input, ['receipt']); const receipt = parseAction(raw.receipt); return service.#mutate(exec, args, 'action', { ...args, receipt }, record => { service.#running(record); if (receipt.environmentId !== record.binding.environmentId || receipt.epoch !== record.binding.epoch || !record.binding.targetIds.includes(receipt.targetId))
                fail('ACTION_BINDING_MISMATCH'); if (record.actions.some(x => x.receiptId === receipt.receiptId))
                fail('DUPLICATE_ID'); const existing = record.actions.filter(x => x.actionId === receipt.actionId); if (receipt.phase === 'issued') {
                if (existing.length)
                    fail('ACTION_REPLAY_FORBIDDEN');
                if (record.actions.filter(x => x.phase === 'issued').length >= record.budget.maxActions)
                    fail('BUDGET_EXHAUSTED');
            }
            else {
                const first = existing[0];
                if (existing.length !== 1 || first?.phase !== 'issued' || first.kind !== receipt.kind || first.callId !== receipt.callId || first.frameId !== receipt.frameId || first.targetId !== receipt.targetId)
                    fail('ACTION_BINDING_MISMATCH');
            } record.actions.push(receipt); if (receipt.phase === 'unknown') {
                record.state = 'inconclusive';
                record.endedAt = service.#now();
            } }); },
            async requestCancel(exec, input) { const args = parseMutation(input); return service.#mutate(exec, args, 'cancel-request', args, record => { if (record.cancel)
                fail('CANCEL_PENDING'); record.cancel = { requestedAt: service.#now(), confirmedAt: null, epoch: record.binding.epoch, quiescent: false }; record.state = 'paused'; }); },
            async confirmCancelled(exec, input) { const { raw, args } = mutation(input, ['epoch', 'quiescent']); const epoch = integer(raw.epoch); if (typeof raw.quiescent !== 'boolean')
                fail('INVALID_REQUEST'); const quiescent = raw.quiescent; return service.#mutate(exec, args, 'cancel-confirm', { ...args, epoch, quiescent }, record => { if (!record.cancel || record.cancel.epoch !== epoch)
                fail('CANCEL_BINDING_MISMATCH'); record.cancel.quiescent = quiescent; record.cancel.confirmedAt = quiescent ? service.#now() : null; record.state = quiescent ? 'cancelled' : 'inconclusive'; record.endedAt = service.#now(); }, true); },
        };
        const reader: RunHistoryReader = {
            get: (scope, id) => service.#readHistory(scope, id),
            async list(scope) { service.#readGuard(scope); const records = await service.#o.store.list(); service.#readGuard(scope); const out: Array<{
                runId: string;
                title: string;
                state: RunState;
                revision: number;
                readOnly: true;
            }> = []; for (const r of records.filter(x => x.binding.chatSessionId === scope.chatSessionId).sort((a, b) => b.createdAt - a.createdAt)) {
                const view = await service.#readHistory(scope, r.runId);
                service.#readGuard(scope);
                out.push({ runId: r.runId, title: r.title, state: view.state, revision: r.revision, readOnly: true });
            } return out; },
            async export(scope, id) { const view = await service.#readHistory(scope, id); service.#readGuard(scope); return service.#exportView(view); },
            async evidence(scope, runId, evidenceId) { const id = uuid(evidenceId), view = await service.#readHistory(scope, runId); service.#readGuard(scope); const ref = view.record.evidence.find(x => x.evidenceId === id); if (!ref || view.unavailableEvidenceIds.includes(id))
                fail('EVIDENCE_UNAVAILABLE'); return clone(ref); },
        };
        return { service, recorder: Object.freeze(recorder), reader: Object.freeze(reader) };
    }
}
