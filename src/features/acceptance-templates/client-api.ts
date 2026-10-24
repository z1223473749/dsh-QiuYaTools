import { array, object, text, uuid, integer } from '../acceptance-runs/contract.ts';
import { parseWorkflowView } from '../acceptance-workflows/model.ts';
import type { RunReadConnection } from '../acceptance-runs/client-api.ts';
import { TEMPLATE_ENDPOINT, parseTemplateView } from './contract.ts';
import type { TemplateView } from './contract.ts';
import type { TemplateComparison } from './contract.ts';
export interface SaveTemplateInput {
    templateId: string | null;
    expectedRevision: number;
    workflowId: string;
    name: string;
    description: string;
    label: string;
    operationId: string;
}
export interface TemplateAPI {
    list(chat: string, signal: AbortSignal): Promise<TemplateView[]>;
    save(chat: string, input: SaveTemplateInput, signal: AbortSignal): Promise<TemplateView>;
    revoke(chat: string, id: string, revision: number, signal: AbortSignal): Promise<TemplateView>;
    compare(chat: string, id: string, left: string, right: string, signal: AbortSignal): Promise<TemplateComparison>;
}
export function parseComparison(input: unknown, chat: string): TemplateComparison {
    const v = object(input, ['readOnly', 'replayPermitted', 'left', 'right', 'leftTemplatePlanMatches', 'rightTemplatePlanMatches', 'checks']);
    if (v.readOnly !== true || v.replayPermitted !== false || typeof v.leftTemplatePlanMatches !== 'boolean' || typeof v.rightTemplatePlanMatches !== 'boolean')
        throw Error('对比记录无效');
    const left = parseWorkflowView(v.left), right = parseWorkflowView(v.right);
    if (left.record.chatSessionId !== chat || right.record.chatSessionId !== chat)
        throw Error('对比会话已变化');
    const statuses = ['passed', 'failed', 'blocked', 'cancelled', 'inconclusive', 'pending', 'not-run'];
    const checks = array(v.checks, raw => { const c = object(raw, ['checkId', 'title', 'comparable', 'left', 'right']); if (typeof c.comparable !== 'boolean' || typeof c.left !== 'string' || typeof c.right !== 'string' || !statuses.includes(c.left) || !statuses.includes(c.right))
        throw Error('对比记录无效'); return { checkId: text(c.checkId), title: text(c.title, 120), comparable: c.comparable, left: c.left, right: c.right }; }, 64);
    return { readOnly: true, replayPermitted: false, left, right, leftTemplatePlanMatches: v.leftTemplatePlanMatches, rightTemplatePlanMatches: v.rightTemplatePlanMatches, checks };
}
export function createTemplateAPI(connection: () => RunReadConnection | undefined): TemplateAPI {
    async function call(chat: string, op: string, extra: Record<string, unknown>, signal: AbortSignal) { signal.throwIfAborted(); const peer = connection(); if (!peer)
        throw Error('连接尚未就绪'); const result = await peer.rpc.call('/api', TEMPLATE_ENDPOINT, { op, chatSessionId: text(chat), ...extra }, signal); signal.throwIfAborted(); if (connection() !== peer || !result.ok)
        throw Error('模板操作尚未确认，请刷新记录。'); return result.value; }
    const own = (value: unknown, chat: string, id?: string) => { const view = parseTemplateView(value); if (id && view.record.templateId !== id || view.record.executions.some(row => row.chatSessionId !== chat))
        throw Error('模板记录已变化'); return view; };
    return { async list(chat, signal) { return array(await call(chat, 'list', {}, signal), value => own(value, chat), 32); }, async save(chat, input, signal) { return own(await call(chat, 'save', { ...input, workflowId: uuid(input.workflowId), operationId: uuid(input.operationId) }, signal), chat, input.templateId ?? input.operationId); }, async revoke(chat, id, revision, signal) { return own(await call(chat, 'revoke', { templateId: uuid(id), expectedRevision: integer(revision, 256, 1) }, signal), chat, id); }, async compare(chat, id, left, right, signal) { const result = parseComparison(await call(chat, 'compare', { templateId: uuid(id), leftWorkflowId: uuid(left), rightWorkflowId: uuid(right) }, signal), chat); if (result.left.record.workflowId !== left || result.right.record.workflowId !== right)
            throw Error('对比记录已变化'); return result; } };
}
