/** One editor lease and explicit public-chat submission. Polling never creates device input. */
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client';
import { AnnotationError, sameAnchor } from './contract.ts';
import type { AnnotationAnchor, AnnotationDraft, AnnotationPoint } from './contract.ts';
import type { AnnotationAPI } from './client-api.ts';
import type { AnnotationSourceCapture, AnnotationSourceTarget } from './source-contract.ts';
import { AnnotationSubmission } from './submission.ts';
import type { AnnotationImage } from './render.ts';
export interface AnnotationEditorSessionOptions {
    api: AnnotationAPI;
    target: AnnotationSourceTarget;
    currentChat(): string | undefined;
    binding(chat: string): SessionBinding | undefined;
    signal: AbortSignal;
    render?(draft: AnnotationDraft, signal: AbortSignal): Promise<AnnotationImage>;
    /** Shorter values are useful in isolated timer tests; production stays500ms. */
    pollMs?: number;
}
export interface AnnotationEditorSessionSnapshot {
    readonly currentAnchor?: AnnotationAnchor;
    readonly message: string;
    readonly invalid: boolean;
}
export class AnnotationEditorSession {
    readonly submission: AnnotationSubmission;
    #snapshot: AnnotationEditorSessionSnapshot;
    #controller = new AbortController();
    #signal: AbortSignal;
    #listeners = new Set<() => void>();
    #timer?: ReturnType<typeof setTimeout>;
    #closed = false;
    #styleRead = false;
    #disposing?: Promise<void>;
    #serial = 0;
    // Keep every read of the same frozen Host lease in one lane. A final check
    // must follow an already issued poll without changing its serial in flight.
    #sourceTail: Promise<void> = Promise.resolve();
    #elements: readonly string[] = [];
    #unsubscribe: () => void;
    private constructor(readonly options: AnnotationEditorSessionOptions, readonly source: AnnotationSourceCapture) {
        this.#snapshot = Object.freeze({ currentAnchor: source.capture.anchor, message: '', invalid: false });
        this.#signal = AbortSignal.any([options.signal, this.#controller.signal]);
        this.submission = new AnnotationSubmission({ currentChat: options.currentChat, binding: options.binding, currentAnchor: () => this.currentAnchor(), verifyCurrent: async (anchor, signal, elementIds = []) => {
                this.#assert();
                if (!sameAnchor(anchor, source.capture.anchor))
                    throw new AnnotationError('STALE_ANCHOR', '批注画面归属已变化。');
                return this.#readSource(async () => {
                    const checked = await options.api.check(anchor.chatSessionId, source.captureId, elementIds, signal);
                    this.#assert();
                    signal.throwIfAborted();
                    if (!checked.valid) {
                        this.#invalidate('画面已导航、滚动或变化，请重新截取。');
                        throw new AnnotationError('STALE_ANCHOR', '画面已变化，请重新截取后批注。');
                    }
                    return checked.anchor;
                }, signal);
            }, ...(options.render ? { render: options.render } : {}), signal: this.#signal });
        this.#unsubscribe = this.submission.subscribe(() => { if (this.submission.getSnapshot().state !== 'editing')
            this.#clearTimer(); });
        this.#signal.addEventListener('abort', this.#abort, { once: true });
        if (this.#signal.aborted)
            this.#abort();
        else
            this.#schedule();
    }
    static async open(options: AnnotationEditorSessionOptions): Promise<AnnotationEditorSession> {
        options.signal.throwIfAborted();
        if (options.currentChat() !== options.target.chatSessionId)
            throw new AnnotationError('OWNER_CHANGED', '当前聊天已变化。');
        const source = await options.api.capture(options.target, options.signal);
        if (options.signal.aborted || options.currentChat() !== options.target.chatSessionId) {
            try {
                await options.api.release(source.capture.anchor.chatSessionId, source.captureId, AbortSignal.timeout(2000));
            }
            catch {
                options.api.forget(source.captureId);
            }
            ;
            throw new AnnotationError('OWNER_CHANGED', '当前聊天已变化。');
        }
        return new AnnotationEditorSession(options, source);
    }
    getSnapshot = (): AnnotationEditorSessionSnapshot => this.#snapshot;
    subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
    #set(value: AnnotationEditorSessionSnapshot): void { this.#snapshot = Object.freeze(value); for (const listener of this.#listeners)
        listener(); }
    #assert(): void { this.#signal.throwIfAborted(); if (this.#closed || this.options.currentChat() !== this.source.capture.anchor.chatSessionId || this.#snapshot.invalid || this.source.expiresAt <= Date.now())
        throw new AnnotationError('STALE_ANCHOR', '批注画面已失效，请重新截取。'); }
    currentAnchor(): AnnotationAnchor | undefined { if (this.#closed || this.#signal.aborted || this.options.currentChat() !== this.source.capture.anchor.chatSessionId)
        return undefined; if (this.submission.getSnapshot().issued)
        return this.source.capture.anchor; return this.#snapshot.invalid || this.source.expiresAt <= Date.now() ? undefined : this.#snapshot.currentAnchor; }
    #readSource<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
        const pending = this.#sourceTail.then(() => {
            this.#assert();
            signal.throwIfAborted();
            return read();
        });
        this.#sourceTail = pending.then(() => { }, () => { });
        return pending;
    }
    #clearTimer(): void { if (this.#timer !== undefined)
        clearTimeout(this.#timer); this.#timer = undefined; }
    #invalidate(message: string): void { this.#clearTimer(); this.#serial++; this.#set({ invalid: true, message }); if (!this.submission.getSnapshot().issued)
        this.submission.cancel(); }
    #abort = (): void => { this.#clearTimer(); this.#serial++; this.#set({ invalid: true, message: '当前聊天已变化，请重新打开批注。' }); };
    #schedule(): void { if (this.#closed || this.#styleRead || this.#signal.aborted || this.#snapshot.invalid || this.submission.getSnapshot().state !== 'editing')
        return; this.#timer = setTimeout(() => { this.#timer = undefined; void this.check().finally(() => this.#schedule()); }, Math.max(10, Math.min(500, this.options.pollMs ?? 500))); }
    async check(): Promise<void> {
        if (this.submission.getSnapshot().state !== 'editing' || this.#styleRead || this.#closed || this.#snapshot.invalid)
            return;
        const serial = ++this.#serial;
        try {
            this.#assert();
            await this.#readSource(async () => {
                const check = await this.options.api.check(this.source.capture.anchor.chatSessionId, this.source.captureId, this.#elements, this.#signal);
                this.#assert();
                if (serial !== this.#serial || this.submission.getSnapshot().issued)
                    return;
                if (!check.valid)
                    this.#invalidate('画面已导航、滚动或变化，请关闭草稿后重新截取。');
            }, this.#signal);
        }
        catch {
            if (!this.#closed && !this.submission.getSnapshot().issued && serial === this.#serial)
                this.#invalidate('当前画面暂时无法核验，请重新截取。');
        }
    }
    onDraftChange = (draft: AnnotationDraft): void => { if (!sameAnchor(draft.capture.anchor, this.source.capture.anchor)) {
        this.#invalidate('批注画面归属已变化。');
        return;
    } ; this.#elements = Object.freeze(draft.marks.filter(mark => mark.kind === 'element').map(mark => mark.elementId)); };
    element = async (point: AnnotationPoint, signal: AbortSignal) => {
        this.#assert();
        if (!this.source.elementHitTest || this.submission.getSnapshot().state !== 'editing')
            throw new AnnotationError('UNAVAILABLE', '此画面不支持网页元素批注。');
        const combined = AbortSignal.any([signal, this.#signal]);
        return this.#readSource(async () => {
            if (this.submission.getSnapshot().state !== 'editing')
                throw new AnnotationError('UNAVAILABLE', '此批注正在提交，暂时不能选取元素。');
            const selected = await this.options.api.hitTest(this.source.capture.anchor.chatSessionId, this.source.captureId, point, combined);
            this.#assert();
            combined.throwIfAborted();
            return selected;
        }, combined);
    };
    styles = async (elementId: string, signal: AbortSignal) => {
        this.#assert();
        if (this.#styleRead || !this.source.elementHitTest || !this.#elements.includes(elementId) || this.submission.getSnapshot().state !== 'editing') throw new AnnotationError('UNAVAILABLE', '请先选取当前网页元素。');
        this.#styleRead = true; this.#clearTimer(); this.#serial++;
        const combined = AbortSignal.any([signal, this.#signal]);
        try {
            return await this.#readSource(async () => {
                if (this.submission.getSnapshot().state !== 'editing')
                    throw new AnnotationError('UNAVAILABLE', '此批注正在提交，暂时不能读取样式。');
                const baseline = await this.options.api.styles(this.source.capture.anchor.chatSessionId, this.source.captureId, elementId, combined);
                this.#assert(); combined.throwIfAborted();
                if (!this.#elements.includes(elementId)) throw new AnnotationError('STALE_ANCHOR', '选中的元素已变化。');
                return baseline;
            }, combined);
        } finally { this.#styleRead = false; this.#schedule(); }
    };
    dispose(): Promise<void> {
        if (this.#disposing)
            return this.#disposing;
        this.#closed = true;
        this.#clearTimer();
        this.#serial++;
        this.#controller.abort();
        this.#signal.removeEventListener('abort', this.#abort);
        this.#unsubscribe();
        this.submission.dispose();
        this.#listeners.clear();
        this.#disposing = this.options.api.release(this.source.capture.anchor.chatSessionId, this.source.captureId, AbortSignal.timeout(2000)).catch(error => { this.options.api.forget(this.source.captureId); throw error; });
        return this.#disposing;
    }
}
