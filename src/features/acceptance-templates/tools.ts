import type { Context } from '@deepseek-ai/cordis';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { RunToolDefinition, RunToolsService } from '../acceptance-runs/sdk-host-seams.ts';
import { canonicalJSON, object, RunError } from '../acceptance-runs/contract.ts';
import { workflowToolValue, parseWorkflowSummary } from '../acceptance-workflows/model.ts';
import type { AcceptanceTemplateService } from './service.ts';
const json = (value: unknown): JsonValue => JSON.parse(canonicalJSON(value)) as JsonValue;
export function installAcceptanceTemplateTools(ctx: Context, service: Pick<AcceptanceTemplateService, 'modelList' | 'prepare'>): () => void {
    const runtime = ctx as Context & {
        tools: RunToolsService;
    }, removers: Array<() => void> = [];
    const cleanup = () => { const failures: unknown[] = []; for (const remove of removers.splice(0).reverse())
        try {
            remove();
        }
        catch (error) {
            failures.push(error);
        } if (failures.length)
        throw new AggregateError(failures, '验收模板工具卸载尚未确认。'); };
    const define = (definition: RunToolDefinition) => removers.push(runtime.tools.register(definition));
    const output: RunToolDefinition['output'] = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: canonicalJSON(value) }], presentationMeta(_args, value) {
            if (!value || typeof value !== 'object' || Array.isArray(value) || !('workflow' in value))
                return null;
            const w = object(value.workflow, ['workflowId', 'chatSessionId', 'revision', 'title', 'phase', 'readOnly', 'runId', 'plan', 'planSHA256', 'repairs', 'authorizedAttempts', 'cancel', 'recovery']);
            const workflow = parseWorkflowSummary({ workflowId: w.workflowId, chatSessionId: w.chatSessionId, revision: w.revision, title: w.title, phase: w.phase, readOnly: w.readOnly, runId: w.runId });
            return json({ kind: 'qiuya-workflow', version: 1, workflow });
        } };
    const id = { type: 'string' as const, description: 'Exact saved template/version Host-issued UUID.' };
    try {
        define({ name: 'qiuya_acceptance_templates', description: 'List explicitly saved reusable acceptance checklist versions. Data contains no copied controls, lease, site permission or verdict. Workflow links are limited to the current live root Agent chat. Do not ask the user to associate a chat. Owner saves/revokes templates in the existing acceptance card.', parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] }, output, presentCall: () => ({ card: 'generic', title: '查看验收模板', kind: 'read' }), async execute(args, exec) { object(args, []); return json({ templates: await service.modelList(exec) }); } });
        define({ name: 'qiuya_acceptance_from_template', description: 'Create a new editable H3 workflow from an explicitly saved template version for this current live root Agent. This creates neither an action nor a permission. Read the current site/app permission through real existing tools; existing always-allowed authority may remain usable. After this call, take a NEW real observe of the selected authorized target, then use qiuya_acceptance_get/start/checkpoint/finish. A still-valid environment/service/epoch may remain the same. Never reuse an old frame/actionId/lease/run verdict, retry an unknown preparation, or claim passed from a previous version. Host independently enforces fresh observation at start and H1 evaluates new actual evidence; old failed attempts remain unchanged. previousWorkflowId is an optional explicit same-chat link; null automatically links this template’s latest own-chat execution when present.', parameters: { type: 'object', additionalProperties: false, required: ['templateId', 'versionId', 'versionLabel', 'previousWorkflowId'], properties: { templateId: id, versionId: id, versionLabel: { type: 'string' }, previousWorkflowId: { oneOf: [id, { type: 'null' }] } } }, output, presentCall: () => ({ card: 'generic', title: '从模板生成新验收', kind: 'other' }), async execute(args, exec) { try {
                const value = await service.prepare(exec, args);
                return json({ ...workflowToolValue(value.workflow), template: { templateId: value.template.record.templateId, versionId: value.versionId, versionLabel: value.versionLabel, requiresFreshObservation: true } });
            }
            catch (error) {
                const code = error instanceof RunError ? error.code : 'TEMPLATE_UNAVAILABLE';
                throw new Error('[' + code + '] 新验收尚未确认，请读取当前记录，不要重放旧任务。');
            } } });
    }
    catch (error) {
        const failures = [error];
        try {
            cleanup();
        }
        catch (failure) {
            failures.push(failure);
        }
        throw new AggregateError(failures, '验收模板工具注册未完成。');
    }
    return cleanup;
}
