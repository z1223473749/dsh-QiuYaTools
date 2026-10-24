import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const built = await build({ entryPoints: ['src/features/computer-use/browser-annotation.ts'], bundle: true, write: false, platform: 'node', format: 'esm' }), modulePath = join(await mkdtemp(join(tmpdir(), 'qiuya-h4-browser-test-')), 'runtime.mjs');
await writeFile(modulePath, built.outputFiles[0].text);
const api = await import(pathToFileURL(modulePath).href), tick = () => new Promise(r => setImmediate(r)), deferred = () => { let resolve; return { promise: new Promise(y => resolve = y), resolve: v => resolve(v) }; };
// Protocol JPEG dimensions fixture. This is not an image-decoding or pixel visual acceptance result.
const jpeg = Buffer.from([255, 216, 255, 192, 0, 8, 8, 0, 100, 0, 100, 0, 255, 217]).toString('base64');
function fixture(t) {
    const calls = [], listeners = new Set(), contexts = new Map(), remote = new Map(), state = { frames: [{ id: 'main', loaderId: 'loader-1', url: 'https://synthetic.test/page' }], node: 501, rect: { x: 10, y: 10, width: 40, height: 30 }, permission: true, revision: 0, root: 100, detaches: 0, closed: 0, retired: false, before: null, after: null, setupError: false, closeError: false, objectReleaseError: false, width: 100, height: 100, scale: 1, hitFrame: 'main' }, controller = new AbortController();
    let contextSequence = 0;
    const cdp = { subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, async send(method, params = {}, sessionId, signal) {
            calls.push({ method, params, sessionId });
            signal?.throwIfAborted();
            assert.equal(method.startsWith('Input.'), false, 'Read-only annotation must never issue input');
            await state.before?.(method, params);
            signal?.throwIfAborted();
            let value;
            if (['Page.enable', 'DOM.enable', 'Runtime.enable'].includes(method))
                value = {};
            else if (method === 'Page.getFrameTree')
                value = { frameTree: { frame: structuredClone(state.frames[0]), ...(state.frames.length > 1 ? { childFrames: state.frames.slice(1).map(frame => ({ frame: structuredClone(frame) })) } : {}) } };
            else if (method === 'Page.createIsolatedWorld') {
                assert.equal(params.grantUniveralAccess, false);
                const dom = new JSDOM('<!doctype html><button aria-label="Synthetic confirm">Confirm</button>', { url: state.frames.find(f => f.id === params.frameId).url, runScripts: 'outside-only' });
                dom.window.Element.prototype.getBoundingClientRect = function () { return { ...state.rect }; };
                Object.defineProperty(dom.window, 'innerWidth', { value: 100, configurable: true });
                Object.defineProperty(dom.window, 'innerHeight', { value: 100, configurable: true });
                contexts.set(++contextSequence, { dom, frame: params.frameId });
                value = { executionContextId: contextSequence };
            }
            else if (method === 'Runtime.evaluate') {
                const context = contexts.get(params.contextId);
                assert(context);
                if (params.expression.includes('delete globalThis') && state.closeError)
                    throw Error('cleanup ACK lost');
                const result = context.dom.window.eval(params.expression);
                if (params.expression.includes('duplicate annotation world') && state.setupError)
                    throw Error('initialization ACK lost after actual JS executed');
                value = { result: { value: JSON.parse(JSON.stringify(result)) } };
            }
            else if (method === 'DOM.getDocument')
                value = { root: { backendNodeId: state.root } };
            else if (method === 'Page.getLayoutMetrics')
                value = { cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: state.width, clientHeight: state.height }, cssVisualViewport: { pageX: 0, pageY: 0, offsetX: 0, offsetY: 0, clientWidth: state.width, clientHeight: state.height, scale: state.scale, zoom: 1 } };
            else if (method === 'Page.getNavigationHistory')
                value = { currentIndex: 0, entries: [{ id: 1, url: state.frames[0].url }] };
            else if (method === 'Page.captureScreenshot')
                value = { data: jpeg };
            else if (method === 'DOM.getNodeForLocation')
                value = { backendNodeId: state.node, frameId: state.hitFrame };
            else if (method === 'DOM.resolveNode') {
                const context = [...contexts.values()][0], objectId = 'node-' + params.backendNodeId;
                remote.set(objectId, { context, node: context.dom.window.document.querySelector('button') });
                value = { object: { objectId } };
            }
            else if (method === 'Runtime.callFunctionOn') {
                const object = remote.get(params.objectId);
                assert(object);
                const result = object.context.dom.window.eval('(' + params.functionDeclaration + ')').call(object.node);
                value = { result: { value: JSON.parse(JSON.stringify(result)) } };
            }
            else if (method === 'Runtime.releaseObject') {
                if (state.objectReleaseError)
                    throw Error('object release ACK lost');
                remote.delete(params.objectId);
                value = {};
            }
            else if (method === 'Runtime.releaseObjectGroup') {
                remote.clear();
                value = {};
            }
            else if (method === 'Accessibility.getPartialAXTree')
                value = { nodes: [{ backendDOMNodeId: state.node, role: { value: 'button' }, name: { value: 'Synthetic confirm' }, value: { value: 'PRIVATE_FIELD_VALUE' } }] };
            else if (method === 'Target.detachFromTarget') {
                assert.equal(params.sessionId, 'own-read-session');
                assert.equal(sessionId, undefined);
                state.detaches++;
                value = {};
            }
            else
                throw Error('Unexpected annotation CDP method ' + method);
            await state.after?.(method, params);
            return value;
        } };
    const guard = () => controller.signal.throwIfAborted(), options = { cdp, sessionId: 'own-read-session', tabId: 'owned-tab', signal: controller.signal, guard, assertConnection() { if (state.disconnected)
            throw Error('connection changed'); }, async permission(signal) { signal.throwIfAborted(); if (!state.permission)
            throw Error('site revoked'); }, onClosed() { state.closed++; }, runtimeRetired: () => state.retired };
    t.after(() => { for (const c of contexts.values())
        c.dom.window.close(); });
    return { state, calls, contexts, remote, listeners, controller, options, emit(event) { for (const fn of [...listeners])
            fn(event); }, async open() { return api.createBrowserAnnotationView(options); }, scope: { signal: controller.signal, guard } };
}
const sample = (v, f) => v.snapshot(f.scope.signal, f.scope.guard), hit = (v, f, s) => v.hitTest(s, { x: 20, y: 20 }, f.scope.signal, f.scope.guard);
test('actual fixed watcher executes in real isolated JSDOM realm, reads versions without changing DOM, and removes itself once', async (t) => { const f = fixture(t), v = await f.open(), dom = [...f.contexts.values()][0].dom, html = dom.window.document.documentElement.outerHTML; try {
    const a = await sample(v, f), b = await sample(v, f);
    assert.notEqual(a.observation.frameId, b.observation.frameId);
    assert.equal(a.viewportVersion, b.viewportVersion);
    assert.equal(a.observation.elements, '');
    assert.equal(a.elementHitTest, true);
    assert.equal(dom.window.document.documentElement.outerHTML, html);
    assert.equal(f.calls.some(c => c.method.startsWith('Input.')), false);
    const read = f.calls.find(c => c.method === 'Runtime.evaluate' && c.params.expression.includes('.read()'));
    assert(read);
    assert(f.calls.every(c => c.method === 'Target.detachFromTarget' || c.sessionId === 'own-read-session'));
}
finally {
    await v.close();
} ; assert.equal(f.state.detaches, 1); assert.equal(f.state.closed, 1); assert.equal(f.listeners.size, 0); assert.equal(Object.keys(dom.window).some(k => k.startsWith('qiuya-annotation-')), false); await v.close(); assert.equal(f.state.detaches, 1); });
test('real scroll callback catches scroll-and-return even when current offset and JPEG bytes match', async (t) => { const f = fixture(t), v = await f.open(); try {
    const a = await sample(v, f), window = [...f.contexts.values()][0].dom.window;
    window.dispatchEvent(new window.Event('scroll'));
    window.dispatchEvent(new window.Event('scroll'));
    const b = await sample(v, f);
    assert.equal(a.observation.imageBase64, b.observation.imageBase64);
    assert.notEqual(a.scrollVersion, b.scrollVersion);
    assert.notEqual(a.viewportVersion, b.viewportVersion);
}
finally {
    await v.close();
} });
test('real MutationObserver catches same-looking node replacement even with equal screenshot bytes', async (t) => { const f = fixture(t), v = await f.open(); try {
    const a = await sample(v, f), doc = [...f.contexts.values()][0].dom.window.document, old = doc.querySelector('button');
    old.replaceWith(old.cloneNode(true));
    await tick();
    const b = await sample(v, f);
    assert.equal(a.observation.imageBase64, b.observation.imageBase64);
    assert.notEqual(a.documentVersion, b.documentVersion);
    await assert.rejects(hit(v, f, a));
}
finally {
    await v.close();
} });
for (const method of ['Page.frameNavigated', 'Page.navigatedWithinDocument', 'Page.frameStartedLoading', 'Page.frameAttached', 'Page.frameDetached', 'DOM.documentUpdated'])
    test('actual own-session ' + method + ' invalidates without another screenshot', async (t) => { const f = fixture(t), v = await f.open(); try {
        await sample(v, f);
        const n = f.calls.filter(c => c.method === 'Page.captureScreenshot').length;
        f.emit({ method, sessionId: 'own-read-session', params: {} });
        await assert.rejects(sample(v, f));
        assert.equal(f.calls.filter(c => c.method === 'Page.captureScreenshot').length, n);
    }
    finally {
        await v.close();
    } });
test('foreign flattened session events do not alter this trusted capture version', async (t) => { const f = fixture(t), v = await f.open(); try {
    const a = await sample(v, f);
    f.emit({ method: 'Page.frameNavigated', sessionId: 'foreign-session' });
    const b = await sample(v, f);
    assert.equal(a.viewportVersion, b.viewportVersion);
}
finally {
    await v.close();
} });
test('a real DOM mutation during screenshot makes the one capture fail; it is never silently replayed', async (t) => { const f = fixture(t), v = await f.open(); try {
    f.state.after = async (method) => { if (method === 'Page.captureScreenshot') {
        [...f.contexts.values()][0].dom.window.document.querySelector('button').textContent = 'Changed';
        await tick();
    } };
    await assert.rejects(sample(v, f));
    assert.equal(f.calls.filter(c => c.method === 'Page.captureScreenshot').length, 1);
}
finally {
    await v.close();
} });
test('each child frame has a distinct isolated read realm and actual scroll counter in the opaque version', async (t) => { const f = fixture(t); f.state.frames.push({ id: 'child', loaderId: 'child-loader', url: 'https://embedded.synthetic.test/' }); const v = await f.open(); try {
    const a = await sample(v, f);
    const child = [...f.contexts.values()].find(c => c.frame === 'child');
    child.dom.window.dispatchEvent(new child.dom.window.Event('scroll'));
    const b = await sample(v, f);
    assert.notEqual(a.scrollVersion, b.scrollVersion);
    assert.equal(f.contexts.size, 2);
}
finally {
    await v.close();
} ; assert.equal(f.state.detaches, 1); });
test('frame forest above16 bound refuses without installing watchers or inputs', async (t) => { const f = fixture(t); f.state.frames = Array.from({ length: 17 }, (_, i) => ({ id: 'frame' + i, loaderId: 'loader' + i, url: 'https://synthetic.test/' })); await assert.rejects(f.open()); assert.equal(f.contexts.size, 0); assert.equal(f.state.detaches, 1); assert.equal(f.state.closed, 1); });
test('read-only hitTest uses actual isolated native Element geometry and only a partial AX label, never AX value', async (t) => { const f = fixture(t), v = await f.open(); try {
    const s = await sample(v, f), e = await hit(v, f, s);
    assert.equal(e.backendNodeId, 501);
    assert.deepEqual(e.rectangle, { x: 10, y: 10, width: 40, height: 30 });
    assert.equal(e.name, 'Synthetic confirm');
    assert.equal(JSON.stringify(e).includes('PRIVATE_FIELD_VALUE'), false);
    assert.equal(f.remote.size, 0);
    assert.equal(f.calls.some(c => c.method === 'Accessibility.getFullAXTree'), false);
    assert.equal(f.calls.some(c => c.params.expression?.includes('.click(')), false);
}
finally {
    await v.close();
} });
test('unchanged selected coordinates cannot authenticate a replacement backend node with equal pixels/name', async (t) => { const f = fixture(t), v = await f.open(); try {
    const s = await sample(v, f), e = await hit(v, f, s);
    f.state.node = 502;
    assert.equal(await v.elementCurrent(s, e, f.scope.signal, f.scope.guard), false);
}
finally {
    await v.close();
} });
test('cross-frame hitTest is refused and keeps region capture available without guessing a frame transform', async (t) => { const f = fixture(t), v = await f.open(); try {
    const s = await sample(v, f);
    f.state.hitFrame = 'embedded';
    await assert.rejects(hit(v, f, s), { code: 'ANNOTATION_ELEMENT_UNAVAILABLE' });
    assert.equal(f.calls.filter(c => c.method === 'DOM.resolveNode').length, 0);
}
finally {
    await v.close();
} });
test('pinch visual viewport remains capturable but cannot silently map image coordinates into a DOM element', async (t) => { const f = fixture(t); f.state.scale = 2; const v = await f.open(); try {
    const s = await sample(v, f);
    assert.equal(s.elementHitTest, false);
    await assert.rejects(hit(v, f, s));
    assert.equal(f.calls.filter(c => c.method === 'DOM.getNodeForLocation').length, 0);
}
finally {
    await v.close();
} });
test('mid-await owner abort prevents screenshot and later completion cannot continue reading', async (t) => { const f = fixture(t), v = await f.open(), held = deferred(), entered = deferred(); try {
    f.state.before = async (method) => { if (method === 'Page.getLayoutMetrics') {
        entered.resolve();
        await held.promise;
    } };
    const pending = sample(v, f);
    await entered.promise;
    f.controller.abort();
    held.resolve();
    await assert.rejects(pending);
    assert.equal(f.calls.some(c => c.method === 'Page.captureScreenshot'), false);
}
finally {
    await v.close();
} });
test('permission revoked after screenshot cannot publish the image and is not retried', async (t) => { const f = fixture(t), v = await f.open(); try {
    f.state.after = async (method) => { if (method === 'Page.captureScreenshot')
        f.state.permission = false; };
    await assert.rejects(sample(v, f));
    assert.equal(f.calls.filter(c => c.method === 'Page.captureScreenshot').length, 1);
}
finally {
    await v.close();
} });
test('lost initialization ACK after actual watcher install cleans by known world slot instead of leaking a missing objectId', async (t) => { const f = fixture(t); f.state.setupError = true; await assert.rejects(f.open(), /initialization ACK lost/); const window = [...f.contexts.values()][0].dom.window; assert.equal(Object.getOwnPropertyNames(window).some(k => k.startsWith('qiuya-annotation-')), false); assert.equal(f.state.closed, 1); assert.equal(f.state.detaches, 1); assert.equal(f.listeners.size, 0); });
test('lost cleanup ACK is retained and repeated close awaits the same failed attempt without replay', async (t) => { const f = fixture(t), v = await f.open(); f.state.closeError = true; await assert.rejects(v.close(), AggregateError); const n = f.calls.filter(c => c.method === 'Runtime.evaluate' && c.params.expression.includes('delete globalThis')).length; await assert.rejects(v.close(), AggregateError); assert.equal(n, 1); assert.equal(f.calls.filter(c => c.method === 'Runtime.evaluate' && c.params.expression.includes('delete globalThis')).length, n); assert.equal(f.state.closed, 0); assert.equal(f.state.detaches, 1); });
test('actual execution-context-destroyed receipt invalidates and allows disposal without pretending it can call the retired realm', async (t) => { const f = fixture(t), v = await f.open(); f.emit({ method: 'Runtime.executionContextDestroyed', sessionId: 'own-read-session', params: { executionContextId: 1 } }); await assert.rejects(sample(v, f)); await v.close(); assert.equal(f.calls.filter(c => c.method === 'Runtime.evaluate' && c.params.expression.includes('delete globalThis')).length, 0); assert.equal(f.state.closed, 1); });
test('socket disconnection alone does not prove persistent page observers retired', async (t) => { const f = fixture(t), v = await f.open(); f.emit({ method: 'QiuYa.disconnected' }); await assert.rejects(sample(v, f)); await assert.rejects(v.close(), { code: 'ANNOTATION_CLEANUP_UNCONFIRMED' }); assert.equal(f.state.closed, 0); assert.equal(f.state.detaches, 0); });
test('confirmed exact own browser runtime retirement proves its realm gone without a new CDP command', async (t) => { const f = fixture(t), v = await f.open(); f.state.retired = true; const n = f.calls.length; await v.close(); assert.equal(f.calls.length, n); assert.equal(f.state.closed, 1); });
const computedFixtureStyles = { 'font-family':'Arial', 'font-size':'18px', 'font-weight':'500', 'line-height':'24px', 'letter-spacing':'1px', color:'rgb(10, 20, 30)', 'background-color':'rgb(240, 240, 240)', 'padding-top':'2px', 'padding-right':'3px', 'padding-bottom':'4px', 'padding-left':'5px' };
async function styled(t) { const f=fixture(t),v=await f.open(),dom=[...f.contexts.values()][0].dom;for(const [k,value]of Object.entries(computedFixtureStyles))dom.window.document.querySelector('button').style.setProperty(k,value);await tick();const s=await sample(v,f),e=await hit(v,f,s);return{f,v,dom,s,e}; }
test('ANN02 actual fixed native computed getter reads only eleven properties from exact selected object; target DOM and CSS stay byte identical',async(t)=>{const{f,v,dom,s,e}=await styled(t);try{const html=dom.window.document.documentElement.outerHTML,values=await v.computedStyles(s,e,f.scope.signal,f.scope.guard);assert.equal(values['font-size'],'18px');assert.equal(values.color,'rgb(10, 20, 30)');assert.equal(Object.keys(values).length,11);assert.equal(dom.window.document.documentElement.outerHTML,html);assert.equal(f.calls.some(c=>c.method.startsWith('Input.')),false);assert.equal(JSON.stringify(values).includes('PRIVATE_FIELD_VALUE'),false);assert.equal(f.remote.size,0);assert(f.calls.some(c=>c.method==='Runtime.callFunctionOn'&&c.params.functionDeclaration.includes('getComputedStyle')));}finally{await v.close()}});
for(const changed of ['backend','geometry','scroll','permission','owner'])test('ANN02 '+changed+' invalidation refuses before old computed baseline can be returned',async(t)=>{const{f,v,s,e,dom}=await styled(t);try{if(changed==='backend')f.state.node++;if(changed==='geometry')f.state.rect.x++;if(changed==='scroll')dom.window.dispatchEvent(new dom.window.Event('scroll'));if(changed==='permission')f.state.permission=false;if(changed==='owner')f.controller.abort();const old=f.calls.length;await assert.rejects(v.computedStyles(s,e,f.scope.signal,f.scope.guard));assert.equal(f.calls.slice(old).some(c=>c.method==='Runtime.callFunctionOn'&&c.params.functionDeclaration.includes('getComputedStyle')),false);}finally{await v.close()}});
test('ANN02 computed getter delayed across actual scroll-return is rejected and exact remote object is released',async(t)=>{const{f,v,s,e,dom}=await styled(t);try{let read=false;f.state.after=(method,params)=>{if(!read&&method==='Runtime.callFunctionOn'&&params.functionDeclaration.includes('getComputedStyle')){read=true;dom.window.dispatchEvent(new dom.window.Event('scroll'));dom.window.dispatchEvent(new dom.window.Event('scroll'));}};await assert.rejects(v.computedStyles(s,e,f.scope.signal,f.scope.guard));assert.equal(read,true);assert.equal(f.remote.size,0);}finally{await v.close()}});
test('ANN02 unexpected computed URL and extra CSS cannot cross finite projection',async(t)=>{const{f,v,s,e,dom}=await styled(t);try{dom.window.getComputedStyle=()=>({getPropertyValue:()=> 'url(https://secret.invalid/)'});await assert.rejects(v.computedStyles(s,e,f.scope.signal,f.scope.guard));assert.equal(f.remote.size,0);}finally{await v.close()}});
