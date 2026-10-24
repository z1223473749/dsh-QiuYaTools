/** Fixed Host read-only CDP source. No model-supplied code, page edits or Input methods. */
import { createHash, randomUUID } from 'node:crypto';
import { ComputerError } from './contract.ts';
import type { ComputerObservation, ComputerGeometry } from './contract.ts';
export interface AnnotationCDP {
    send<T = Record<string, unknown>>(method: string, params?: object, sessionId?: string, signal?: AbortSignal): Promise<T>;
    subscribe(listener: (event: {
        method: string;
        sessionId?: string;
        params?: Record<string, unknown>;
    }) => void): () => void;
}
export interface BrowserAnnotationSnapshot {
    observation: ComputerObservation;
    viewportVersion: string;
    navigationVersion: string;
    scrollVersion: string;
    documentVersion: string;
    elementHitTest: boolean;
}
export interface BrowserAnnotationElement {
    backendNodeId: number;
    frameId: string;
    point: Readonly<{
        x: number;
        y: number;
    }>;
    rectangle: Readonly<{
        x: number;
        y: number;
        width: number;
        height: number;
    }>;
    role: string;
    name: string;
}
export interface BrowserAnnotationView {
    snapshot(signal: AbortSignal, guard: () => void): Promise<BrowserAnnotationSnapshot>;
    hitTest(snapshot: BrowserAnnotationSnapshot, point: {
        x: number;
        y: number;
    }, signal: AbortSignal, guard: () => void): Promise<BrowserAnnotationElement>;
    elementCurrent(snapshot: BrowserAnnotationSnapshot, element: BrowserAnnotationElement, signal: AbortSignal, guard: () => void): Promise<boolean>;
    close(): Promise<void>;
}
/** Runs only in a Host-created isolated world; owns no DOM, timers or input capability. */
export function annotationWorldWatcher() {
    let scroll = 0, dom = 0, closed = false;
    const changed = () => { scroll++; }, observer = new MutationObserver(() => { dom++; });
    addEventListener('scroll', changed, { capture: true, passive: true });
    globalThis.visualViewport?.addEventListener('scroll', changed, { passive: true });
    globalThis.visualViewport?.addEventListener('resize', changed, { passive: true });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    return Object.freeze({ read() { return { scroll, dom, closed, x: scrollX, y: scrollY, width: innerWidth, height: innerHeight, dpr: devicePixelRatio }; }, close() { if (!closed) {
            closed = true;
            observer.disconnect();
            removeEventListener('scroll', changed, true);
            globalThis.visualViewport?.removeEventListener('scroll', changed);
            globalThis.visualViewport?.removeEventListener('resize', changed);
        } ; return { closed }; } });
}
/** Native geometry read in the same pristine isolated world, never a selector or executable client payload. */
export function annotationElementRectangle(this: Element) { if (this.nodeType !== 1 || this.ownerDocument !== document || !this.isConnected)
    return { connected: false }; const r = Element.prototype.getBoundingClientRect.call(this); return { connected: true, x: r.x, y: r.y, width: r.width, height: r.height }; }
const fail = () => new ComputerError('ANNOTATION_STALE', '网页已导航、滚动或变化，请重新截取批注。');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const number = (v: unknown, min: number, max: number): number => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    throw fail(); return v; };
const token = (v: unknown): string => { if (typeof v !== 'string' || !v || v.length > 4096 || /[\u0000-\u001f]/u.test(v))
    throw fail(); return v; };
interface Frame {
    id: string;
    loaderId: string;
    url: string;
}
interface Tree {
    frame: Frame;
    childFrames?: Tree[];
}
interface World {
    frame: Frame;
    contextId: number;
    retired: boolean;
}
interface Metrics {
    cssLayoutViewport: {
        pageX: number;
        pageY: number;
        clientWidth: number;
        clientHeight: number;
    };
    cssVisualViewport: {
        offsetX: number;
        offsetY: number;
        pageX: number;
        pageY: number;
        clientWidth: number;
        clientHeight: number;
        scale: number;
        zoom?: number;
    };
}
interface Facts {
    viewportVersion: string;
    navigationVersion: string;
    scrollVersion: string;
    documentVersion: string;
    geometry: ComputerGeometry;
    main: Frame;
    metrics: Metrics;
    revision: number;
}
function frames(tree: Tree): Frame[] { const values: Frame[] = []; const visit = (node: Tree, depth: number) => { if (depth > 8 || values.length >= 16 || !node?.frame)
    throw fail(); const f = node.frame; values.push({ id: token(f.id), loaderId: token(f.loaderId), url: token(f.url) }); if (node.childFrames && (!Array.isArray(node.childFrames) || node.childFrames.length > 16))
    throw fail(); for (const child of node.childFrames ?? [])
    visit(child, depth + 1); }; visit(tree, 0); if (new Set(values.map(v => v.id)).size !== values.length)
    throw fail(); return values; }
function jpegDimensions(data: string) { const bytes = Buffer.from(data, 'base64'); if (!data || data.length > 24 * 1024 * 1024 || bytes.toString('base64') !== data || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217)
    throw fail(); let p = 2; while (p + 4 < bytes.length) {
    if (bytes[p++] !== 255)
        continue;
    let m = bytes[p++]!;
    while (m === 255 && p < bytes.length)
        m = bytes[p++]!;
    if (m === 217 || m === 218)
        break;
    if (m === 1 || m >= 208 && m <= 215)
        continue;
    const n = bytes.readUInt16BE(p);
    if (n < 2 || p + n > bytes.length)
        break;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(m) && n >= 7) {
        const width = bytes.readUInt16BE(p + 5), height = bytes.readUInt16BE(p + 3);
        if (!width || !height || width > 16384 || height > 16384 || width * height > 40000000)
            throw fail();
        return { width, height };
    }
    ;
    p += n;
} ; throw fail(); }
/** Caller has already attached this exact own read session and must dispose it if construction fails. */
export async function createBrowserAnnotationView(options: {
    cdp: AnnotationCDP;
    sessionId: string;
    tabId: string;
    assertConnection(): void;
    permission(signal: AbortSignal): Promise<void>;
    signal: AbortSignal;
    guard(): void;
    onClosed(): void;
    runtimeRetired(): boolean;
}): Promise<BrowserAnnotationView> {
    const { cdp, sessionId, tabId } = options, group = 'qiuya-annotation-' + randomUUID(), worlds = new Map<string, World>(), lifetime = new AbortController();
    let disposed = false, invalid = false, disconnected = false, detached = false, revision = 0, closing: Promise<void> | undefined, lastFacts: Facts | undefined;
    const alive = (guard: () => void, signal: AbortSignal) => { signal.throwIfAborted(); lifetime.signal.throwIfAborted(); guard(); options.assertConnection(); if (disposed || invalid)
        throw fail(); };
    const send = async <T>(method: string, params: object, signal: AbortSignal, guard: () => void): Promise<T> => { alive(guard, signal); const value = await cdp.send<T>(method, params, sessionId, AbortSignal.any([signal, lifetime.signal])); alive(guard, signal); return value; };
    const slot = JSON.stringify(group), installWorld = `(()=>{if(Object.hasOwn(globalThis,${slot}))throw Error('duplicate annotation world');Object.defineProperty(globalThis,${slot},{value:(${annotationWorldWatcher.toString()})(),configurable:true});return {ready:true}})()`, readWorld = `globalThis[${slot}].read()`, closeWorld = `(()=>{if(!Object.hasOwn(globalThis,${slot}))return {closed:true,absent:true};const value=globalThis[${slot}].close();delete globalThis[${slot}];return value})()`;
    const unsubscribe = cdp.subscribe(event => {
        if (event.method === 'QiuYa.disconnected') {
            disconnected = true;
            invalid = true;
            lifetime.abort();
            unsubscribe();
            return;
        }
        if (event.method === 'Target.detachedFromTarget' && event.params?.sessionId === sessionId) {
            detached = true;
            invalid = true;
            return;
        }
        if (event.sessionId !== sessionId)
            return;
        if (event.method === 'Runtime.executionContextDestroyed') {
            for (const world of worlds.values())
                if (world.contextId === event.params?.executionContextId) {
                    world.retired = true;
                    invalid = true;
                }
        }
        if (event.method === 'Runtime.executionContextsCleared') {
            for (const world of worlds.values())
                world.retired = true;
            if (worlds.size)
                invalid = true;
        }
        if (['Page.frameNavigated', 'Page.navigatedWithinDocument', 'Page.frameStartedLoading', 'Page.frameAttached', 'Page.frameDetached', 'DOM.documentUpdated'].includes(event.method)) {
            revision++;
            if (worlds.size)
                invalid = true;
        }
    });
    const close = () => {
        if (closing)
            return closing;
        disposed = true;
        lifetime.abort();
        closing = (async () => {
            const failures: unknown[] = [];
            if (options.runtimeRetired()) {
                worlds.clear();
                options.onClosed();
                return;
            }
            if (disconnected)
                throw new ComputerError('ANNOTATION_CLEANUP_UNCONFIRMED', '只读通道断开，页面监听器清理尚未确认。');
            for (const world of worlds.values()) {
                if (world.retired)
                    continue;
                try {
                    const result = await cdp.send<{
                        result: {
                            value?: {
                                closed?: boolean;
                            };
                        };
                        exceptionDetails?: unknown;
                    }>('Runtime.evaluate', { expression: closeWorld, contextId: world.contextId, returnByValue: true, silent: true }, sessionId);
                    if (result.exceptionDetails || result.result.value?.closed !== true)
                        throw fail();
                    world.retired = true;
                }
                catch (error) {
                    if (!world.retired && !options.runtimeRetired())
                        failures.push(error);
                }
            }
            try {
                await cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }, sessionId);
            }
            catch (error) {
                if (!detached && !options.runtimeRetired())
                    failures.push(error);
            }
            if (!detached && !options.runtimeRetired())
                try {
                    await cdp.send('Target.detachFromTarget', { sessionId });
                }
                catch (error) {
                    if (!detached && !options.runtimeRetired())
                        failures.push(error);
                }
            if (failures.length)
                throw new AggregateError(failures, '只读批注通道清理尚未确认。');
            worlds.clear();
            options.onClosed();
        })().finally(unsubscribe);
        return closing;
    };
    const facts = async (signal: AbortSignal, guard: () => void): Promise<Facts> => {
        alive(guard, signal);
        await options.permission(signal);
        alive(guard, signal);
        const before = revision;
        const tree = await send<{
            frameTree: Tree;
        }>('Page.getFrameTree', {}, signal, guard), actualFrames = frames(tree.frameTree);
        if (actualFrames.length !== worlds.size || actualFrames.some(f => { const w = worlds.get(f.id); return !w || w.frame.loaderId !== f.loaderId || w.frame.url !== f.url; }))
            throw fail();
        const document = await send<{
            root: {
                backendNodeId: number;
                frameId?: string;
            };
        }>('DOM.getDocument', { depth: 0, pierce: false }, signal, guard), metrics = await send<Metrics>('Page.getLayoutMetrics', {}, signal, guard), h = await send<{
            currentIndex: number;
            entries: {
                id: number;
                url: string;
            }[];
        }>('Page.getNavigationHistory', {}, signal, guard);
        if (!Array.isArray(h.entries) || h.entries.length > 4096 || !Number.isInteger(h.currentIndex) || !h.entries[h.currentIndex])
            throw fail();
        const l = metrics.cssLayoutViewport, v = metrics.cssVisualViewport, geometry = { x: 0, y: 0, width: number(l?.clientWidth, 1, 16384), height: number(l?.clientHeight, 1, 16384), scale: 1 };
        const layout = { x: number(l.pageX, -1e8, 1e8), y: number(l.pageY, -1e8, 1e8), width: geometry.width, height: geometry.height }, visual = { x: number(v?.pageX, -1e8, 1e8), y: number(v?.pageY, -1e8, 1e8), offsetX: number(v?.offsetX, -1e8, 1e8), offsetY: number(v?.offsetY, -1e8, 1e8), width: number(v?.clientWidth, 1, 16384), height: number(v?.clientHeight, 1, 16384), scale: number(v?.scale, .1, 16), zoom: number(v.zoom ?? 1, .1, 16) }, states = [];
        for (const frame of actualFrames) {
            const world = worlds.get(frame.id)!, result = await send<{
                result: {
                    value?: Record<string, unknown>;
                };
                exceptionDetails?: unknown;
            }>('Runtime.evaluate', { expression: readWorld, contextId: world.contextId, returnByValue: true, silent: true }, signal, guard), value = result.result?.value;
            if (result.exceptionDetails || !value || value.closed !== false)
                throw fail();
            states.push({ id: frame.id, dom: number(value.dom, 0, Number.MAX_SAFE_INTEGER), scroll: number(value.scroll, 0, Number.MAX_SAFE_INTEGER), x: number(value.x, -1e8, 1e8), y: number(value.y, -1e8, 1e8), width: number(value.width, 1, 16384), height: number(value.height, 1, 16384), dpr: number(value.dpr, .1, 16) });
        }
        await options.permission(signal);
        alive(guard, signal);
        if (before !== revision)
            throw fail();
        const navigationVersion = hash({ frames: actualFrames, current: h.entries[h.currentIndex], index: h.currentIndex, revision }), scrollVersion = hash({ layout, visual, states: states.map(s => ({ id: s.id, scroll: s.scroll, x: s.x, y: s.y, width: s.width, height: s.height, dpr: s.dpr })) }), documentVersion = hash({ document: number(document.root?.backendNodeId, 1, Number.MAX_SAFE_INTEGER), states: states.map(s => ({ id: s.id, dom: s.dom })) }), viewportVersion = hash({ navigationVersion, scrollVersion, documentVersion, geometry });
        return { navigationVersion, scrollVersion, documentVersion, viewportVersion, geometry, main: actualFrames[0]!, metrics, revision };
    };
    try {
        options.guard();
        options.signal.throwIfAborted();
        options.assertConnection();
        await options.permission(options.signal);
        await send('Page.enable', {}, options.signal, options.guard);
        await send('DOM.enable', {}, options.signal, options.guard);
        await send('Runtime.enable', {}, options.signal, options.guard);
        const tree = await send<{
            frameTree: Tree;
        }>('Page.getFrameTree', {}, options.signal, options.guard), initial = frames(tree.frameTree);
        for (const frame of initial) {
            const created = await send<{
                executionContextId: number;
            }>('Page.createIsolatedWorld', { frameId: frame.id, worldName: group, grantUniveralAccess: false }, options.signal, options.guard), contextId = number(created.executionContextId, 1, Number.MAX_SAFE_INTEGER), world = { frame, contextId, retired: false };
            worlds.set(frame.id, world);
            const result = await send<{
                result: {
                    value?: {
                        ready?: boolean;
                    };
                };
                exceptionDetails?: unknown;
            }>('Runtime.evaluate', { expression: installWorld, contextId, returnByValue: true, silent: true }, options.signal, options.guard);
            if (result.exceptionDetails || result.result?.value?.ready !== true)
                throw fail();
        }
        const snapshot = async (signal: AbortSignal, guard: () => void): Promise<BrowserAnnotationSnapshot> => {
            const before = await facts(signal, guard), screenshot = await send<{
                data: string;
            }>('Page.captureScreenshot', { format: 'jpeg', quality: 65, fromSurface: true, captureBeyondViewport: false }, signal, guard), after = await facts(signal, guard);
            if (before.viewportVersion !== after.viewportVersion)
                throw fail();
            const size = jpegDimensions(screenshot.data);
            lastFacts = after;
            return { observation: { targetId: tabId, frameId: 'annotation-' + randomUUID(), imageBase64: screenshot.data, mediaType: 'image/jpeg', ...size, geometry: after.geometry, elements: '' }, viewportVersion: after.viewportVersion, navigationVersion: after.navigationVersion, scrollVersion: after.scrollVersion, documentVersion: after.documentVersion, elementHitTest: after.metrics.cssVisualViewport.scale === 1 && after.metrics.cssVisualViewport.offsetX === 0 && after.metrics.cssVisualViewport.offsetY === 0 };
        };
        const element = async (snap: BrowserAnnotationSnapshot, point: {
            x: number;
            y: number;
        }, signal: AbortSignal, guard: () => void): Promise<BrowserAnnotationElement> => {
            const current = await facts(signal, guard);
            if (!snap.elementHitTest || current.viewportVersion !== snap.viewportVersion || !lastFacts || lastFacts.viewportVersion !== snap.viewportVersion)
                throw fail();
            const o = snap.observation;
            if (!(point.x >= 0 && point.x < o.width && point.y >= 0 && point.y < o.height))
                throw fail();
            const x = point.x / o.width * current.geometry.width, y = point.y / o.height * current.geometry.height, hit = await send<{
                backendNodeId: number;
                frameId: string;
            }>('DOM.getNodeForLocation', { x: Math.floor(x), y: Math.floor(y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false }, signal, guard);
            if (hit.frameId !== current.main.id)
                throw new ComputerError('ANNOTATION_ELEMENT_UNAVAILABLE', '此嵌入网页暂不支持元素定位，请使用框选。');
            const node = number(hit.backendNodeId, 1, Number.MAX_SAFE_INTEGER), world = worlds.get(current.main.id)!, remote = await send<{
                object: {
                    objectId?: string;
                };
            }>('DOM.resolveNode', { backendNodeId: node, executionContextId: world.contextId, objectGroup: group }, signal, guard), objectId = token(remote.object?.objectId);
            let rectangle: {
                x: number;
                y: number;
                width: number;
                height: number;
            };
            try {
                const read = await send<{
                    result: {
                        value?: Record<string, unknown>;
                    };
                    exceptionDetails?: unknown;
                }>('Runtime.callFunctionOn', { objectId, functionDeclaration: annotationElementRectangle.toString(), returnByValue: true, silent: true }, signal, guard), box = read.result?.value;
                if (read.exceptionDetails || !box || box.connected !== true)
                    throw fail();
                const left = Math.max(0, number(box.x, -1e8, 1e8)), top = Math.max(0, number(box.y, -1e8, 1e8)), right = Math.min(current.geometry.width, number(box.x, -1e8, 1e8) + number(box.width, 0, 1e8)), bottom = Math.min(current.geometry.height, number(box.y, -1e8, 1e8) + number(box.height, 0, 1e8));
                if (right <= left || bottom <= top || x < left || x > right || y < top || y > bottom)
                    throw fail();
                rectangle = { x: left / current.geometry.width * o.width, y: top / current.geometry.height * o.height, width: (right - left) / current.geometry.width * o.width, height: (bottom - top) / current.geometry.height * o.height };
            }
            finally {
                await cdp.send('Runtime.releaseObject', { objectId }, sessionId).catch(error => { invalid = true; throw error; });
            }
            const ax = await send<{
                nodes: {
                    backendDOMNodeId?: number;
                    ignored?: boolean;
                    role?: {
                        value?: unknown;
                    };
                    name?: {
                        value?: unknown;
                    };
                }[];
            }>('Accessibility.getPartialAXTree', { backendNodeId: node, fetchRelatives: false }, signal, guard);
            if (!Array.isArray(ax.nodes) || ax.nodes.length > 16)
                throw fail();
            const selected = ax.nodes.find(n => n.backendDOMNodeId === node && !n.ignored), label = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').slice(0, max) : '';
            const after = await facts(signal, guard);
            if (after.viewportVersion !== current.viewportVersion)
                throw fail();
            return Object.freeze({ backendNodeId: node, frameId: hit.frameId, point: Object.freeze({ ...point }), rectangle: Object.freeze(rectangle), role: label(selected?.role?.value, 128), name: label(selected?.name?.value, 256) });
        };
        return { snapshot, hitTest: element, async elementCurrent(snap, saved, signal, guard) { const actual = await element(snap, saved.point, signal, guard); return actual.backendNodeId === saved.backendNodeId && actual.frameId === saved.frameId && JSON.stringify(actual.rectangle) === JSON.stringify(saved.rectangle) && actual.role === saved.role && actual.name === saved.name; }, close };
    }
    catch (failure) {
        try {
            await close();
        }
        catch (cleanup) {
            throw new AggregateError([failure, cleanup], '只读批注初始化与清理未确认。');
        }
        ;
        throw failure;
    }
}
