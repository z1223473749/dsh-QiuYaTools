/** Explicit public Session submission, bound to one exact current chat and frozen preview. */
import type { SessionBinding, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client';
import { AnnotationError, assertCurrentAnchor, decodeBase64, sha256 } from './contract.ts';
import type { AnnotationAnchor, AnnotationDraft } from './contract.ts';
import { renderAnnotationImage, validateAnnotationDraft } from './render.ts';
import type { AnnotationImage } from './render.ts';
export type AnnotationSubmissionState = 'editing' | 'rendering' | 'verifying' | 'sending' | 'awaiting-receipt' | 'delivered' | 'unknown' | 'rejected' | 'invalidated' | 'cancelled';
export interface AnnotationSubmissionSnapshot {
    readonly state: AnnotationSubmissionState;
    readonly issued: boolean;
    readonly message: string;
}
export interface AnnotationSubmissionOptions {
    readonly currentChat: () => string | undefined;
    readonly binding: (chat: string) => SessionBinding | undefined;
    /** Trusted Host read-only version check; must not recapture or inject any input. Missing capability disables submission. */
    readonly currentAnchor?: () => AnnotationAnchor | undefined;
    readonly verifyCurrent?: (anchor: AnnotationAnchor, signal: AbortSignal, elementIds?: readonly string[]) => Promise<AnnotationAnchor>;
    readonly render?: (draft: AnnotationDraft, signal: AbortSignal) => Promise<AnnotationImage>;
    readonly signal: AbortSignal;
    readonly receiptTimeoutMs?: number;
    readonly operationTimeoutMs?: number;
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
        signal.addEventListener('abort', aborted, { once: true });
        promise.then(value => { signal.removeEventListener('abort', aborted); if (!signal.aborted)
            resolve(value); }, error => { signal.removeEventListener('abort', aborted); reject(error); });
        if (signal.aborted)
            aborted();
    });
}
const textOf = (entry: SessionEventLikeEntry): string | undefined => entry.type === 'event' && entry.event.type === 'user/message' && entry.event.data.source.kind === 'user' ? entry.event.data.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : undefined;
function durableMatch(entry: SessionEventLikeEntry, text: string, afterSeq: number): boolean {
    if (entry.type !== 'event' || entry.event.type !== 'user/message' || entry.event.seq <= afterSeq || textOf(entry) !== text)
        return false;
    // The public Host promotes a submitted image into its durable attachment reference (normalization may change bytes).
    const images = entry.event.data.content.filter(part => part.type === 'image');
    return images.length === 1 && !!images[0]?.attachment.attachmentId && images[0].attachment.width > 0 && images[0].attachment.height > 0 && images[0].attachment.bytes > 0;
}
export function annotationPrompt(draft: AnnotationDraft, image: AnnotationImage, nonce: string): string {
    return ['请根据这张带批注的画面完成以下需求。批注只对应本次冻结画面；继续操作前请重新观察当前应用。', `批注编号：${nonce}`, `画面校验：${draft.capture.anchor.imageSHA256}`, `批注图片校验：${image.sha256}`, draft.note.trim() || '请查看图中的标注。', ...draft.marks.map((m, i) => m.kind === 'text' ? `${i + 1}. 文字：${m.text}` : m.kind === 'element' ? `${i + 1}. 网页元素：${m.role} ${m.name}（原图坐标）：${Math.round(m.rectangle.x)},${Math.round(m.rectangle.y)}，宽 ${Math.round(m.rectangle.width)}，高 ${Math.round(m.rectangle.height)}` : `${i + 1}. ${m.kind === 'arrow' ? '箭头' : '选框'}（原图坐标）：${Math.round(m.from.x)},${Math.round(m.from.y)} → ${Math.round(m.to.x)},${Math.round(m.to.y)}`)].join('\n');
}
/** One editor lifetime; once prompt is issued, an unknown response cannot trigger another call. */
export class AnnotationSubmission {
    #snapshot: AnnotationSubmissionSnapshot = Object.freeze({ state: 'editing', issued: false, message: '' });
    #listeners = new Set<() => void>();
    #controller = new AbortController();
    #unsubscribe?: () => void;
    #timer?: ReturnType<typeof setTimeout>;
    #busy = false;
    #disposed = false;
    #signal: AbortSignal;
    constructor(readonly options: AnnotationSubmissionOptions) { this.#signal = AbortSignal.any([options.signal, this.#controller.signal]); this.#signal.addEventListener('abort', this.#onAbort, { once: true }); if (this.#signal.aborted)
        this.#onAbort(); }
    getSnapshot = (): AnnotationSubmissionSnapshot => this.#snapshot;
    subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
    get available(): boolean { return typeof this.options.verifyCurrent === 'function' && typeof this.options.currentAnchor === 'function'; }
    #set(state: AnnotationSubmissionState, message: string, issued = this.#snapshot.issued): void { if (this.#disposed)
        return; this.#snapshot = Object.freeze({ state, issued, message }); for (const listener of this.#listeners)
        listener(); }
    #clearWatch(): void { this.#unsubscribe?.(); this.#unsubscribe = undefined; if (this.#timer !== undefined)
        clearTimeout(this.#timer); this.#timer = undefined; }
    #onAbort = (): void => { this.#clearWatch(); if (!['delivered', 'rejected'].includes(this.#snapshot.state))
        this.#set(this.#snapshot.issued ? 'unknown' : 'cancelled', this.#snapshot.issued ? '已发出提交请求，结果尚未确认。请查看当前聊天，勿重复发送。' : '已取消批注，尚未发送。'); };
    cancel(): boolean { if (this.#snapshot.issued)
        return false; this.#controller.abort(); return true; }
    dispose(): void { this.#controller.abort(); this.#clearWatch(); this.#signal.removeEventListener('abort', this.#onAbort); this.#disposed = true; this.#listeners.clear(); }
    async submit(input: AnnotationDraft): Promise<void> {
        if (this.#busy || this.#snapshot.issued || this.#disposed || this.#snapshot.state !== 'editing')
            throw new AnnotationError('ALREADY_ISSUED', '此批注已提交或已结束，请查看原聊天。');
        if (!this.options.verifyCurrent || !this.options.currentAnchor)
            throw new AnnotationError('UNAVAILABLE', '当前工作台尚不支持核验批注画面，请先保留草稿。');
        this.#signal.throwIfAborted();
        const draft = validateAnnotationDraft(input);
        if (!draft.marks.length && !draft.note.trim())
            throw new AnnotationError('INVALID_MARK', '请先添加批注或说明。');
        const chat = draft.capture.anchor.chatSessionId, binding = this.options.binding(chat);
        const operation = new AbortController(), operationSignal = AbortSignal.any([this.#signal, operation.signal]);
        const operationTimer = setTimeout(() => operation.abort(new AnnotationError('UNAVAILABLE', '批注处理超时，请查看提交状态。')), Math.max(1, Math.min(this.options.operationTimeoutMs ?? 15000, 15000)));
        const guard = () => { operationSignal.throwIfAborted(); if (this.options.currentChat() !== chat || !binding || binding.sessionId !== chat || binding.session.sessionId !== chat || this.options.binding(chat) !== binding)
            throw new AnnotationError('OWNER_CHANGED', '当前聊天已变化，批注未向其他聊天发送。'); assertCurrentAnchor(draft.capture.anchor, this.options.currentAnchor?.()); };
        this.#busy = true;
        let handle: ReturnType<SessionBinding['session']['beginSubmission']> | undefined;
        let promptCalled = false;
        try {
            guard();
            this.#set('rendering', '正在生成批注图片…');
            const image = await abortable((this.options.render ?? renderAnnotationImage)(draft, operationSignal), operationSignal);
            guard();
            if (image.mediaType !== 'image/png' || image.width !== draft.capture.anchor.width || image.height !== draft.capture.anchor.height || !/^[a-f0-9]{64}$/u.test(image.sha256))
                throw new AnnotationError('INVALID_FRAME', '批注图片校验失败。');
            const imageBytes = decodeBase64(image.data);
            if (imageBytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => imageBytes[i] === n) || String.fromCharCode(...imageBytes.slice(12, 16)) !== 'IHDR' || new DataView(imageBytes.buffer).getUint32(16) !== image.width || new DataView(imageBytes.buffer).getUint32(20) !== image.height || await sha256(imageBytes) !== image.sha256)
                throw new AnnotationError('INVALID_FRAME', '批注图片字节校验失败。');
            guard();
            this.#set('verifying', '正在核验当前画面…');
            const current = await abortable(this.options.verifyCurrent(draft.capture.anchor, operationSignal, draft.marks.filter(mark => mark.kind === 'element').map(mark => mark.elementId)), operationSignal);
            guard();
            assertCurrentAnchor(draft.capture.anchor, current);
            const text = annotationPrompt(draft, image, crypto.randomUUID()), afterSeq = binding!.eventSource.getSnapshot().entries.reduce((seq, e) => e.type === 'event' ? Math.max(seq, e.event.seq) : seq, -1);
            const inspect = () => {
                try {
                    guard();
                }
                catch {
                    this.#clearWatch();
                    this.#set('unknown', '聊天身份已变化，请在原聊天查看提交结果。');
                    return;
                }
                if (binding!.eventSource.getSnapshot().entries.some(e => durableMatch(e, text, afterSeq))) {
                    this.#clearWatch();
                    this.#set('delivered', '批注已发送到当前聊天。');
                }
            };
            guard();
            this.#unsubscribe = binding!.eventSource.subscribe(inspect);
            guard();
            handle = binding!.session.beginSubmission({ mode: 'queue', text, attachments: [{ type: 'image', value: { previewUrl: 'data:image/png;base64,' + image.data, name: '批注.png', width: image.width, height: image.height } }] });
            guard();
            this.#set('sending', '正在发送到当前聊天…', true);
            promptCalled = true;
            const result = await abortable(binding!.session.prompt([{ type: 'text', text }, { type: 'image', mediaType: image.mediaType, data: image.data, name: '批注.png' }], 'queue', operationSignal, handle.requestId), operationSignal);
            guard();
            inspect();
            if (this.getSnapshot().state === 'delivered')
                return;
            if (!result.ok) {
                this.#clearWatch();
                this.#set('rejected', '聊天未接受此批注，请保留草稿后检查。');
                return;
            }
            this.#set('awaiting-receipt', '已接受提交，正在等待聊天记录确认…');
            this.#timer = setTimeout(() => { this.#clearWatch(); this.#set('unknown', '提交结果尚未确认，请查看当前聊天，勿重复发送。'); }, Math.max(1, Math.min(this.options.receiptTimeoutMs ?? 15000, 15000)));
            inspect();
        }
        catch (error) {
            this.#clearWatch();
            if (this.getSnapshot().state === 'delivered')
                return;
            if (this.getSnapshot().state !== 'delivered') {
                if (this.#snapshot.issued)
                    this.#set('unknown', '提交结果尚未确认，请查看原聊天，勿重复发送。');
                else
                    this.#set(error instanceof AnnotationError && error.code === 'STALE_ANCHOR' ? 'invalidated' : this.#signal.aborted ? 'cancelled' : 'rejected', error instanceof Error ? error.message : '批注暂时未能提交。');
            }
            // Abandon only a pre-prompt local echo; calling it after uncertain admission would misreport delivery.
            if (handle && !promptCalled)
                handle.abandon();
            throw error;
        }
        finally {
            clearTimeout(operationTimer);
            this.#busy = false;
        }
    }
}
