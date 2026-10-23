import React, { useEffect } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots';
import { createRunReadAPI } from './client-api.ts';
import type { RunReadAPI, RunReadConnection } from './client-api.ts';
import { acceptanceRunDefinition } from './projector.ts';
import { parseRunAddress, runAddress } from './model.ts';
import { createRunResourceProvider, RunReadRefreshBus } from './resources.ts';
import { createRunUIStore } from './ui-store.ts';
import { RunResultCard, RunHistory, RunDetails } from './RunViews.tsx';
import type { RunUIProps } from './RunViews.tsx';
import { runStyles } from './styles.ts';
const TAB_ID = 'qiuya-tools.acceptance-runs';
interface ReadFace {
    api: RunReadAPI;
    openRun(runId?: string): void;
    refresh(address: string): void;
}
export function RunNodeView({ node, sessionId, api, openRun }: PropsRuntime<'conversation.chat.node', 'qiuya-run'> & InjectFace<ReadFace>) { return <RunResultCard summary={node.data.run} sessionId={sessionId} api={api} onOpen={openRun}/>; }
export function RunHistoryTab(props: PropsRuntime<'sidebar.right.pane.tab'> & RunUIProps & InjectFace<ReadFace>) {
    const tab = props.useTabInfo(), address = tab.tab.navigation.address, target = parseRunAddress(address), resource = props.useResource<'qiuya-run'>(address);
    useEffect(() => tab.tab.actions.bindCommands({ refresh: () => props.refresh(address) }), [tab.tab.actions.bindCommands, address, props.refresh]);
    const value = resource.status === 'live' ? resource.value : undefined, matching = target?.chatSessionId === props.sessionId && value?.chatSessionId === props.sessionId;
    return <div className="qyt-run-pane"><div className="qyt-run-pane-tools"><span>电脑任务记录</span><button type="button" onClick={() => props.refresh(address)}>刷新</button></div>{!target || target.chatSessionId !== props.sessionId ? <p className="qyt-run-note">当前会话无法查看这份记录。</p> : !matching ? <p className="qyt-run-note" role="status">{resource.status === 'failed' ? '记录暂不可用，请刷新后重试。' : '正在读取任务记录…'}</p> : value.kind === 'history' ? <RunHistory rows={value.rows} useStore={props.useStore} actions={props.actions} onOpen={props.openRun}/> : <RunDetails view={value.view} sessionId={props.sessionId} api={props.api} onHistory={() => props.openRun()} useStore={props.useStore} actions={props.actions}/>}</div>;
}
/** Public SDK wiring only. Closing a view aborts reads, never changes execution state. */
export function installAcceptanceRunClient(ctx: Context): () => void {
    const disposers: Array<() => void> = [], store = createRunUIStore(), bus = new RunReadRefreshBus(), api = createRunReadAPI(() => ctx.get('connection') as RunReadConnection | undefined);
    let disposed = false;
    const isCurrent = (chat: string) => !disposed && ctx.sidebarRight.mounted.getSnapshot() === chat;
    const inject = (sessionId: string): ReadFace => ({ api, openRun(runId) { if (isCurrent(sessionId))
            ctx.sidebarRight.openResource(runAddress(sessionId, runId)); }, refresh(address) { const target = parseRunAddress(address); if (target && target.chatSessionId === sessionId && isCurrent(sessionId))
            bus.refresh(address); } });
    disposers.push(ctx.uiConversation.events.register(acceptanceRunDefinition()));
    disposers.push(ctx.resources.register(createRunResourceProvider(api, bus, isCurrent)));
    disposers.push(ctx.sidebarRightTabs.register({ id: TAB_ID, kind: 'qiuya-run', patterns: ['dsh-resource://qiuya-run/**'], canOpen: address => parseRunAddress(address) !== null, title: () => '电脑任务记录', multiple: true, keepMounted: false }));
    disposers.push(ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'qiuya-run', inject }, RunNodeView)));
    disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, store, inject }, RunHistoryTab)));
    const style = document.createElement('style');
    style.dataset.plugin = 'qiuya-tools-acceptance-runs';
    style.textContent = runStyles;
    document.head.append(style);
    disposers.push(() => style.remove());
    return () => { if (disposed)
        return; disposed = true; bus.dispose(); for (const dispose of disposers.splice(0).reverse())
        dispose(); };
}
