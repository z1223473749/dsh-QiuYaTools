/** Public owner RPC bridge; all browser/native operations remain read-only in the Host source. */
import { AnnotationError, sameAnchor } from './contract.ts';
import { parseStyleBaseline } from '../annotation-styles/contract.ts';
import type { AnnotationAnchor, AnnotationPoint } from './contract.ts';
import { ANNOTATION_ENDPOINT } from './source-contract.ts';
import type { AnnotationSourceCapture, AnnotationSourceTarget, AnnotationElementSelection } from './source-contract.ts';
import { annotationCapture, annotationCheck, annotationElement, annotationObject, annotationPointDTO, annotationTarget } from './source-validation.ts';
import { uuid } from '../workbench/contract.ts';
export interface AnnotationConnection {
    rpc: {
        call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{
            ok: boolean;
            value?: unknown;
            error?: {
                code?: string;
            };
        }>;
    };
}
export function createAnnotationAPI(connection: () => AnnotationConnection | undefined) {
    const leases = new Map<string, AnnotationSourceCapture>(), elements = new Map<string, Map<string, AnnotationElementSelection>>();
    const call = async (payload: Record<string, unknown>, signal: AbortSignal) => {
        const peer = connection();
        signal.throwIfAborted();
        if (!peer)
            throw new AnnotationError('UNAVAILABLE', '聊天连接尚未就绪。');
        const guard = () => { signal.throwIfAborted(); if (connection() !== peer)
            throw new AnnotationError('OWNER_CHANGED', '聊天连接已变化。'); };
        const result = await peer.rpc.call('/api', ANNOTATION_ENDPOINT, payload, signal);
        guard();
        if (!result.ok)
            throw new AnnotationError(result.error?.code === 'OWNER_CHANGED' ? 'OWNER_CHANGED' : 'UNAVAILABLE', '批注画面暂不可用，请重新截取。');
        return { value: result.value, guard };
    };
    const owned = (chat: string, captureId: string) => { const capture = leases.get(uuid(captureId)); if (!capture || capture.capture.anchor.chatSessionId !== chat)
        throw new AnnotationError('OWNER_CHANGED', '批注不属于当前聊天。'); return capture; };
    return {
        async capture(target: AnnotationSourceTarget, signal: AbortSignal) {
            const t = annotationTarget(target, target.chatSessionId), response = await call({ op: 'capture', chatSessionId: t.chatSessionId, target: t }, signal), captured = await annotationCapture(response.value, t.chatSessionId);
            response.guard();
            const a = captured.capture.anchor;
            if (a.environmentId !== t.environmentId || a.workbenchTabId !== t.workbenchTabId || a.targetId !== t.targetId || a.appId !== t.appId || a.kind !== t.kind || a.epoch !== t.epoch || captured.expiresAt <= Date.now() || leases.has(captured.captureId))
                throw new AnnotationError('INVALID_FRAME', '批注画面归属已变化。');
            if (leases.size >= 128)
                throw new AnnotationError('UNAVAILABLE', '请关闭其他批注后重试。');
            leases.set(captured.captureId, captured);
            elements.set(captured.captureId, new Map());
            return captured;
        },
        async check(chat: string, captureId: string, elementIds: readonly string[], signal: AbortSignal) {
            const lease = owned(chat, captureId);
            if (elementIds.length > 64 || new Set(elementIds).size !== elementIds.length)
                throw new AnnotationError('INVALID_MARK', '批注元素无效。');
            const response = await call({ op: 'check', chatSessionId: chat, captureId, elementIds: elementIds.map(uuid) }, signal), checked = annotationCheck(response.value, chat, captureId);
            response.guard();
            if (checked.valid && (!sameAnchor(checked.anchor, lease.capture.anchor) || checked.checkedAgainst.imageSHA256 !== lease.capture.anchor.imageSHA256 || checked.checkedAgainst.viewportVersion !== lease.capture.anchor.viewportVersion))
                throw new AnnotationError('INVALID_FRAME', '批注画面核验不一致。');
            return checked;
        },
        async hitTest(chat: string, captureId: string, point: AnnotationPoint, signal: AbortSignal) {
            const lease = owned(chat, captureId);
            if (!lease.elementHitTest || lease.capture.anchor.kind !== 'browser')
                throw new AnnotationError('UNAVAILABLE', '此画面不支持网页元素批注。');
            const response = await call({ op: 'hitTest', chatSessionId: chat, captureId, point: annotationPointDTO(point) }, signal), selected = annotationElement(response.value, captureId, lease.capture.anchor);
            response.guard();
            if (owned(chat, captureId) !== lease) throw new AnnotationError('OWNER_CHANGED', '批注画面已关闭。');
            elements.get(captureId)?.set(selected.elementId, selected);
            return selected;
        },
        async styles(chat: string, captureId: string, elementId: string, signal: AbortSignal) {
            const lease = owned(chat, captureId), selected = elements.get(captureId)?.get(uuid(elementId));
            if (!selected || !lease.elementHitTest || lease.capture.anchor.kind !== 'browser') throw new AnnotationError('UNAVAILABLE', '请先选取当前网页元素。');
            const response = await call({ op: 'styles', chatSessionId: chat, captureId, elementId }, signal), baseline = parseStyleBaseline(response.value, lease, selected);
            response.guard();
            if (owned(chat, captureId) !== lease) throw new AnnotationError('OWNER_CHANGED', '批注画面已关闭。');
            return baseline;
        },
        async release(chat: string, captureId: string, signal: AbortSignal) {
            owned(chat, captureId);
            leases.delete(captureId); elements.delete(captureId);
            const response = await call({ op: 'release', chatSessionId: chat, captureId }, signal), value = annotationObject(response.value, ['released', 'captureId']);
            response.guard();
            if (value.released !== true || value.captureId !== captureId)
                throw new AnnotationError('UNAVAILABLE', '批注画面释放尚未确认。');
        },
        forget(captureId: string) { leases.delete(captureId); elements.delete(captureId); },
    };
}
export type AnnotationAPI = ReturnType<typeof createAnnotationAPI>;
export type AnnotationAnchorGetter = () => AnnotationAnchor | undefined;
