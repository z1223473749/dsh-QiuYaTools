import type { Context } from '@deepseek-ai/cordis';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { RunJsonSchema, RunToolDefinition, RunToolsService } from '../acceptance-runs/sdk-host-seams.ts';
import { canonicalJSON, object, uuid, RunError } from '../acceptance-runs/contract.ts';
import { parseWorkflowSummary, workflowMeta, workflowToolValue } from './model.ts';
import type { AcceptanceWorkflowService } from './service.ts';
const string: RunJsonSchema = { type: 'string' }, id: RunJsonSchema = { type: 'string', description: 'Exact Host-issued UUID; never a title or URL.' }, nullable = (value: RunJsonSchema): RunJsonSchema => ({ oneOf: [value, { type: 'null' }] });
const checkRule: RunJsonSchema = { oneOf: [
        { type: 'object', additionalProperties: false, required: ['kind', 'role', 'name', 'expected'], properties: { kind: { type: 'string', enum: ['browserValue'] }, role: string, name: string, expected: string } },
        { type: 'object', additionalProperties: false, required: ['kind', 'expected', 'failure'], properties: { kind: { type: 'string', enum: ['nativeText'] }, expected: string, failure: nullable(string) } },
        { type: 'object', additionalProperties: false, required: ['kind', 'reason'], properties: { kind: { type: 'string', enum: ['unavailable'] }, reason: string } },
    ] };
export const workflowPlanSchema: RunJsonSchema = { type: 'object', additionalProperties: false, required: ['title', 'checks', 'budget', 'maxRepairAttempts'], properties: { title: string, checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['checkId', 'title', 'expected', 'required', 'minimumEvidence', 'rule'], properties: { checkId: string, title: string, expected: string, required: { type: 'boolean' }, minimumEvidence: { type: 'integer' }, rule: checkRule } } }, budget: { type: 'object', additionalProperties: false, required: ['maxAttempts', 'maxActions', 'maxEvidence', 'deadlineMs'], properties: { maxAttempts: { type: 'integer' }, maxActions: { type: 'integer' }, maxEvidence: { type: 'integer' }, deadlineMs: { type: 'integer' } } }, maxRepairAttempts: { type: 'integer' } } };
const mutation = { workflowId: id, expectedRevision: { type: 'integer', description: 'Latest workflow revision after owner edits; re-read on conflict.' } } satisfies Record<string, RunJsonSchema>;
const json = (value: unknown): JsonValue => JSON.parse(canonicalJSON(value)) as JsonValue;
/** Existing current Harness Agent drives these tools; no new model loop, owner decision, or input channel. */
export function installAcceptanceWorkflowTools(ctx: Context, service: AcceptanceWorkflowService): () => void {
    const runtime = ctx as Context & {
        tools: RunToolsService;
    }, registered: Array<() => void> = [];
    const cleanup = () => {
        const failures: unknown[] = [];
        for (const remove of registered.splice(0).reverse())
            try {
                remove();
            }
            catch (error) {
                failures.push(error);
            }
        if (failures.length)
            throw new AggregateError(failures, '自动验收工具卸载尚未确认。');
    };
    const define = (name: string, title: string, parameters: RunToolDefinition['parameters'], description: string, execute: RunToolDefinition['execute']) => {
        const definition: RunToolDefinition = { name, parameters, description, output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: canonicalJSON(value) }], presentationMeta(_args, value) { const v = object(value, ['workflow', 'run']), w = object(v.workflow, ['workflowId', 'chatSessionId', 'revision', 'title', 'phase', 'readOnly', 'runId', 'plan', 'planSHA256', 'repairs', 'authorizedAttempts', 'cancel', 'recovery']); const summary = parseWorkflowSummary({ workflowId: w.workflowId, chatSessionId: w.chatSessionId, revision: w.revision, title: w.title, phase: w.phase, readOnly: w.readOnly, runId: w.runId }); return json({ kind: 'qiuya-workflow', version: 1, workflow: summary }); } }, presentCall: () => ({ card: 'generic', title, kind: name === 'qiuya_acceptance_get' ? 'read' : 'other' }), presentResult(_args, result) { const meta = workflowMeta(result.meta); return result.isError || !meta ? undefined : { card: 'generic', title: meta.title + ' · 自动验收' }; }, async execute(args, exec) {
                exec.signal.throwIfAborted();
                try {
                    return await execute(args, exec);
                }
                catch (error) {
                    const code = error instanceof RunError && /^[A-Z_]{3,64}$/u.test(error.code) ? error.code : 'WORKFLOW_UNAVAILABLE';
                    throw new Error('[' + code + '] 自动验收未能确认，请读取最新记录；不要重放未确认的动作。');
                }
            } };
        registered.push(runtime.tools.register(definition));
    };
    try {
        define('qiuya_acceptance_plan', '生成验收清单', { type: 'object', additionalProperties: false, required: ['plan', 'previousWorkflowId'], properties: { plan: workflowPlanSchema, previousWorkflowId: nullable(id) } }, 'Prepare an editable acceptance checklist for the current live root Agent. Use the existing authorized computer/browser target; do not ask for manual chat association. Checks include exact expected app facts, never a model verdict/verifier/script. Browser unique role/name value assertions use actual AX values. Native checks match exact accessible success/failure text; absence, missing AX and visual-only checks must use unavailable and stay inconclusive. Owner may edit the draft. A new workflow after an interrupted/cancelled one must explicitly link its previousWorkflowId; this is a new task, never a replay. No action or repair permission is granted. Missing test accounts or unclear expectations must be requested through existing Harness question tools; mark only the affected check unavailable while continuing independent checks. Never include passwords, access tokens or credentials in checklist predicates. Defaults for a small task:12 actions/180000ms; bounded retry budget still needs an owner repair choice.', async (args, exec) => json(workflowToolValue(await service.propose(exec, args))));
        define('qiuya_acceptance_get', '读取自动验收', { type: 'object', additionalProperties: false, required: ['workflowId'], properties: { workflowId: id } }, 'Read this chat workflow, latest owner-edited plan revision, run/attempt/evidence receipts and permission state. Historical/restarted/unknown workflows remain readonly. Never reuse old controls or actions.', async (args, exec) => { const v = object(args, ['workflowId']); return json(workflowToolValue(await service.get(exec, uuid(v.workflowId)))); });
        define('qiuya_acceptance_start', '开始自动验收', { type: 'object', additionalProperties: false, required: Object.keys(mutation), properties: mutation }, 'Freeze the exact latest editable checklist into the existing H1 ledger and capture the true H2 model target/service/Agent/epoch. Start only this current task, without overwriting owner edits. Read on revision conflict. Then start one checkpoint before observe/act, and use real existing computer/browser tools. UI view changes never change execution authority.', async (args, exec) => json(workflowToolValue(await service.start(exec, args))));
        define('qiuya_acceptance_checkpoint', '独立验证检查点', { type: 'object', additionalProperties: false, required: [...Object.keys(mutation), 'phase', 'checkId'], properties: { ...mutation, phase: { type: 'string', enum: ['start', 'verify'] }, checkId: string, attemptId: id, evidenceIds: { type: 'array', items: id }, repairRequestId: nullable(id) } }, 'Start one attempt, or verify it with Host-committed evidence IDs from real observe. No proposal/verdict/verified flag. Host independently evaluates frozen app predicates and actual image availability; performed/model text cannot pass. On verify provide attemptId/evidenceIds; on start only optional approved repairRequestId. Each failed repair requires a fresh attempt/observation and preserves all failures. An inconclusive/blocked check cannot silently restart or repair; request missing information and, if a changed plan is needed, finish and create a newly linked workflow. Unknown/unacknowledged input cannot be retried.', async (args, exec) => json(workflowToolValue(await service.checkpoint(exec, args))));
        define('qiuya_acceptance_repair', '申请有限修复与复验', { type: 'object', additionalProperties: false, required: [...Object.keys(mutation), 'checkId', 'reason'], properties: { ...mutation, checkId: string, reason: string } }, 'After an independently failed check, request one bounded owner-approved repair/reverification within the original user task and remaining run budget. This call waits for the actual owner decision. It does not execute code, add permissions, authorize unrelated files/accounts, or increase budgets. If approved, start a fresh checkpoint with the returned repairs[].requestId whose state is allowed and use existing Harness tools under their existing authorization; never replay an unknown action.', async (args, exec) => json(workflowToolValue(await service.requestRepair(exec, args))));
        define('qiuya_acceptance_finish', '汇总自动验收', { type: 'object', additionalProperties: false, required: Object.keys(mutation), properties: mutation }, 'Finish through H1 aggregation after independent checks or a denied/unavailable repair. Missing required checks/images or unknown input cannot pass. No overall verdict argument. Previous failures stay in the ledger even when a fresh approved attempt later passes.', async (args, exec) => json(workflowToolValue(await service.finish(exec, args))));
    }
    catch (failure) {
        const failures = [failure];
        try {
            cleanup();
        }
        catch (error) {
            failures.push(error);
        }
        throw new AggregateError(failures, '自动验收工具注册未完成。');
    }
    return cleanup;
}
