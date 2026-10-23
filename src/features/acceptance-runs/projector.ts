import type {} from '@deepseek-ai/dsh-tools/types';
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client';
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { ConversationNodeDefinitionInput } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { parseRunMeta } from './model.ts';
import type { RunSummary } from './model.ts';
export interface RunNodeData {
    run: RunSummary;
}
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
    interface ChatNodeDataMap {
        'qiuya-run': RunNodeData;
    }
}
interface NodeState {
    run: RunSummary;
    firstSeq: number;
}
export function eventRunSummary(event: SessionEventLike): RunSummary | null {
    if (event.type === 'tool/result') {
        if (event.data.message.isError)
            return null;
        return parseRunMeta(event.data.meta)?.run ?? null;
    }
    if (event.type === 'tool/ptc-dispatch') {
        const meta = parseRunMeta(event.data.meta);
        return !event.data.isError && meta && meta.tool === event.data.name ? meta.run : null;
    }
    return null;
}
/** Pure replayable projection. Unknown metadata leaves the original Host tool row unclaimed. */
export function acceptanceRunDefinition(): ConversationNodeDefinitionInput<NodeState> {
    return {
        kind: 'qiuya-run', target: 'chat',
        match(event) { const run = eventRunSummary(event); return run ? { id: run.chatSessionId + ':' + run.runId, role: 'start', exclusive: true } : null; },
        start(_context, match) { const run = eventRunSummary(match.event); if (!run)
            throw Error('Invalid matched acceptance metadata'); return { run, firstSeq: match.event.seq }; },
        update(context, match) { const run = eventRunSummary(match.event); if (!run || run.runId !== context.state.run.runId || run.chatSessionId !== context.state.run.chatSessionId || run.revision <= context.state.run.revision)
            return context.state; return { run, firstSeq: context.state.firstSeq }; },
        publication: () => 'immediate',
        buildViewNode(context) { if (!context.state)
            return null; const node: ChatNode<'qiuya-run'> = { key: context.key, id: context.id, kind: 'qiuya-run', target: 'chat', anchorSeq: context.state.firstSeq, location: context.start?.location ?? { kind: 'unresolved' }, visibility: 'visible', data: { run: context.state.run } }; return node; },
    };
}
