import type { ConnectionRpcFailure } from '@deepseek-ai/dsh-client-connection';
import type { Context } from '@deepseek-ai/cordis';
import { hostServiceIdentity } from '../../host-service-identity.ts';
import { RunError, object, opaque, text, uuid, integer, canonicalJSON } from '../acceptance-runs/contract.ts';
import type { RunReadScope } from '../acceptance-runs/service.ts';
import type { AcceptanceTemplateService } from './service.ts';
import { TEMPLATE_ENDPOINT } from './contract.ts';
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
export interface TemplateHostOptions {
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
/** Explicit owner plan data and readonly comparison. No execution, lease or model verdict is accepted. */
export function installAcceptanceTemplateHost(ctx: Context, service: Pick<AcceptanceTemplateService, 'list' | 'read' | 'saveVersion' | 'revoke' | 'compare'>, options: TemplateHostOptions) {
    const connection = ctx.get('connection') as Connection | undefined, identity = hostServiceIdentity(connection);
    if (!connection || !identity)
        throw new RunError('CONNECTION_UNAVAILABLE');
    const lifetime = new AbortController();
    let disposed = false;
    const remove = connection.fetch.register({ path: '/api/' + TEMPLATE_ENDPOINT, methods: ['POST'], requestBody: 'buffered', async fetch(request) {
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
                if (envelope.type !== 'client-request' || envelope.method !== TEMPLATE_ENDPOINT)
                    throw new RunError('INVALID_REQUEST');
                rpcId = text(envelope.rpcId, 128);
                const input = object(envelope.payload, ['op', 'chatSessionId', 'templateId', 'workflowId', 'expectedRevision', 'name', 'description', 'label', 'operationId', 'leftWorkflowId', 'rightWorkflowId']);
                const chatSessionId = opaque(input.chatSessionId), op = input.op;
                const fields: Record<string, readonly string[]> = { list: [], get: ['templateId'], save: ['templateId', 'workflowId', 'expectedRevision', 'name', 'description', 'label', 'operationId'], revoke: ['templateId', 'expectedRevision'], compare: ['templateId', 'leftWorkflowId', 'rightWorkflowId'] };
                if (typeof op !== 'string' || !Object.hasOwn(fields, op))
                    throw new RunError('INVALID_REQUEST');
                object(input, ['op', 'chatSessionId', ...fields[op]!]);
                const templateId = op === 'list' || op === 'save' && input.templateId === null ? null : uuid(input.templateId);
                const expectedRevision = op === 'save' || op === 'revoke' ? integer(input.expectedRevision, 256, op === 'save' ? 0 : 1) : undefined;
                if (op === 'save') {
                    uuid(input.workflowId);
                    uuid(input.operationId);
                    text(input.name, 120);
                    if (input.description !== '')
                        text(input.description, 500);
                    text(input.label, 80);
                }
                if (op === 'compare') {
                    uuid(input.leftWorkflowId);
                    uuid(input.rightWorkflowId);
                }
                const signal = AbortSignal.any([request.signal, lifetime.signal]), resolved = await options.resolveScope(chatSessionId, signal);
                current();
                if (resolved.chatSessionId !== chatSessionId)
                    throw new RunError('OWNER_CHANGED');
                const scope: RunReadScope = { chatSessionId, signal: AbortSignal.any([signal, resolved.signal]), assertCurrent() { current(); this.signal.throwIfAborted(); resolved.assertCurrent(); } };
                scope.assertCurrent();
                const result = op === 'list' ? await service.list(scope) : op === 'get' ? await service.read(scope, templateId) : op === 'save' ? await service.saveVersion(scope, { templateId, expectedRevision, workflowId: input.workflowId, name: input.name, description: input.description, label: input.label, operationId: input.operationId }) : op === 'revoke' ? await service.revoke(scope, { templateId, expectedRevision }) : await service.compare(scope, { templateId, leftWorkflowId: input.leftWorkflowId, rightWorkflowId: input.rightWorkflowId });
                scope.assertCurrent();
                return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: JSON.parse(canonicalJSON(result)) } }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
            }
            catch (error) {
                return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { details: {}, code: error instanceof RunError ? error.code : 'TEMPLATE_UNAVAILABLE', message: '验收模板或会话已变化，请刷新后查看。' } satisfies ConnectionRpcFailure } }, { headers: { 'Cache-Control': 'no-store' } });
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
