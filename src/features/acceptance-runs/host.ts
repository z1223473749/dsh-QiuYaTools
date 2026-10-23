import type { Context } from '@deepseek-ai/cordis';
import { createHash } from 'node:crypto';
import { canonicalJSON, object, opaque, uuid, RunError, text } from './contract.ts';
import type { EvidenceRef } from './contract.ts';
import type { RunHistoryReader, RunReadScope } from './service.ts';
import { RUN_ENDPOINT } from './model.ts';
interface Route {
    path: string;
    methods: readonly [
        'POST'
    ];
    requestBody: 'buffered';
    fetch(request: Request): Promise<Response>;
}
interface HostConnection {
    browserPeer?: {
        principal: {
            kind: string;
        };
    };
    fetch: {
        register(route: Route): () => Promise<void>;
    };
}
export interface RunHostOptions {
    resolveScope(chatSessionId: string, signal: AbortSignal): Promise<RunReadScope> | RunReadScope;
    readEvidence(ref: Readonly<EvidenceRef>, signal: AbortSignal): Promise<Uint8Array>;
}
async function boundedRequest(request: Request, check: () => void, signal: AbortSignal): Promise<string> { const reader = request.body?.getReader(); if (!reader)
    return ''; let bytes = 0; const chunks: Uint8Array[] = []; const abort = () => { void reader.cancel().catch(() => {}) }; signal.addEventListener('abort', abort, { once: true }); try {
    while (true) {
        check(); signal.throwIfAborted();
        const item = await reader.read();
        check(); signal.throwIfAborted();
        if (item.done)
            break;
        bytes += item.value.byteLength;
        if (bytes > 32768) {
            void reader.cancel().catch(() => {});
            throw new RunError('REQUEST_LIMIT');
        }
        ;
        chunks.push(item.value);
    }
    return Buffer.concat(chunks).toString('utf8');
}
finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
} }
const errorCode = (error: unknown) => error instanceof RunError && /^[A-Z_]{3,64}$/u.test(error.code) ? error.code : 'RUN_UNAVAILABLE';
/** Owner-only read surface. No tool exec is fabricated to inspect finished-chat history. */
export function installAcceptanceRunHost(ctx: Context, reader: RunHistoryReader, options: RunHostOptions): () => Promise<void> {
    const connection = ctx.get('connection') as HostConnection | undefined;
    if (!connection)
        throw new RunError('CONNECTION_UNAVAILABLE');
    const lifetime = new AbortController();
    let disposed = false;
    const unregister = connection.fetch.register({ path: '/api/' + RUN_ENDPOINT, methods: ['POST'], requestBody: 'buffered', async fetch(request) {
            const peer = connection.browserPeer, principal = peer?.principal;
            if (disposed || principal?.kind !== 'owner')
                return new Response('Forbidden', { status: 403 });
            const assertOwner = () => { if (disposed || request.signal.aborted || lifetime.signal.aborted || ctx.get('connection') !== connection || connection.browserPeer !== peer || peer?.principal !== principal || principal.kind !== 'owner') throw new RunError('OWNER_CHANGED'); };
            let rpcId: string | undefined;
            try {
                assertOwner();
                const body = await boundedRequest(request, assertOwner, AbortSignal.any([request.signal, lifetime.signal, AbortSignal.timeout(2000)]));
                assertOwner();
                const envelope = object(JSON.parse(body), ['type', 'rpcId', 'method', 'payload']);
                if (envelope.type !== 'client-request' || envelope.method !== RUN_ENDPOINT)
                    throw new RunError('INVALID_REQUEST');
                rpcId = text(envelope.rpcId, 128);
                const input = object(envelope.payload, ['op', 'chatSessionId', 'runId', 'evidenceId']), chatSessionId = opaque(input.chatSessionId), op = input.op;
                if (!['list', 'get', 'evidence', 'export'].includes(String(op)))
                    throw new RunError('INVALID_REQUEST');
                const allowed = op === 'list' ? ['op', 'chatSessionId'] : op === 'evidence' ? ['op', 'chatSessionId', 'runId', 'evidenceId'] : ['op', 'chatSessionId', 'runId'];
                object(input, allowed);
                const signal = AbortSignal.any([request.signal, lifetime.signal]), resolved = await options.resolveScope(chatSessionId, signal);
                assertOwner();
                if (resolved.chatSessionId !== chatSessionId)
                    throw new RunError('OWNER_CHANGED');
                const scope: RunReadScope = { chatSessionId, signal, assertCurrent() { assertOwner(); if (disposed || signal.aborted)
                        throw new RunError('CALLER_NOT_LIVE'); resolved.assertCurrent(); } };
                scope.assertCurrent();
                let value: unknown;
                if (op === 'list')
                    value = await reader.list(scope);
                else if (op === 'get')
                    value = await reader.get(scope, uuid(input.runId));
                else if (op === 'export')
                    value = await reader.export(scope, uuid(input.runId));
                else {
                    const ref = await reader.evidence(scope, uuid(input.runId), uuid(input.evidenceId));
                    scope.assertCurrent();
                    const bytes = await options.readEvidence(Object.freeze(structuredClone(ref)), signal);
                    scope.assertCurrent();
                    if (bytes.byteLength !== ref.bytes || bytes.byteLength > 20 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== ref.sha256)
                        throw new RunError('EVIDENCE_UNAVAILABLE');
                    value = { evidenceId: ref.evidenceId, mediaType: ref.mediaType, sha256: ref.sha256, bytes: ref.bytes, width: ref.width, height: ref.height, base64: Buffer.from(bytes).toString('base64') };
                }
                scope.assertCurrent();
                return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: op === 'evidence' ? value : JSON.parse(canonicalJSON(value)) } }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
            }
            catch (error) {
                return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { code: errorCode(error), message: '任务记录暂不可用，请刷新后重试。' } } }, { headers: { 'Cache-Control': 'no-store' } });
            }
        } });
    return async () => { if (disposed)
        return; disposed = true; lifetime.abort(new Error('Run history provider disposed')); await unregister(); };
}
