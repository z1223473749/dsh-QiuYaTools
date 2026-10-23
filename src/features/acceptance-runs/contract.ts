/** Versioned facts. No control lease, SDK instance, filename, URL or input payload is serialized here. */
export const RUN_SCHEMA_VERSION = 1 as const;
export const RUN_STATES = ['queued', 'awaitingPermission', 'running', 'paused', 'humanControl', 'passed', 'failed', 'cancelled', 'blocked', 'inconclusive'] as const;
export type RunState = typeof RUN_STATES[number];
export type Verdict = 'passed' | 'failed' | 'blocked' | 'inconclusive';
export const TERMINAL_STATES: readonly RunState[] = ['passed', 'failed', 'cancelled', 'blocked', 'inconclusive'];
export const VERIFY_CODES = ['VERIFIED', 'BUSINESS_MISMATCH', 'ENVIRONMENT_UNAVAILABLE', 'VERIFIER_UNAVAILABLE', 'VERIFIER_FAILED', 'EVIDENCE_UNAVAILABLE', 'MISSING_EVIDENCE', 'ACTION_UNKNOWN', 'NOT_EXECUTED', 'CANCEL_UNCONFIRMED', 'INTERRUPTED', 'BUDGET_EXHAUSTED'] as const;
export type VerifyCode = typeof VERIFY_CODES[number];
export const ACTION_KINDS = ['click', 'move', 'drag', 'scroll', 'type', 'key', 'navigate', 'openTab', 'closeTab', 'selectorClick', 'selectorType'] as const;
export interface RunBudget {
    maxAttempts: number;
    maxActions: number;
    maxEvidence: number;
    deadlineMs: number;
}
export interface AgentBinding {
    chatSessionId: string;
    agentId: string;
    rootAgentId: string;
    agentInstanceId: string;
    environmentId: string;
    epoch: number;
    targetIds: string[];
}
export interface RunGeometry {
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
}
export interface CheckPlan {
    checkId: string;
    title: string;
    expected: string;
    required: boolean;
    minimumEvidence: number;
    verifierId: string | null;
}
export interface Assessment {
    proposal: Verdict;
    summaryCode: 'EXPECTATION_MET' | 'EXPECTATION_NOT_MET' | 'NEEDS_EVIDENCE' | 'ENVIRONMENT_BLOCKED';
}
export interface CheckAttempt {
    attemptId: string;
    checkId: string;
    startedAt: number;
    endedAt: number | null;
    verdict: Verdict | null;
    verificationCode: VerifyCode | null;
    verifier: {
        id: string;
        version: string;
    } | null;
    evidenceIds: string[];
    assessment: Assessment | null;
}
export interface EvidenceRef {
    evidenceId: string;
    runId: string;
    checkId: string;
    attemptId: string;
    environmentId: string;
    targetId: string;
    frameId: string;
    epoch: number;
    geometry: RunGeometry;
    geometryDigest: string;
    capturedAt: number;
    source: 'computer-observe';
    sha256: string;
    mediaType: 'image/jpeg' | 'image/png';
    bytes: number;
    width: number;
    height: number;
    attachmentId: string;
    commitState: 'committed';
}
export interface ActionReceipt {
    receiptId: string;
    callId: string;
    rootCallId: string | null;
    actionId: string;
    kind: typeof ACTION_KINDS[number];
    targetId: string;
    frameId: string;
    environmentId: string;
    epoch: number;
    phase: 'issued' | 'acknowledged' | 'unknown';
    at: number;
    errorCode: 'ACTION_UNCONFIRMED' | 'ACTION_FAILED' | null;
}
export interface MutationReceipt {
    key: string;
    digest: string;
    revision: number;
    snapshotId: string;
    operation: string;
}
export interface RunRecord {
    schemaVersion: 1;
    runId: string;
    binding: AgentBinding;
    title: string;
    previousRunId: string | null;
    planRevision: 1;
    planSHA256: string;
    checks: CheckPlan[];
    attempts: CheckAttempt[];
    evidence: EvidenceRef[];
    actions: ActionReceipt[];
    receipts: MutationReceipt[];
    revision: number;
    createdAt: number;
    updatedAt: number;
    endedAt: number | null;
    state: RunState;
    budget: RunBudget;
    versions: {
        plugin: string;
        runtime: string;
        helper: string;
        protocol: string;
        model: string;
    };
    cancel: {
        requestedAt: number;
        confirmedAt: number | null;
        epoch: number;
        quiescent: boolean;
    } | null;
}
export interface RunView {
    record: RunRecord;
    state: RunState;
    readOnly: boolean;
    recovery: 'none' | 'restart-interrupted' | 'evidence-unavailable' | 'historical';
    unavailableEvidenceIds: string[];
    replayPermitted: false;
}
export interface BeginInput {
    title: string;
    checks: CheckPlan[];
    budget: RunBudget;
    idempotencyKey: string;
    previousRunId: string | null;
}
export interface MutationInput {
    runId: string;
    expectedRevision: number;
    idempotencyKey: string;
}
export type CheckpointInput = MutationInput & ({
    phase: 'start';
    checkId: string;
} | {
    phase: 'verify';
    checkId: string;
    attemptId: string;
    evidenceIds: string[];
    assessment: Assessment;
});
export class RunError extends Error {
    constructor(readonly code: string) { super(code); this.name = 'RunError'; }
}
export function fail(code: string): never { throw new RunError(code); }
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        fail('INVALID_REQUEST');
    if (Object.getOwnPropertySymbols(value).length)
        fail('INVALID_REQUEST');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).some(key => !keys.includes(key) || !Object.hasOwn(descriptors[key]!, 'value')))
        fail('INVALID_REQUEST');
    return value as Record<string, unknown>;
}
export function text(value: unknown, max = 256): string { if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/u.test(value))
    fail('INVALID_REQUEST'); return value; }
export function opaque(value: unknown): string { return text(value, 256); }
export function uuid(value: unknown): string { const v = text(value, 36); if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v))
    fail('INVALID_REQUEST'); return v; }
export function key(value: unknown): string { const v = text(value, 96); if (!/^[a-zA-Z0-9_.:-]+$/u.test(v))
    fail('INVALID_REQUEST'); return v; }
export function digest(value: unknown): string { const v = text(value, 64); if (!/^[a-f0-9]{64}$/u.test(v))
    fail('INVALID_REQUEST'); return v; }
export function integer(value: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    fail('INVALID_REQUEST'); return value; }
export function enumeration<T extends string>(value: unknown, values: readonly T[]): T { if (typeof value !== 'string' || !values.includes(value as T))
    fail('INVALID_REQUEST'); return value as T; }
export function array<T>(value: unknown, parse: (v: unknown) => T, maximum: number): T[] { if (!Array.isArray(value) || value.length > maximum)
    fail('INVALID_REQUEST'); return value.map(parse); }
function nullable<T>(value: unknown, parse: (v: unknown) => T): T | null { return value === null ? null : parse(value); }
function bool(value: unknown): boolean { if (typeof value !== 'boolean')
    fail('INVALID_REQUEST'); return value; }
function unique(values: readonly string[]): void { if (new Set(values).size !== values.length)
    fail('DUPLICATE_ID'); }
export function parseGeometry(value: unknown): RunGeometry { const v = object(value, ['x', 'y', 'width', 'height', 'scale']); const finite = (x: unknown, min: number, max: number) => { if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max)
    fail('INVALID_REQUEST'); return x; }; return { x: finite(v.x, -1e7, 1e7), y: finite(v.y, -1e7, 1e7), width: finite(v.width, Number.MIN_VALUE, 65536), height: finite(v.height, Number.MIN_VALUE, 65536), scale: finite(v.scale, Number.MIN_VALUE, 16) }; }
export function parseBinding(value: unknown): AgentBinding { const v = object(value, ['chatSessionId', 'agentId', 'rootAgentId', 'agentInstanceId', 'environmentId', 'epoch', 'targetIds']); const result = { chatSessionId: opaque(v.chatSessionId), agentId: opaque(v.agentId), rootAgentId: opaque(v.rootAgentId), agentInstanceId: uuid(v.agentInstanceId), environmentId: uuid(v.environmentId), epoch: integer(v.epoch), targetIds: array(v.targetIds, opaque, 16) }; if (result.agentId !== result.rootAgentId || !result.targetIds.length)
    fail('NOT_ROOT_AGENT'); unique(result.targetIds); return result; }
export function parseCheck(value: unknown): CheckPlan { const v = object(value, ['checkId', 'title', 'expected', 'required', 'minimumEvidence', 'verifierId']); return { checkId: key(v.checkId), title: text(v.title, 120), expected: text(v.expected, 500), required: bool(v.required), minimumEvidence: integer(v.minimumEvidence, 8, 1), verifierId: nullable(v.verifierId, key) }; }
export function parseBudget(value: unknown): RunBudget { const v = object(value, ['maxAttempts', 'maxActions', 'maxEvidence', 'deadlineMs']); return { maxAttempts: integer(v.maxAttempts, 64, 1), maxActions: integer(v.maxActions, 128, 1), maxEvidence: integer(v.maxEvidence, 64, 1), deadlineMs: integer(v.deadlineMs, 3600000, 1000) }; }
export function parseBegin(value: unknown): BeginInput { const v = object(value, ['title', 'checks', 'budget', 'idempotencyKey', 'previousRunId']); const checks = array(v.checks, parseCheck, 32); unique(checks.map(x => x.checkId)); return { title: text(v.title, 160), checks, budget: parseBudget(v.budget), idempotencyKey: key(v.idempotencyKey), previousRunId: nullable(v.previousRunId, uuid) }; }
export function parseMutation(value: unknown): MutationInput { const v = object(value, ['runId', 'expectedRevision', 'idempotencyKey']); return { runId: uuid(v.runId), expectedRevision: integer(v.expectedRevision, 128, 1), idempotencyKey: key(v.idempotencyKey) }; }
export function parseAssessment(value: unknown): Assessment { const v = object(value, ['proposal', 'summaryCode']); return { proposal: enumeration(v.proposal, ['passed', 'failed', 'blocked', 'inconclusive']), summaryCode: enumeration(v.summaryCode, ['EXPECTATION_MET', 'EXPECTATION_NOT_MET', 'NEEDS_EVIDENCE', 'ENVIRONMENT_BLOCKED']) }; }
export function parseCheckpoint(value: unknown): CheckpointInput { const v = object(value, ['runId', 'expectedRevision', 'idempotencyKey', 'phase', 'checkId', 'attemptId', 'evidenceIds', 'assessment']); const base = parseMutation({ runId: v.runId, expectedRevision: v.expectedRevision, idempotencyKey: v.idempotencyKey }); const phase = enumeration(v.phase, ['start', 'verify']); const checkId = key(v.checkId); if (phase === 'start') {
    if (Object.keys(v).some(k => ['attemptId', 'evidenceIds', 'assessment'].includes(k)))
        fail('INVALID_REQUEST');
    return { ...base, phase, checkId };
} ; const ids = array(v.evidenceIds, uuid, 8); unique(ids); return { ...base, phase, checkId, attemptId: uuid(v.attemptId), evidenceIds: ids, assessment: parseAssessment(v.assessment) }; }
export function parseEvidence(value: unknown): EvidenceRef { const v = object(value, ['evidenceId', 'runId', 'checkId', 'attemptId', 'environmentId', 'targetId', 'frameId', 'epoch', 'geometry', 'geometryDigest', 'capturedAt', 'source', 'sha256', 'mediaType', 'bytes', 'width', 'height', 'attachmentId', 'commitState']); return { evidenceId: uuid(v.evidenceId), runId: uuid(v.runId), checkId: key(v.checkId), attemptId: uuid(v.attemptId), environmentId: uuid(v.environmentId), targetId: opaque(v.targetId), frameId: opaque(v.frameId), epoch: integer(v.epoch), geometry: parseGeometry(v.geometry), geometryDigest: digest(v.geometryDigest), capturedAt: integer(v.capturedAt), source: enumeration(v.source, ['computer-observe']), sha256: digest(v.sha256), mediaType: enumeration(v.mediaType, ['image/jpeg', 'image/png']), bytes: integer(v.bytes, 20 * 1024 * 1024, 1), width: integer(v.width, 16384, 1), height: integer(v.height, 16384, 1), attachmentId: key(v.attachmentId), commitState: enumeration(v.commitState, ['committed']) }; }
export function parseAction(value: unknown): ActionReceipt { const v = object(value, ['receiptId', 'callId', 'rootCallId', 'actionId', 'kind', 'targetId', 'frameId', 'environmentId', 'epoch', 'phase', 'at', 'errorCode']); return { receiptId: uuid(v.receiptId), callId: opaque(v.callId), rootCallId: nullable(v.rootCallId, opaque), actionId: opaque(v.actionId), kind: enumeration(v.kind, ACTION_KINDS), targetId: opaque(v.targetId), frameId: opaque(v.frameId), environmentId: uuid(v.environmentId), epoch: integer(v.epoch), phase: enumeration(v.phase, ['issued', 'acknowledged', 'unknown']), at: integer(v.at), errorCode: nullable(v.errorCode, x => enumeration(x, ['ACTION_UNCONFIRMED', 'ACTION_FAILED'])) }; }
function parseAttempt(value: unknown): CheckAttempt { const v = object(value, ['attemptId', 'checkId', 'startedAt', 'endedAt', 'verdict', 'verificationCode', 'verifier', 'evidenceIds', 'assessment']); return { attemptId: uuid(v.attemptId), checkId: key(v.checkId), startedAt: integer(v.startedAt), endedAt: nullable(v.endedAt, integer), verdict: nullable(v.verdict, x => enumeration(x, ['passed', 'failed', 'blocked', 'inconclusive'])), verificationCode: nullable(v.verificationCode, x => enumeration(x, VERIFY_CODES)), verifier: nullable(v.verifier, x => { const p = object(x, ['id', 'version']); return { id: key(p.id), version: key(p.version) }; }), evidenceIds: array(v.evidenceIds, uuid, 8), assessment: nullable(v.assessment, parseAssessment) }; }
export function parseRunRecord(value: unknown): RunRecord {
    const v = object(value, ['schemaVersion', 'runId', 'binding', 'title', 'previousRunId', 'planRevision', 'planSHA256', 'checks', 'attempts', 'evidence', 'actions', 'receipts', 'revision', 'createdAt', 'updatedAt', 'endedAt', 'state', 'budget', 'versions', 'cancel']);
    if (v.schemaVersion !== 1)
        fail('UNSUPPORTED_SCHEMA');
    if (v.planRevision !== 1)
        fail('INVALID_RECORD');
    const versions = object(v.versions, ['plugin', 'runtime', 'helper', 'protocol', 'model']);
    const version = (x: unknown) => text(x, 96);
    const r: RunRecord = { schemaVersion: 1, runId: uuid(v.runId), binding: parseBinding(v.binding), title: text(v.title, 160), previousRunId: nullable(v.previousRunId, uuid), planRevision: 1, planSHA256: digest(v.planSHA256), checks: array(v.checks, parseCheck, 32), attempts: array(v.attempts, parseAttempt, 64), evidence: array(v.evidence, parseEvidence, 64), actions: array(v.actions, parseAction, 256), receipts: array(v.receipts, x => { const p = object(x, ['key', 'digest', 'revision', 'snapshotId', 'operation']); return { key: key(p.key), digest: digest(p.digest), revision: integer(p.revision, 128, 1), snapshotId: uuid(p.snapshotId), operation: key(p.operation) }; }, 128), revision: integer(v.revision, 128, 1), createdAt: integer(v.createdAt), updatedAt: integer(v.updatedAt), endedAt: nullable(v.endedAt, integer), state: enumeration(v.state, RUN_STATES), budget: parseBudget(v.budget), versions: { plugin: version(versions.plugin), runtime: version(versions.runtime), helper: version(versions.helper), protocol: version(versions.protocol), model: version(versions.model) }, cancel: nullable(v.cancel, x => { const p = object(x, ['requestedAt', 'confirmedAt', 'epoch', 'quiescent']); return { requestedAt: integer(p.requestedAt), confirmedAt: nullable(p.confirmedAt, integer), epoch: integer(p.epoch), quiescent: bool(p.quiescent) }; }) };
    unique(r.checks.map(x => x.checkId));
    unique(r.attempts.map(x => x.attemptId));
    unique(r.evidence.map(x => x.evidenceId));
    unique(r.actions.map(x => x.receiptId));
    unique(r.receipts.map(x => x.key));
    if (r.updatedAt < r.createdAt || r.attempts.length > r.budget.maxAttempts || r.evidence.length > r.budget.maxEvidence || r.actions.filter(x => x.phase === 'issued').length > r.budget.maxActions || r.receipts.length !== r.revision)
        fail('INVALID_RECORD');
    r.receipts.forEach((x, i) => { if (x.revision !== i + 1)
        fail('INVALID_RECORD'); });
    for (const attempt of r.attempts) {
        if (!r.checks.some(x => x.checkId === attempt.checkId) || (attempt.verdict === null) !== (attempt.endedAt === null) || (attempt.verdict === null) !== (attempt.verificationCode === null))
            fail('INVALID_RECORD');
        unique(attempt.evidenceIds);
        for (const id of attempt.evidenceIds)
            if (!r.evidence.some(e => e.evidenceId === id && e.attemptId === attempt.attemptId && e.checkId === attempt.checkId))
                fail('EVIDENCE_BINDING_MISMATCH');
        if (attempt.verdict === 'passed' && (!attempt.verifier || attempt.verificationCode !== 'VERIFIED'))
            fail('UNVERIFIED_PASS');
    }
    for (const e of r.evidence)
        if (e.runId !== r.runId || e.environmentId !== r.binding.environmentId || e.epoch !== r.binding.epoch || !r.binding.targetIds.includes(e.targetId) || !r.attempts.some(a => a.attemptId === e.attemptId && a.checkId === e.checkId))
            fail('EVIDENCE_BINDING_MISMATCH');
    const actionGroups = new Map<string, ActionReceipt[]>();
    for (const a of r.actions) {
        if (a.environmentId !== r.binding.environmentId || a.epoch !== r.binding.epoch || !r.binding.targetIds.includes(a.targetId))
            fail('ACTION_BINDING_MISMATCH');
        const prior = actionGroups.get(a.actionId) ?? [];
        if (a.phase === 'issued') {
            if (prior.length || a.errorCode !== null)
                fail('INVALID_RECORD');
        }
        else {
            const first = prior[0];
            if (prior.length !== 1 || first?.phase !== 'issued' || first.callId !== a.callId || first.kind !== a.kind || first.frameId !== a.frameId || first.targetId !== a.targetId || a.at < first.at)
                fail('ACTION_BINDING_MISMATCH');
        }
        ;
        prior.push(a);
        actionGroups.set(a.actionId, prior);
    }
    if (TERMINAL_STATES.includes(r.state) !== (r.endedAt !== null))
        fail('INVALID_RECORD');
    if (r.state === 'cancelled' && (!r.cancel?.quiescent || r.cancel.confirmedAt === null))
        fail('CANCEL_UNCONFIRMED');
    if (r.state === 'passed' && aggregateRun(r) !== 'passed')
        fail('UNVERIFIED_PASS');
    return r;
}
/** Pure aggregate; never accepts a model proposal as a verdict. */
export function aggregateRun(run: Pick<RunRecord, 'checks' | 'attempts' | 'evidence' | 'actions' | 'cancel'>): Verdict {
    if (run.cancel && !run.cancel.quiescent)
        return 'inconclusive';
    const issued = run.actions.filter(x => x.phase === 'issued');
    if (run.actions.some(x => x.phase === 'unknown') || issued.some(x => !run.actions.some(a => a.actionId === x.actionId && a.phase === 'acknowledged')))
        return 'inconclusive';
    const required = run.checks.filter(x => x.required);
    if (!required.length)
        return 'inconclusive';
    const latest = required.map(check => ({ check, attempt: run.attempts.filter(x => x.checkId === check.checkId).at(-1) }));
    if (latest.some(x => x.attempt?.verdict === 'failed'))
        return 'failed';
    if (latest.some(x => x.attempt?.verdict === 'blocked'))
        return 'blocked';
    if (latest.some(({ check, attempt }) => !attempt || attempt.verdict !== 'passed' || !attempt.verifier || attempt.verificationCode !== 'VERIFIED' || attempt.evidenceIds.length < check.minimumEvidence || attempt.evidenceIds.some(id => !run.evidence.some(e => e.evidenceId === id && e.attemptId === attempt.attemptId && e.checkId === check.checkId && e.commitState === 'committed'))))
        return 'inconclusive';
    return 'passed';
}
/** Deterministic bounded JSON; rejects accessors, cycles, exotic prototypes and non-finite values. */
export function canonicalJSON(value: unknown): string {
    const seen = new Set<object>();
    let nodes = 0;
    const visit = (v: unknown, depth: number): unknown => { if (++nodes > 100000 || depth > 20)
        fail('PAYLOAD_LIMIT'); if (v === null || typeof v === 'boolean' || typeof v === 'string')
        return v; if (typeof v === 'number') {
        if (!Number.isFinite(v))
            fail('INVALID_REQUEST');
        return v;
    } if (typeof v !== 'object')
        fail('INVALID_REQUEST'); if (seen.has(v))
        fail('INVALID_REQUEST'); seen.add(v); let result: unknown; if (Array.isArray(v)) {
        if (v.length > 8192)
            fail('PAYLOAD_LIMIT');
        result = v.map(x => visit(x, depth + 1));
    }
    else {
        const keys = Object.keys(Object.getOwnPropertyDescriptors(v));
        const o = object(v, keys);
        const sorted: Record<string, unknown> = Object.create(null);
        for (const k of keys.sort())
            sorted[k] = visit(o[k], depth + 1);
        result = sorted;
    } seen.delete(v); return result; };
    const out = JSON.stringify(visit(value, 0));
    if (out.length > 1024 * 1024)
        fail('PAYLOAD_LIMIT');
    return out;
}
