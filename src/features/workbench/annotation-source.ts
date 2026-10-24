/** Owner-only source over real existing browser/native views; never grants, starts, selects or acts. */
import { createHash, randomUUID } from 'node:crypto';
import type { AnnotationSource, AnnotationSourceScope, AnnotationSourceTarget, AnnotationSourceCapture, AnnotationSourceCheck, AnnotationElementSelection } from '../annotations/source-contract.ts';
import { AnnotationError, captureAnnotation } from '../annotations/contract.ts';
import { createStyleBaseline } from '../annotation-styles/contract.ts';
import type { StyleBaseline } from '../annotation-styles/contract.ts';
import type { AnnotationPoint } from '../annotations/contract.ts';
import type { WorkbenchFrame } from './client-api.ts';
import type { WorkbenchRegistry } from './registry.ts';
import type { BrowserWorkbenchRegistry } from './browser-registry.ts';
import type { ComputerEnvironmentManager } from '../computer-use/environment-manager.ts';
import type { BrowserAnnotationView, BrowserAnnotationSnapshot, BrowserAnnotationElement } from '../computer-use/browser-annotation.ts';
type BrowserDescriptor = ReturnType<BrowserWorkbenchRegistry['annotationSource']>;
interface Read {
    frame: WorkbenchFrame;
    version: string;
    browser?: BrowserAnnotationSnapshot;
}
interface Lease {
    id: string;
    ownerKey: object;
    target: AnnotationSourceTarget;
    value: AnnotationSourceCapture;
    read: Read;
    descriptor?: BrowserDescriptor;
    channel?: BrowserAnnotationView;
    invalid?: 'navigation' | 'scroll' | 'geometry' | 'pixels' | 'epoch' | 'expired' | 'element' | 'unavailable';
    elements: Map<string, BrowserAnnotationElement>;
    tail: Promise<unknown>;
    timer: ReturnType<typeof setTimeout>;
    bytes: number;
}
interface SourceOptions {
    registry: Pick<WorkbenchRegistry, 'views' | 'preview'>;
    browsers: Pick<BrowserWorkbenchRegistry, 'annotationSource'>;
    desktopManager?: ComputerEnvironmentManager;
    enabled(): boolean;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const changed = () => new AnnotationError('STALE_ANCHOR', '画面已变化，请重新截取后批注。');
function sameTarget(a: AnnotationSourceTarget, b: AnnotationSourceTarget): boolean { return a.chatSessionId === b.chatSessionId && a.environmentId === b.environmentId && a.workbenchTabId === b.workbenchTabId && a.targetId === b.targetId && a.appId === b.appId && a.kind === b.kind && a.epoch === b.epoch; }
function sameGeometry(a: WorkbenchFrame, b: WorkbenchFrame): boolean { const x = a.observation, y = b.observation; return x.width === y.width && x.height === y.height && x.geometry.x === y.geometry.x && x.geometry.y === y.geometry.y && x.geometry.width === y.geometry.width && x.geometry.height === y.geometry.height && x.geometry.scale === y.geometry.scale; }
export class WorkbenchAnnotationSource implements AnnotationSource {
    #leases = new Map<string, Lease>();
    #pins = new Set<BrowserAnnotationView>();
    #pending = 0;
    #openings = new Set<Promise<AnnotationSourceCapture>>();
    #operations = new Set<Promise<unknown>>();
    #bytes = 0;
    #lifetime = new AbortController();
    #disposed = false;
    #disposing?: Promise<void>;
    constructor(readonly options: SourceOptions) { }
    #scope(scope: AnnotationSourceScope): AnnotationSourceScope { const signal = AbortSignal.any([scope.signal, this.#lifetime.signal]); return { chatSessionId: scope.chatSessionId, ownerKey: scope.ownerKey, signal, assertCurrent: () => { signal.throwIfAborted(); scope.assertCurrent(); if (this.#disposed || !this.options.enabled())
            throw new AnnotationError('UNAVAILABLE', '电脑操控尚未启用。'); } }; }
    #target(target: AnnotationSourceTarget, scope: AnnotationSourceScope): void { scope.assertCurrent(); if (scope.chatSessionId !== target.chatSessionId)
        throw new AnnotationError('OWNER_CHANGED', '批注不属于当前聊天。'); const actual = this.options.registry.views(target.chatSessionId).filter(view => view.environmentId === target.environmentId && view.workbenchTabId === target.workbenchTabId); if (actual.length !== 1 || !sameTarget(actual[0]!, target))
        throw changed(); }
    #lease(scope: AnnotationSourceScope, id: string): Lease { scope.assertCurrent(); const lease = this.#leases.get(id); if (!lease || lease.ownerKey !== scope.ownerKey || lease.target.chatSessionId !== scope.chatSessionId)
        throw new AnnotationError('OWNER_CHANGED', '批注画面不属于当前聊天。'); return lease; }
    async #closeChannel(channel: BrowserAnnotationView | undefined): Promise<void> { if (!channel)
        return; await channel.close(); this.#pins.delete(channel); }
    async #remove(lease: Lease): Promise<void> { if (this.#leases.get(lease.id) === lease) {
        this.#leases.delete(lease.id);
        this.#bytes -= lease.bytes;
        clearTimeout(lease.timer);
    } ; await this.#closeChannel(lease.channel); }
    #read(target: AnnotationSourceTarget, scope: AnnotationSourceScope, descriptor?: BrowserDescriptor, channel?: BrowserAnnotationView): Promise<Read> {
        const guard = () => { this.#target(target, scope); descriptor?.assertCurrent(); };
        return (async () => {
            guard();
            if (channel && descriptor) {
                const browser = await channel.snapshot(scope.signal, guard);
                guard();
                return { frame: { target: { ...descriptor.target }, observation: browser.observation, viewOnly: true }, version: browser.viewportVersion, browser };
            }
            const frame = await this.options.registry.preview(target.chatSessionId, target.environmentId, target.workbenchTabId, scope);
            guard();
            if (!sameTarget(frame.target, target) || frame.observation.targetId !== target.targetId)
                throw changed();
            return { frame, version: digest({ environmentId: target.environmentId, workbenchTabId: target.workbenchTabId, targetId: target.targetId, appId: target.appId, epoch: target.epoch, geometry: frame.observation.geometry, width: frame.observation.width, height: frame.observation.height }) };
        })();
    }
    capture(original: AnnotationSourceScope, target: AnnotationSourceTarget): Promise<AnnotationSourceCapture> { const pending = this.#capture(original, target); this.#openings.add(pending); void pending.then(() => this.#openings.delete(pending), () => this.#openings.delete(pending)); return pending; }
    async #capture(original: AnnotationSourceScope, target: AnnotationSourceTarget): Promise<AnnotationSourceCapture> {
        const scope = this.#scope(original);
        this.#target(target, scope);
        if (this.#leases.size + this.#pending >= 8 || this.#pins.size + this.#pending >= 8)
            throw new AnnotationError('UNAVAILABLE', '请关闭其他画面批注后重试。');
        this.#pending++;
        let descriptor: BrowserDescriptor | undefined, channel: BrowserAnnotationView | undefined;
        try {
            if (target.kind === 'browser') {
                descriptor = this.options.browsers.annotationSource(target.chatSessionId, target.environmentId, target.workbenchTabId);
                this.#target(target, scope);
                if (!sameTarget(descriptor.target, target))
                    throw changed();
                channel = await descriptor.browser.annotationView(target.targetId, descriptor.origin, scope.signal, () => { this.#target(target, scope); descriptor!.assertCurrent(); });
                this.#pins.add(channel);
                this.#target(target, scope);
                descriptor.assertCurrent();
            }
            const read = await this.#read(target, scope, descriptor, channel), capture = await captureAnnotation(read.frame, read.version);
            this.#target(target, scope);
            descriptor?.assertCurrent();
            const bytes = capture.imageBase64.length * 2;
            if (this.#bytes + bytes > 64 * 1024 * 1024)
                throw new AnnotationError('UNAVAILABLE', '批注画面已达到缓存上限，请先关闭其他批注。');
            const id = randomUUID(), expiresAt = Date.now() + 120000, value: AnnotationSourceCapture = Object.freeze({ captureId: id, capture, expiresAt, elementHitTest: read.browser?.elementHitTest === true }), timer = setTimeout(() => { const lease = this.#leases.get(id); if (lease) {
                lease.invalid = 'expired';
                void this.#remove(lease).catch(() => { });
            } }, 120000);
            timer.unref?.();
            const lease: Lease = { id, ownerKey: scope.ownerKey, target: Object.freeze({ ...target }), value, read, ...(descriptor ? { descriptor } : {}), ...(channel ? { channel } : {}), elements: new Map(), tail: Promise.resolve(), timer, bytes };
            this.#leases.set(id, lease);
            this.#bytes += bytes;
            return value;
        }
        catch (failure) {
            try {
                await this.#closeChannel(channel);
            }
            catch (cleanup) {
                throw new AggregateError([failure, cleanup], '批注画面获取与清理未确认。');
            }
            ;
            throw failure;
        }
        finally {
            this.#pending--;
        }
    }
    #operation<T>(original: AnnotationSourceScope, id: string, work: (lease: Lease, scope: AnnotationSourceScope) => Promise<T>): Promise<T> {
        const scope = this.#scope(original), lease = this.#lease(scope, id), pending = lease.tail.catch(() => { }).then(async () => { this.#lease(scope, id); scope.assertCurrent(); if (lease.value.expiresAt <= Date.now())
            lease.invalid = 'expired'; return work(lease, scope); });
        lease.tail = pending;
        this.#operations.add(pending);
        void pending.then(() => this.#operations.delete(pending), () => this.#operations.delete(pending));
        return pending;
    }
    check(original: AnnotationSourceScope, id: string, elementIds: readonly string[]): Promise<AnnotationSourceCheck> {
        return this.#operation(original, id, async (lease, scope) => {
            if (lease.invalid)
                return { captureId: id, valid: false, reason: lease.invalid };
            if (elementIds.length > 64 || new Set(elementIds).size !== elementIds.length || elementIds.some(key => !lease.elements.has(key)))
                throw new AnnotationError('INVALID_MARK', '批注元素未在本画面中选取。');
            try {
                const read = await this.#read(lease.target, scope, lease.descriptor, lease.channel), observed = await captureAnnotation(read.frame, read.version);
                this.#lease(scope, id);
                this.#target(lease.target, scope);
                lease.descriptor?.assertCurrent();
                const checkedAgainst = { frameId: observed.anchor.frameId, imageSHA256: observed.anchor.imageSHA256, viewportVersion: read.version };
                if (!sameGeometry(lease.read.frame, read.frame))
                    lease.invalid = 'geometry';
                else if (lease.read.browser && read.browser && lease.read.browser.navigationVersion !== read.browser.navigationVersion)
                    lease.invalid = 'navigation';
                else if (lease.read.browser && read.browser && lease.read.browser.scrollVersion !== read.browser.scrollVersion)
                    lease.invalid = 'scroll';
                else if (lease.read.browser && read.browser && lease.read.browser.documentVersion !== read.browser.documentVersion)
                    lease.invalid = 'element';
                else if (observed.anchor.imageSHA256 !== lease.value.capture.anchor.imageSHA256)
                    lease.invalid = 'pixels';
                else if (read.version !== lease.read.version)
                    lease.invalid = 'epoch';
                if (!lease.invalid && elementIds.length) {
                    if (!lease.channel || !read.browser)
                        throw changed();
                    for (const key of elementIds) {
                        const current = await lease.channel.elementCurrent(read.browser, lease.elements.get(key)!, scope.signal, () => { this.#lease(scope, id); this.#target(lease.target, scope); lease.descriptor?.assertCurrent(); });
                        this.#lease(scope, id);
                        if (!current) {
                            lease.invalid = 'element';
                            break;
                        }
                    }
                }
                if (lease.invalid)
                    return { captureId: id, valid: false, reason: lease.invalid, checkedAgainst };
                // Original frozen anchor is intentionally retained. The actual newly sampled frame is explicit above.
                return { captureId: id, valid: true, anchor: lease.value.capture.anchor, checkedAgainst };
            }
            catch (error) {
                scope.signal.throwIfAborted();
                this.#lease(scope, id);
                lease.invalid = 'unavailable';
                return { captureId: id, valid: false, reason: 'unavailable' };
            }
        });
    }
    hitTest(original: AnnotationSourceScope, id: string, point: AnnotationPoint): Promise<AnnotationElementSelection> {
        return this.#operation(original, id, async (lease, scope) => {
            if (lease.invalid || !lease.value.elementHitTest || !lease.channel || !lease.read.browser || lease.elements.size >= 64)
                throw changed();
            this.#target(lease.target, scope);
            lease.descriptor?.assertCurrent();
            const current = await this.#read(lease.target, scope, lease.descriptor, lease.channel), image = await captureAnnotation(current.frame, current.version);
            this.#lease(scope, id);
            if (!current.browser || current.version !== lease.read.version || image.anchor.imageSHA256 !== lease.value.capture.anchor.imageSHA256 || !sameGeometry(current.frame, lease.read.frame)) {
                lease.invalid = 'pixels';
                throw changed();
            }
            const selected = await lease.channel.hitTest(current.browser, point, scope.signal, () => { this.#lease(scope, id); this.#target(lease.target, scope); lease.descriptor?.assertCurrent(); });
            this.#lease(scope, id);
            this.#target(lease.target, scope);
            const elementId = randomUUID();
            lease.elements.set(elementId, selected);
            return Object.freeze({ captureId: id, elementId, viewportVersion: lease.read.version, rectangle: Object.freeze({ ...selected.rectangle }), role: selected.role, name: selected.name });
        });
    }
    styles(original: AnnotationSourceScope, id: string, elementId: string): Promise<StyleBaseline> {
        return this.#operation(original, id, async (lease, scope) => {
            const selected = lease.elements.get(elementId);
            if (lease.invalid || !selected || !lease.channel?.computedStyles || !lease.read.browser) throw changed();
            const guard = () => { this.#lease(scope, id); this.#target(lease.target, scope); lease.descriptor?.assertCurrent(); };
            const verify = async () => {
                guard();
                const current = await this.#read(lease.target, scope, lease.descriptor, lease.channel), image = await captureAnnotation(current.frame, current.version);
                guard();
                if (!current.browser || current.version !== lease.read.version || image.anchor.imageSHA256 !== lease.value.capture.anchor.imageSHA256 || !sameGeometry(current.frame, lease.read.frame)) { lease.invalid = 'pixels'; throw changed(); }
                return current.browser;
            };
            const before = await verify(), values = await lease.channel.computedStyles(before, selected, scope.signal, guard);
            guard(); await verify(); guard();
            return createStyleBaseline(lease.value, { captureId: id, elementId, viewportVersion: lease.read.version, role: selected.role, name: selected.name, rectangle: selected.rectangle }, values);
        });
    }
    async release(original: AnnotationSourceScope, id: string): Promise<void> { const scope = this.#scope(original), lease = this.#lease(scope, id); await this.#remove(lease); scope.assertCurrent(); }
    dispose(): Promise<void> {
        if (this.#disposing)
            return this.#disposing;
        this.#disposed = true;
        this.#lifetime.abort();
        for (const lease of this.#leases.values())
            clearTimeout(lease.timer);
        this.#leases.clear();
        this.#bytes = 0;
        this.#disposing = (async () => { await Promise.allSettled([...this.#openings, ...this.#operations]); const results = await Promise.allSettled([...this.#pins].map(channel => this.#closeChannel(channel))), failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected'); if (failed.length)
            throw new AggregateError(failed.map(result => result.reason), '画面批注通道清理未确认。'); })();
        return this.#disposing;
    }
}
export function createWorkbenchAnnotationSource(options: SourceOptions): AnnotationSource { return new WorkbenchAnnotationSource(options); }
