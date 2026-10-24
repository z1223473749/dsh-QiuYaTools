import { createHash } from 'node:crypto';
import type { ComputerObservation } from '../computer-use/contract.ts';
import type { EvidenceRef, AgentBinding, Verdict, VerifyCode } from '../acceptance-runs/contract.ts';
import { canonicalJSON } from '../acceptance-runs/contract.ts';
import type { RunExec, RunVerifier } from '../acceptance-runs/service.ts';
import { WORKFLOW_VERIFIER_ID, parseWorkflowPlan, sameJSON } from './contract.ts';
import type { WorkflowPlan, WorkflowRule } from './contract.ts';
const digest = (value: unknown) => createHash('sha256').update(canonicalJSON(value)).digest('hex');
interface Result {
    verdict: Verdict;
    code: VerifyCode;
}
interface LiveRun {
    assertCurrent?(): void;
    source: 'browser' | 'desktop';
    plan: WorkflowPlan;
    binding: AgentBinding;
    agent: object;
    attempts: Map<string, string>;
    facts: Map<string, {
        evidence: EvidenceRef;
        result: Result;
        ruleDigest: string;
    }>;
}
const unavailable = (): Result => ({ verdict: 'inconclusive', code: 'VERIFIER_UNAVAILABLE' });
/** Pure positive app-state predicates. Missing/truncated accessibility cannot prove absence. */
export function evaluateObservation(rule: WorkflowRule, elements: string, source: 'browser' | 'desktop'): Result {
    if (!elements || elements.length >= (source === 'browser' ? 200000 : 24000) || rule.kind === 'unavailable')
        return unavailable();
    if (rule.kind === 'browserValue') {
        if (source !== 'browser')
            return unavailable();
        const lines = elements.split('\n');
        // The production capture bounds AX rows and values. A boundary-sized projection cannot prove uniqueness/exactness.
        if (lines.length >= 1500)
            return unavailable();
        const rows: {
            role: string;
            name: string;
            value?: string;
        }[] = [];
        try {
            for (const line of lines) {
                const v: unknown = JSON.parse(line);
                if (!v || typeof v !== 'object' || Array.isArray(v))
                    return unavailable();
                const row = v as Record<string, unknown>;
                if (typeof row.role !== 'string' || row.name !== undefined && typeof row.name !== 'string')
                    return unavailable();
                if (row.role === rule.role && (row.name ?? '') === rule.name) {
                    if (row.value !== undefined && typeof row.value !== 'string')
                        return unavailable();
                    rows.push({ role: row.role, name: String(row.name ?? ''), ...(typeof row.value === 'string' ? { value: row.value } : {}) });
                }
            }
        }
        catch {
            return unavailable();
        }
        if (rows.length !== 1 || rows[0]!.value === undefined || rows[0]!.value.length >= 4000)
            return unavailable();
        return rows[0]!.value === rule.expected ? { verdict: 'passed', code: 'VERIFIED' } : { verdict: 'failed', code: 'BUSINESS_MISMATCH' };
    }
    if (source !== 'desktop' || rule.expected.length >= 300 || (rule.failure?.length ?? 0) >= 300)
        return unavailable();
    const tokens: string[] = [];
    for (const raw of elements.split('\n')) {
        const line = raw.trim();
        if (/^AX[A-Za-z]+(?: \| |$)/u.test(line))
            tokens.push(...line.split(' | ').slice(1));
        else {
            const windows = /^ControlType\.[A-Za-z]+ name=(.*) id=.* enabled=(?:True|False|true|false) bounds=[\d.,+\-Ee]+$/u.exec(line);
            if (windows)
                tokens.push(windows[1]!);
        }
    }
    if (!tokens.length)
        return unavailable();
    if (rule.failure !== null && tokens.includes(rule.failure))
        return { verdict: 'failed', code: 'BUSINESS_MISMATCH' };
    if (tokens.includes(rule.expected))
        return { verdict: 'passed', code: 'VERIFIED' };
    return unavailable();
}
/** Host-only receipt sink; never exposes capture/attach/authorize as a model tool or owner DTO. */
export class WorkflowEvidenceVerifier {
    private readonly runs = new Map<string, LiveRun>();
    readonly verifier: RunVerifier = { id: WORKFLOW_VERIFIER_ID, version: '1', verify: async (input, signal) => {
            signal.throwIfAborted();
            const live = this.runs.get(input.run.runId);
            if (!live || !sameJSON(live.binding, input.run.binding) || live.attempts.get(input.attempt.attemptId) !== input.check.checkId)
                return unavailable();
            try {
                live.assertCurrent?.();
            }
            catch {
                this.runs.delete(input.run.runId);
                return unavailable();
            }
            const check = live.plan.checks.find(c => c.checkId === input.check.checkId);
            if (!check || !input.evidence.length || input.check.verifierId !== WORKFLOW_VERIFIER_ID || !sameJSON({ checkId: check.checkId, title: check.title, expected: check.expected, required: check.required, minimumEvidence: check.minimumEvidence }, { checkId: input.check.checkId, title: input.check.title, expected: input.check.expected, required: input.check.required, minimumEvidence: input.check.minimumEvidence }))
                return unavailable();
            const rows = input.evidence.map(ref => live.facts.get(ref.evidenceId));
            if (rows.some((row, index) => !row || !sameJSON(row.evidence, input.evidence[index]) || row.ruleDigest !== digest(check.rule)))
                return unavailable();
            if (rows.some(row => row!.result.verdict === 'failed'))
                return { verdict: 'failed', code: 'BUSINESS_MISMATCH' };
            if (rows.every(row => row!.result.verdict === 'passed'))
                return { verdict: 'passed', code: 'VERIFIED' };
            return unavailable();
        } };
    attach(runId: string, binding: AgentBinding, agent: object, plan: WorkflowPlan, source: 'browser' | 'desktop', assertCurrent?: () => void): void {
        if (this.runs.has(runId) || this.runs.size >= 128)
            throw Error('WORKFLOW_LIMIT');
        this.runs.set(runId, { source, assertCurrent, plan: parseWorkflowPlan(plan), binding: structuredClone(binding), agent, attempts: new Map(), facts: new Map() });
    }
    authorize(runId: string, checkId: string, attemptId: string): void {
        const run = this.runs.get(runId);
        if (!run || !run.plan.checks.some(c => c.checkId === checkId) || run.attempts.has(attemptId) || run.attempts.size >= 64)
            throw Error('ATTEMPT_NOT_CURRENT');
        run.attempts.set(attemptId, checkId);
    }
    capture(exec: RunExec, evidence: EvidenceRef, observation: ComputerObservation, source?: 'browser' | 'desktop'): void {
        const run = this.runs.get(evidence.runId);
        if (!run)
            return;
        exec.signal.throwIfAborted();
        run.assertCurrent?.();
        if (source !== undefined && source !== run.source || exec.agent !== run.agent || run.binding.chatSessionId !== exec.agent?.id || evidence.environmentId !== run.binding.environmentId || evidence.epoch !== run.binding.epoch || !run.binding.targetIds.includes(evidence.targetId) || run.attempts.get(evidence.attemptId) !== evidence.checkId || observation.targetId !== evidence.targetId || observation.frameId !== evidence.frameId || digest(observation.geometry) !== evidence.geometryDigest || !sameJSON(observation.geometry, evidence.geometry))
            throw Error('EVIDENCE_BINDING_MISMATCH');
        const check = run.plan.checks.find(c => c.checkId === evidence.checkId)!;
        if (run.facts.has(evidence.evidenceId) || run.facts.size >= run.plan.budget.maxEvidence)
            throw Error('EVIDENCE_LIMIT');
        run.facts.set(evidence.evidenceId, { evidence: structuredClone(evidence), result: evaluateObservation(check.rule, observation.elements, run.source), ruleDigest: digest(check.rule) });
    }
    interrupt(runId: string): void { this.runs.delete(runId); }
    dispose(): void { this.runs.clear(); }
}
