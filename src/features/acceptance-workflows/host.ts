import type { ConnectionRpcFailure } from '@deepseek-ai/dsh-client-connection';
import type { Context } from '@deepseek-ai/cordis';
import { hostServiceIdentity } from '../../host-service-identity.ts';
import { RunError, object, opaque, text, uuid, integer, canonicalJSON } from '../acceptance-runs/contract.ts';
import type { RunReadScope } from '../acceptance-runs/service.ts';
import type { AcceptanceWorkflowService } from './service.ts';
import { WORKFLOW_ENDPOINT } from './model.ts';
interface Route {
    path: string;
    methods: readonly [
        'POST'
    ];
    requestBody: 'buffered';
    fetch(request: Request): Promise<Response>;
}
interface Connection {
    browserPeer?: {
        principal: {
            kind: string;
        };
    };
    fetch: {
        register(route: Route): () => Promise<void>;
    };
}
export interface WorkflowHostOptions {
    resolveScope(chat: string, signal: AbortSignal): Promise<RunReadScope>;
}
async function body(request: Request, check: () => void, signal: AbortSignal) {
    const reader = request.body?.getReader();
    if (!reader)
        throw new RunError('INVALID_REQUEST');
    let length = 0;
    const chunks: Uint8Array[] = [], abort = () => { void reader.cancel().catch(() => { }); };
    signal.addEventListener('abort', abort, { once: true });
    try {
        for (;;) {
            check();
            signal.throwIfAborted();
            const value = await reader.read();
            check();
            signal.throwIfAborted();
            if (value.done)
                break;
            length += value.value.byteLength;
            if (length > 256 * 1024)
                throw new RunError('REQUEST_LIMIT');
            chunks.push(value.value);
        }
        return Buffer.concat(chunks).toString('utf8');
    }
    finally {
        signal.removeEventListener('abort', abort);
        void reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
/** Owner-only checklist/repair controls. No model exec, selector or device command is accepted in a request. */
export function installAcceptanceWorkflowHost(ctx: Context, service: Pick<AcceptanceWorkflowService, 'list' | 'read' | 'edit' | 'decideRepair' | 'cancel'>, options: WorkflowHostOptions) {
    const connection = ctx.get('connection') as Connection | undefined, identity = hostServiceIdentity(connection);
    if (!connection || !identity)
        throw new RunError('CONNECTION_UNAVAILABLE');
    const lifetime = new AbortController();
    let disposed = false;
    const remove = connection.fetch.register({ path: '/api/' + WORKFLOW_ENDPOINT, methods: ['POST'], requestBody: 'buffered', async fetch(request) {
            const peer = connection.browserPeer, principal = peer?.principal;
            if (disposed || principal?.kind !== 'owner')
                return new Response('Forbidden', { status: 403 });
            const current = () => {
                if (disposed || lifetime.signal.aborted || request.signal.aborted || hostServiceIdentity(ctx.get('connection')) !== identity || connection.browserPeer !== peer || peer?.principal !== principal || principal.kind !== 'owner')
                    throw new RunError('OWNER_CHANGED');
            };
            let rpcId: string | undefined;
            try {
                current();
                const value = await body(request, current, AbortSignal.any([request.signal, lifetime.signal, AbortSignal.timeout(2000)]));
                current();
                const envelope = object(JSON.parse(value), ['type', 'rpcId', 'method', 'payload']);
                if (envelope.type !== 'client-request' || envelope.method !== WORKFLOW_ENDPOINT)
                    throw new RunError('INVALID_REQUEST');
                rpcId = text(envelope.rpcId, 128);
                const input = object(envelope.payload, ['op', 'chatSessionId', 'workflowId', 'expectedRevision', 'plan', 'requestId', 'allowed']);
                const chatSessionId = opaque(input.chatSessionId), op = input.op;
                if (typeof op !== 'string' || !['list', 'get', 'edit', 'repair', 'cancel'].includes(op))
                    throw new RunError('INVALID_REQUEST');
                object(input, op === 'list' ? ['op', 'chatSessionId'] : op === 'get' ? ['op', 'chatSessionId', 'workflowId'] : op === 'edit' ? ['op', 'chatSessionId', 'workflowId', 'expectedRevision', 'plan'] : op === 'repair' ? ['op', 'chatSessionId', 'workflowId', 'expectedRevision', 'requestId', 'allowed'] : ['op', 'chatSessionId', 'workflowId', 'expectedRevision']);
                const workflowId = op === 'list' ? undefined : uuid(input.workflowId);
                const expectedRevision = ['edit', 'repair', 'cancel'].includes(op) ? integer(input.expectedRevision, 128, 1) : undefined;
                if (op === 'repair' && typeof input.allowed !== 'boolean')
                    throw new RunError('INVALID_REQUEST');
                const signal = AbortSignal.any([request.signal, lifetime.signal]), resolved = await options.resolveScope(chatSessionId, signal);
                current();
                if (resolved.chatSessionId !== chatSessionId)
                    throw new RunError('OWNER_CHANGED');
                const scope: RunReadScope = { chatSessionId, signal: AbortSignal.any([signal, resolved.signal]), assertCurrent() { current(); this.signal.throwIfAborted(); resolved.assertCurrent(); } };
                scope.assertCurrent();
                const result = op === 'list' ? await service.list(scope) : op === 'get' ? await service.read(scope, workflowId) : op === 'edit' ? await service.edit(scope, { workflowId, expectedRevision, plan: input.plan }) : op === 'repair' ? await service.decideRepair(scope, { workflowId, expectedRevision, requestId: uuid(input.requestId), allowed: input.allowed }) : await service.cancel(scope, { workflowId, expectedRevision });
                scope.assertCurrent();
                return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: JSON.parse(canonicalJSON(result)) } }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
            }
            catch (error) {
                return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { details: {}, code: error instanceof RunError ? error.code : 'WORKFLOW_UNAVAILABLE', message: '验收任务已变化，请刷新后查看。' } satisfies ConnectionRpcFailure } }, { headers: { 'Cache-Control': 'no-store' } });
            }
        } });
    return async () => {
        if (disposed)
            return;
        disposed = true;
        lifetime.abort();
        await remove();
    };
}
