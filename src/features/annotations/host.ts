/** Exact-owner, read-only annotation source route. No Agent/model tools or device action entry. */
import type { Context } from '@deepseek-ai/cordis';
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';
import { hostServiceIdentity } from '../../host-service-identity.ts';
import { AnnotationError, sameAnchor } from './contract.ts';
import { requireIdentity } from '../computer-use/contract.ts';
import { uuid } from '../workbench/contract.ts';
import type { AnnotationSource, AnnotationSourceScope, AnnotationSourceCapture, AnnotationSourceTarget } from './source-contract.ts';
import { ANNOTATION_ENDPOINT } from './source-contract.ts';
import { annotationObject, annotationTarget, annotationCapture, annotationCheck, annotationPointDTO, annotationElement } from './source-validation.ts';
export interface AnnotationHostOptions {
    source: AnnotationSource;
    resolveScope(chat: string, signal: AbortSignal): Promise<{
        chatSessionId: string;
        signal: AbortSignal;
        assertCurrent(): void;
    }>;
}
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const unavailable = () => new AnnotationError('UNAVAILABLE', '批注画面暂不可用，请重新截取。');
const ownerChanged = () => new AnnotationError('OWNER_CHANGED', '当前聊天连接已变化，批注未向其他聊天发送。');
async function body(request: Request, guard: () => void, signal: AbortSignal): Promise<string> {
    guard();
    signal.throwIfAborted();
    const reader = request.body?.getReader();
    if (!reader)
        throw unavailable();
    const chunks: Uint8Array[] = [];
    let count = 0;
    const abort = () => { void reader.cancel().catch(() => { }); };
    signal.addEventListener('abort', abort, { once: true });
    try {
        while (true) {
            guard();
            signal.throwIfAborted();
            const part = await reader.read();
            guard();
            signal.throwIfAborted();
            if (part.done)
                break;
            count += part.value.byteLength;
            if (count > 32768)
                throw unavailable();
            chunks.push(part.value);
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    }
    finally {
        signal.removeEventListener('abort', abort);
        void reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
function bounded<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(ownerChanged()); };
        signal.addEventListener('abort', abort, { once: true });
        value.then(result => { signal.removeEventListener('abort', abort); if (signal.aborted)
            reject(ownerChanged());
        else
            resolve(result); }, error => { signal.removeEventListener('abort', abort); reject(error); });
        if (signal.aborted)
            abort();
    });
}
function sameTarget(a: AnnotationSourceTarget, b: AnnotationSourceTarget): boolean { return a.chatSessionId === b.chatSessionId && a.environmentId === b.environmentId && a.workbenchTabId === b.workbenchTabId && a.targetId === b.targetId && a.appId === b.appId && a.kind === b.kind && a.epoch === b.epoch; }
export function installAnnotationHost(ctx: Context, options: AnnotationHostOptions): () => Promise<void> {
    const connection = ctx.get('connection') as Pick<HostConnectionHandle, 'browserPeer' | 'fetch'> | undefined, identity = hostServiceIdentity(connection);
    if (!connection || !identity)
        throw unavailable();
    const lifetime = new AbortController(), keys = new WeakMap<object, {
        peer: object;
        key: object;
    }>(), leases = new Map<string, {
        owner: object;
        source: AnnotationSourceCapture;
        invalid: boolean;
        serial: number;
        elements: Set<string>;
    }>();
    let disposed = false, disposing: Promise<void> | undefined;
    const unregister = connection.fetch.register({ path: '/api/' + ANNOTATION_ENDPOINT, methods: ['POST'], requestBody: 'buffered', async fetch(request) {
            const peer = connection.browserPeer, principal = peer?.principal, originalSignal = request.signal;
            if (disposed || !peer || principal?.kind !== 'owner')
                return new Response('Forbidden', { status: 403, headers });
            const signal = AbortSignal.any([originalSignal, lifetime.signal, AbortSignal.timeout(15000)]);
            const guard = () => { if (disposed || signal.aborted || request.signal !== originalSignal || hostServiceIdentity(ctx.get('connection')) !== identity || connection.browserPeer !== peer || peer.principal !== principal || principal.kind !== 'owner')
                throw ownerChanged(); };
            let rpcId: string | undefined;
            try {
                guard();
                const text = await body(request, guard, AbortSignal.any([signal, AbortSignal.timeout(2000)]));
                guard();
                const envelope = annotationObject(JSON.parse(text), ['type', 'rpcId', 'method', 'payload']);
                if (envelope.type !== 'client-request' || envelope.method !== ANNOTATION_ENDPOINT)
                    throw unavailable();
                rpcId = requireIdentity(envelope.rpcId);
                const input = annotationObject(envelope.payload, ['op', 'chatSessionId', 'target', 'captureId', 'elementIds', 'point']), fields: Record<string, readonly string[]> = { capture: ['target'], check: ['captureId', 'elementIds'], hitTest: ['captureId', 'point'], release: ['captureId'] };
                if (typeof input.op !== 'string' || !Object.hasOwn(fields, input.op))
                    throw unavailable();
                annotationObject(input, ['op', 'chatSessionId', ...fields[input.op]!]);
                if (input.op === 'capture')
                    annotationObject(input.target, ['chatSessionId', 'environmentId', 'workbenchTabId', 'targetId', 'appId', 'kind', 'epoch']);
                const chat = requireIdentity(input.chatSessionId), target = input.op === 'capture' ? annotationTarget(input.target, chat) : undefined, id = input.op === 'capture' ? undefined : uuid(input.captureId), point = input.op === 'hitTest' ? annotationPointDTO(input.point) : undefined;
                let elementIds: readonly string[] = [];
                if (input.op === 'check') {
                    if (!Array.isArray(input.elementIds) || input.elementIds.length > 64)
                        throw unavailable();
                    elementIds = input.elementIds.map(uuid);
                    if (new Set(elementIds).size !== elementIds.length)
                        throw unavailable();
                }
                guard();
                const resolved = await bounded(options.resolveScope(chat, signal), signal);
                guard();
                if (resolved.chatSessionId !== chat)
                    throw ownerChanged();
                let key = keys.get(principal);
                if (!key || key.peer !== peer) {
                    key = { peer, key: Object.freeze({}) };
                    keys.set(principal, key);
                }
                const scopeSignal = AbortSignal.any([signal, resolved.signal]), scope: AnnotationSourceScope = { chatSessionId: chat, ownerKey: key.key, signal: scopeSignal, assertCurrent() { guard(); scopeSignal.throwIfAborted(); resolved.assertCurrent(); if (resolved.chatSessionId !== chat)
                        throw ownerChanged(); } };
                scope.assertCurrent();
                let value: unknown;
                if (input.op === 'capture') {
                    for (const [captureId, lease] of leases)
                        if (lease.source.expiresAt <= Date.now())
                            leases.delete(captureId);
                    if (leases.size >= 128)
                        throw unavailable();
                    const raw = await bounded(options.source.capture(scope, target!), scopeSignal);
                    scope.assertCurrent();
                    const captured = await annotationCapture(raw, chat);
                    scope.assertCurrent();
                    if (!sameTarget(captured.capture.anchor, target!) || captured.expiresAt <= Date.now() || leases.has(captured.captureId))
                        throw unavailable();
                    leases.set(captured.captureId, { owner: scope.ownerKey, source: captured, invalid: false, serial: 0, elements: new Set() });
                    value = captured;
                }
                else {
                    const lease = leases.get(id!);
                    if (!lease || lease.owner !== scope.ownerKey || lease.source.capture.anchor.chatSessionId !== chat)
                        throw ownerChanged();
                    if (input.op === 'release') {
                        leases.delete(id!);
                        await bounded(options.source.release(scope, id!), scopeSignal);
                        scope.assertCurrent();
                        value = { released: true, captureId: id };
                    }
                    else if (lease.invalid || lease.source.expiresAt <= Date.now()) {
                        lease.invalid = true;
                        if (input.op !== 'check')
                            throw new AnnotationError('STALE_ANCHOR', '画面已变化，请重新截取。');
                        value = { captureId: id, valid: false, reason: 'expired' };
                    }
                    else if (input.op === 'check') {
                        if (elementIds.some(elementId => !lease.elements.has(elementId)))
                            throw unavailable();
                        const serial = ++lease.serial, raw = await bounded(options.source.check(scope, id!, elementIds), scopeSignal);
                        scope.assertCurrent();
                        if (lease.invalid || leases.get(id!) !== lease || lease.serial !== serial)
                            throw unavailable();
                        const checked = annotationCheck(raw, chat, id!);
                        scope.assertCurrent();
                        if (checked.valid && (!sameAnchor(checked.anchor, lease.source.capture.anchor) || checked.checkedAgainst.imageSHA256 !== checked.anchor.imageSHA256 || checked.checkedAgainst.viewportVersion !== checked.anchor.viewportVersion))
                            throw unavailable();
                        if (!checked.valid)
                            lease.invalid = true;
                        value = checked;
                    }
                    else {
                        if (!lease.source.elementHitTest || lease.source.capture.anchor.kind !== 'browser' || lease.elements.size >= 64 || point!.x > lease.source.capture.anchor.width || point!.y > lease.source.capture.anchor.height)
                            throw unavailable();
                        const serial = ++lease.serial, raw = await bounded(options.source.hitTest(scope, id!, point!), scopeSignal);
                        scope.assertCurrent();
                        if (lease.invalid || leases.get(id!) !== lease || lease.serial !== serial)
                            throw unavailable();
                        const selected = annotationElement(raw, id!, lease.source.capture.anchor);
                        scope.assertCurrent();
                        lease.elements.add(selected.elementId);
                        value = selected;
                    }
                }
                scope.assertCurrent();
                return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } }, { headers });
            }
            catch (error) {
                const code = error instanceof AnnotationError ? error.code : 'UNAVAILABLE';
                return Response.json({ type: 'server-response', ...(rpcId === undefined ? {} : { rpcId }), result: { ok: false, error: { code, message: code === 'OWNER_CHANGED' ? '当前聊天连接已变化，请重新打开批注。' : '批注画面暂不可用，请重新截取。' } } }, { headers });
            }
        } });
    return () => {
        if (disposing) return disposing;
        disposed = true; lifetime.abort(); leases.clear();
        disposing = Promise.resolve().then(() => unregister());
        return disposing;
    };
}
