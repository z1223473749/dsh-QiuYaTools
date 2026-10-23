import { RUN_STATES, integer, object, opaque, text, uuid, enumeration, parseRunRecord } from './contract.ts';
import type { RunRecord, RunState, RunView } from './contract.ts';
import type { MutationResult } from './service.ts';
export const RUN_TOOL_NAMES = ['qiuya_run_begin', 'qiuya_run_get', 'qiuya_run_checkpoint', 'qiuya_run_finish'] as const;
export type RunToolName = typeof RUN_TOOL_NAMES[number];
export const RUN_ENDPOINT = 'qiuya-tools.runs.read';
export interface RunSummary {
    runId: string;
    chatSessionId: string;
    revision: number;
    title: string;
    state: RunState;
    requiredPassed: number;
    requiredTotal: number;
    evidenceCount: number;
    attemptCount: number;
    createdAt: number;
    updatedAt: number;
    endedAt: number | null;
    readOnly: boolean;
    recovery: RunView['recovery'];
}
export interface RunPresentationMeta {
    kind: 'qiuya-run';
    version: 1;
    tool: RunToolName;
    run: RunSummary;
}
export interface RunToolValue {
    run: RunSummary;
    checks: Array<{
        checkId: string;
        title: string;
        expected: string;
        required: boolean;
        attempts: Array<{
            attemptId: string;
            verdict: string | null;
            verificationCode: string | null;
            evidenceIds: string[];
            committedEvidenceIds: string[];
        }>;
    }>;
}
export const RUN_STATE_LABELS: Record<RunState, string> = { queued: '等待开始', awaitingPermission: '等待授权', running: '进行中', paused: '已暂停', humanControl: '人工接管中', passed: '验收通过', failed: '发现问题', cancelled: '已取消', blocked: '暂时无法继续', inconclusive: '结果待确认' };
export function summaryFromView(view: RunView): RunSummary {
    const r = view.record, required = r.checks.filter(c => c.required), unavailable = new Set(view.unavailableEvidenceIds);
    const requiredPassed = required.filter(c => { const a = r.attempts.filter(a => a.checkId === c.checkId).at(-1); return a?.verdict === 'passed' && a.verificationCode === 'VERIFIED' && a.verifier !== null && a.evidenceIds.length >= c.minimumEvidence && a.evidenceIds.every(id => !unavailable.has(id) && r.evidence.some(e => e.evidenceId === id && e.commitState === 'committed')); }).length;
    return { runId: r.runId, chatSessionId: r.binding.chatSessionId, revision: r.revision, title: r.title, state: view.state, requiredPassed, requiredTotal: required.length, evidenceCount: r.evidence.length, attemptCount: r.attempts.length, createdAt: r.createdAt, updatedAt: r.updatedAt, endedAt: r.endedAt, readOnly: view.readOnly, recovery: view.recovery };
}
export function viewFromMutation(value: MutationResult): RunView { return { record: value.record, state: value.record.state, readOnly: value.readOnly, recovery: 'none', unavailableEvidenceIds: [], replayPermitted: false }; }
export function runToolValue(view: RunView): RunToolValue { return { run: summaryFromView(view), checks: view.record.checks.map(c => ({ checkId: c.checkId, title: c.title, expected: c.expected, required: c.required, attempts: view.record.attempts.filter(a => a.checkId === c.checkId).map(a => ({ attemptId: a.attemptId, verdict: a.verdict, verificationCode: a.verificationCode, evidenceIds: [...a.evidenceIds], committedEvidenceIds: view.record.evidence.filter(e => e.attemptId === a.attemptId).map(e => e.evidenceId) })) })) }; }
export function parseRunSummary(value: unknown): RunSummary {
    const v = object(value, ['runId', 'chatSessionId', 'revision', 'title', 'state', 'requiredPassed', 'requiredTotal', 'evidenceCount', 'attemptCount', 'createdAt', 'updatedAt', 'endedAt', 'readOnly', 'recovery']);
    if (typeof v.readOnly !== 'boolean')
        throw Error('INVALID_SUMMARY');
    const result: RunSummary = { runId: uuid(v.runId), chatSessionId: opaque(v.chatSessionId), revision: integer(v.revision, 128, 1), title: text(v.title, 160), state: enumeration(v.state, RUN_STATES), requiredPassed: integer(v.requiredPassed, 32), requiredTotal: integer(v.requiredTotal, 32), evidenceCount: integer(v.evidenceCount, 64), attemptCount: integer(v.attemptCount, 64), createdAt: integer(v.createdAt), updatedAt: integer(v.updatedAt), endedAt: v.endedAt === null ? null : integer(v.endedAt), readOnly: v.readOnly, recovery: enumeration(v.recovery, ['none', 'restart-interrupted', 'evidence-unavailable', 'historical']) };
    if (result.requiredPassed > result.requiredTotal || result.updatedAt < result.createdAt || result.state === 'passed' && (result.requiredTotal === 0 || result.requiredPassed !== result.requiredTotal))
        throw Error('INVALID_SUMMARY');
    return result;
}
export function parseRunMeta(value: unknown): RunPresentationMeta | null { try {
    const v = object(value, ['kind', 'version', 'tool', 'run']);
    if (v.kind !== 'qiuya-run' || v.version !== 1)
        return null;
    return { kind: 'qiuya-run', version: 1, tool: enumeration(v.tool, RUN_TOOL_NAMES), run: parseRunSummary(v.run) };
}
catch {
    return null;
} }
export function parseRunView(value: unknown): RunView {
    const v = object(value, ['record', 'state', 'readOnly', 'recovery', 'unavailableEvidenceIds', 'replayPermitted']), record = parseRunRecord(v.record);
    if (typeof v.readOnly !== 'boolean' || v.replayPermitted !== false || !Array.isArray(v.unavailableEvidenceIds) || v.unavailableEvidenceIds.length > 64)
        throw Error('INVALID_RUN_VIEW');
    const unavailableEvidenceIds = v.unavailableEvidenceIds.map(uuid);
    if (unavailableEvidenceIds.some(id => !record.evidence.some(e => e.evidenceId === id)))
        throw Error('INVALID_RUN_VIEW');
    const state = enumeration(v.state, RUN_STATES), recovery = enumeration(v.recovery, ['none', 'restart-interrupted', 'evidence-unavailable', 'historical']);
    if (state === 'passed' && (record.state !== 'passed' || unavailableEvidenceIds.length !== 0 || recovery === 'restart-interrupted' || recovery === 'evidence-unavailable') || state !== record.state && state !== 'inconclusive')
        throw Error('INVALID_RUN_VIEW');
    return { record, state, readOnly: v.readOnly, recovery, unavailableEvidenceIds, replayPermitted: false };
}
export function runAddress(chatSessionId: string, runId?: string): string { return 'dsh-resource://qiuya-run/' + encodeURIComponent(opaque(chatSessionId)) + '/' + (runId === undefined ? 'history' : uuid(runId)); }
export function parseRunAddress(address: string): {
    chatSessionId: string;
    runId: string | null;
} | null { try {
    const u = new URL(address);
    if (u.protocol !== 'dsh-resource:' || u.hostname !== 'qiuya-run' || u.search || u.hash || u.username || u.password || u.port)
        return null;
    const parts = u.pathname.split('/');
    if (parts.length !== 3 || !parts[1] || !parts[2])
        return null;
    const chatSessionId = opaque(decodeURIComponent(parts[1]));
    return { chatSessionId, runId: parts[2] === 'history' ? null : uuid(parts[2]) };
}
catch {
    return null;
} }
export type RunHistoryRow = {
    runId: string;
    title: string;
    state: RunState;
    revision: number;
    readOnly: true;
};
export function parseHistory(value: unknown): RunHistoryRow[] { if (!Array.isArray(value) || value.length > 256)
    throw Error('INVALID_HISTORY'); return value.map(row => { const v = object(row, ['runId', 'title', 'state', 'revision', 'readOnly']); if (v.readOnly !== true)
    throw Error('INVALID_HISTORY'); return { runId: uuid(v.runId), title: text(v.title, 160), state: enumeration(v.state, RUN_STATES), revision: integer(v.revision, 128, 1), readOnly: true }; }); }
