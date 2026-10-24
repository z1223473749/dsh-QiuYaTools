import type {} from '@deepseek-ai/dsh-tools/types';
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client';
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { ConversationNodeDefinitionInput } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { workflowMeta, type WorkflowSummary } from './model.ts';
interface State {
    workflow: WorkflowSummary;
    firstSeq: number;
}
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
    interface ChatNodeDataMap {
        'qiuya-workflow': {
            workflow: WorkflowSummary;
        };
    }
}
export function eventWorkflow(event: SessionEventLike): WorkflowSummary | undefined {
    if (event.type === 'tool/result' && !event.data.message.isError)
        return workflowMeta(event.data.meta);
    if (event.type === 'tool/ptc-dispatch' && !event.data.isError && /^qiuya_acceptance_(plan|get|start|checkpoint|repair|finish)$/u.test(event.data.name))
        return workflowMeta(event.data.meta);
}
export function acceptanceWorkflowDefinition(): ConversationNodeDefinitionInput<State> {
    return { kind: 'qiuya-workflow', target: 'chat', match(event) { const workflow = eventWorkflow(event); return workflow ? { id: workflow.chatSessionId + ':' + workflow.workflowId, role: 'start', exclusive: true } : null; }, start(_ctx, match) {
            const workflow = eventWorkflow(match.event);
            if (!workflow)
                throw Error('Invalid workflow metadata');
            return { workflow, firstSeq: match.event.seq };
        }, update(context, match) { const workflow = eventWorkflow(match.event); return workflow && workflow.workflowId === context.state.workflow.workflowId && workflow.chatSessionId === context.state.workflow.chatSessionId && workflow.revision > context.state.workflow.revision ? { workflow, firstSeq: context.state.firstSeq } : context.state; }, publication: () => 'immediate', buildViewNode(context) {
            if (!context.state)
                return null;
            const node: ChatNode<'qiuya-workflow'> = { key: context.key, id: context.id, kind: 'qiuya-workflow', target: 'chat', anchorSeq: context.state.firstSeq, location: context.start?.location ?? { kind: 'unresolved' }, visibility: 'visible', data: { workflow: context.state.workflow } };
            return node;
        } };
}
