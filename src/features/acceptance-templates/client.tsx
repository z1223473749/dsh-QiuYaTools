import React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client';
import type { SessionBinding, ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol';
import type { RunReadConnection } from '../acceptance-runs/client-api.ts';
import { createTemplateAPI, type TemplateAPI } from './client-api.ts';
import { TemplateRerunSubmission, type RerunInput, type RerunReceipt } from './rerun-submission.ts';
import { TemplatesPane } from './TemplatesPane.tsx';
import { uuid, text } from '../acceptance-runs/contract.ts';
const TAB_ID = 'qiuya-tools.acceptance-templates';
export function templateAddress(chat: string, workflowId?: string) { return 'dsh-resource://qiuya-template/' + encodeURIComponent(text(chat)) + (workflowId ? '?workflow=' + uuid(workflowId) : ''); }
export function parseTemplateAddress(address: string): {
    chatSessionId: string;
    workflowId?: string;
} | null { try {
    const url = new URL(address);
    if (url.protocol !== 'dsh-resource:' || url.hostname !== 'qiuya-template' || url.hash || url.username || url.password || url.port || url.searchParams.size > 1 || [...url.searchParams.keys()].some(k => k !== 'workflow'))
        return null;
    const chatSessionId = text(decodeURIComponent(url.pathname.slice(1))), id = url.searchParams.get('workflow');
        if (url.searchParams.has('workflow') && !id) return null;
    if (url.pathname.split('/').length !== 2)
        return null;
    return { chatSessionId, ...(id ? { workflowId: uuid(id) } : {}) };
}
catch {
    return null;
} }
interface TemplateResource {
    chatSessionId: string;
    workflowId?: string;
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface ResourceProtocolMap {
        'qiuya-template': TemplateResource;
    }
}
interface Face {
    api: TemplateAPI;
    current(chat: string): boolean;
    rerun(chat: string, input: RerunInput, signal: AbortSignal): Promise<RerunReceipt>;
}
export function TemplatesTab(props: PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<Face>) { const info = props.useTabInfo(), address = info.tab.navigation.address, target = parseTemplateAddress(address), resource = props.useResource<'qiuya-template'>(address), value = resource.status === 'live' ? resource.value : undefined; if (!target || target.chatSessionId !== props.sessionId || value?.chatSessionId !== props.sessionId)
    return <p className="qyt-run-note">请在当前会话打开验收模板。</p>; return <TemplatesPane key={props.sessionId + ':' + (target.workflowId ?? '')} chatSessionId={props.sessionId} sourceWorkflowId={target.workflowId} api={props.api} rerun={props.rerun} current={props.current}/>; }
export function installAcceptanceTemplateClient(ctx: Context): () => void {
    const cleanups: Array<() => void> = [], lifetime = new AbortController(), submissions = new Map<string, TemplateRerunSubmission>(), api = createTemplateAPI(() => ctx.get('connection') as RunReadConnection | undefined);
    let disposed = false;
    const current = (chat: string) => !disposed && ctx.sidebarRight.mounted.getSnapshot() === chat;
    const binding = (chat: string): SessionBinding | undefined => { if (!current(chat))
        return undefined; const sessions = ctx.get('sessions') as ISessions | undefined; return sessions?.binding(chat as SessionId); };
    const rerun = async (chat: string, input: RerunInput, signal: AbortSignal): Promise<RerunReceipt> => { if (!current(chat))
        throw Error('当前会话已变化'); const key = chat; if (submissions.get(key)?.isDurablyDelivered()) submissions.delete(key); if (submissions.has(key))
        throw Error('这次提交已发出，请先查看当前会话中的新任务。'); if (submissions.size >= 128)
        throw Error('本次插件运行的模板提交已达上限。'); const request = new TemplateRerunSubmission({ currentChat: () => current(chat) ? chat : undefined, binding, signal: AbortSignal.any([signal, lifetime.signal]) }); submissions.set(key, request); try {
        const receipt = await request.submit(chat, input);
        if (receipt !== 'unknown')
            submissions.delete(key);
        return receipt;
    }
    catch (error) {
        submissions.delete(key);
        throw error;
    } };
    const cleanup = () => { if (disposed)
        return; disposed = true; lifetime.abort(); const errors: unknown[] = []; for (const remove of cleanups.splice(0).reverse())
        try {
            remove();
        }
        catch (error) {
            errors.push(error);
        } submissions.clear(); if (errors.length)
        throw new AggregateError(errors, '验收模板视图清理未完成。'); };
    try {
        const provider: ResourceProvider<'qiuya-template'> = { protocol: 'qiuya-template', async *open(address, { signal }) { const target = parseTemplateAddress(address); if (signal.aborted)
                return; if (!target || !current(target.chatSessionId)) {
                const error: RemoteFailure = Object.assign(new Error('验收模板会话已变化。'), { code: 'gateway/bad-request' as const, details: {}, isDSHRemoteError: true as const });
                yield { ok: false, error };
                return;
            } yield { ok: true, value: target }; } };
        cleanups.push(ctx.resources.register(provider));
        cleanups.push(ctx.sidebarRightTabs.register({ id: TAB_ID, kind: 'qiuya-template', patterns: ['dsh-resource://qiuya-template/**'], canOpen: address => parseTemplateAddress(address) !== null, title: () => '验收模板', multiple: true, keepMounted: false }));
        cleanups.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, inject: () => ({ api, current, rerun }) }, TemplatesTab)));
        const style = document.createElement('style');
        style.dataset.plugin = 'qiuya-tools-acceptance-templates';
        style.textContent = '.qyt-template-pane{padding:16px;margin:0;min-width:0}.qyt-template-pane>header,.qyt-template-item>header{display:flex;align-items:center;justify-content:space-between;gap:12px}.qyt-template-pane label{display:grid;gap:6px;font-size:13px;margin:10px 0}.qyt-template-pane input,.qyt-template-pane select{font:inherit;color:inherit;background:var(--background-color,transparent);border:1px solid var(--border-color,rgba(110,130,130,.24));border-radius:8px;padding:8px 10px;min-width:0;max-width:100%}.qyt-template-pane button{font:inherit;color:inherit;background:transparent;border:1px solid var(--border-color,rgba(110,130,130,.24));border-radius:8px;padding:7px 12px;cursor:pointer}.qyt-template-pane button:disabled{opacity:.5;cursor:default}.qyt-template-pane button:focus-visible{outline:2px solid #168494;outline-offset:2px}.qyt-template-list{display:grid;gap:14px}.qyt-template-item,.qyt-template-save,.qyt-template-comparison{border:1px solid var(--border-color,rgba(110,130,130,.18));border-radius:12px;padding:14px;margin:14px 0}.qyt-template-item footer{display:flex;gap:8px;flex-wrap:wrap}.qyt-template-pane summary{cursor:pointer;font-weight:500}.qyt-template-comparison table{border-collapse:collapse;width:100%;font-size:13px}.qyt-template-comparison th,.qyt-template-comparison td{text-align:left;padding:9px 6px;border-bottom:1px solid var(--border-color,rgba(110,130,130,.18));overflow-wrap:anywhere}.qyt-template-comparison small{display:block;color:var(--text-color-secondary,#6b7b7b);font-weight:400;margin-top:5px}';
        document.head.append(style);
        cleanups.push(() => style.remove());
    }
    catch (error) {
        const errors = [error];
        try {
            cleanup();
        }
        catch (failure) {
            errors.push(failure);
        }
        throw new AggregateError(errors, '验收模板视图初始化未完成。');
    }
    return cleanup;
}
