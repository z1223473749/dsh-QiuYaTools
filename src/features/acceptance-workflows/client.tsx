import React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { RunReadConnection } from '../acceptance-runs/client-api.ts';
import { runAddress } from '../acceptance-runs/model.ts';
import { createWorkflowAPI, type WorkflowAPI } from './client-api.ts';
import { acceptanceWorkflowDefinition } from './projector.ts';
import { WorkflowCard } from './WorkflowCard.tsx';
interface Face {
    api: WorkflowAPI;
    openRun(id: string): void;
}
export function WorkflowNodeView({ node, sessionId, api, openRun }: PropsRuntime<'conversation.chat.node', 'qiuya-workflow'> & InjectFace<Face>) { return <WorkflowCard summary={node.data.workflow} sessionId={sessionId} api={api} onOpenRun={openRun}/>; }
export function installAcceptanceWorkflowClient(ctx: Context): () => void {
    let disposed = false;
    const cleanups: Array<() => void> = [], api = createWorkflowAPI(() => ctx.get('connection') as RunReadConnection | undefined);
    const cleanup = () => {
        if (disposed)
            return;
        disposed = true;
        const errors: unknown[] = [];
        for (const remove of cleanups.splice(0).reverse())
            try {
                remove();
            }
            catch (error) {
                errors.push(error);
            }
        if (errors.length)
            throw new AggregateError(errors, '自动验收视图清理未完成。');
    };
    try {
        cleanups.push(ctx.uiConversation.events.register(acceptanceWorkflowDefinition()));
        cleanups.push(ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'qiuya-workflow', inject(sessionId: string): Face {
                return { api, openRun(id) {
                        if (!disposed && ctx.sidebarRight.mounted.getSnapshot() === sessionId)
                            ctx.sidebarRight.openResource(runAddress(sessionId, id));
                    } };
            } }, WorkflowNodeView)));
        const style = document.createElement('style');
        style.dataset.plugin = 'qiuya-tools-acceptance-workflows';
        style.textContent = '.qyt-workflow{margin:12px 0}.qyt-workflow-checks{list-style:none;padding:0;margin:12px 0;display:grid;gap:10px}.qyt-workflow-checks>li{border:1px solid var(--border-color,rgba(110,130,130,.18));border-radius:12px;padding:12px}.qyt-workflow-checks>li>div{display:flex;gap:12px;justify-content:space-between}.qyt-workflow-checks p{margin:7px 0;font-size:13px}.qyt-workflow label{display:grid;gap:5px;font-size:13px;margin:6px 0}.qyt-workflow input:not([type=checkbox]){font:inherit;color:inherit;border:1px solid var(--border-color,rgba(110,130,130,.24));background:var(--background-color,transparent);padding:8px 10px;border-radius:8px;min-width:0}.qyt-workflow-required{display:flex!important;align-items:center}.qyt-workflow-edit-actions,.qyt-workflow footer{display:flex;flex-wrap:wrap;gap:8px}.qyt-workflow-repair{padding:12px;border:1px solid rgba(40,120,130,.3);border-radius:12px;margin:10px 0}.qyt-workflow-repair button{margin:4px 8px 0 0}.qyt-workflow button{font:inherit;color:inherit;border:1px solid rgba(110,130,130,.24);background:transparent;border-radius:8px;padding:6px 10px;cursor:pointer}.qyt-workflow button:disabled{opacity:.48;cursor:default}.qyt-workflow button:focus-visible{outline:2px solid #168494;outline-offset:2px}';
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
        throw new AggregateError(errors, '自动验收视图初始化未完成。');
    }
    return cleanup;
}
