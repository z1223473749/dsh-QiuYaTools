import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const rootPath = fileURLToPath(new URL('../', import.meta.url)), source = (await build({ stdin: { contents: "export * from './src/features/workbench/Views.tsx';export * from './src/features/workbench/client.tsx';export * from './src/features/workbench/client-api.ts';export * from './src/features/workbench/resources.ts';export * from './src/features/workbench/preview-model.ts'", resolveDir: rootPath }, bundle: true, write: false, platform: 'node', format: 'esm', external: ['react'] })).outputFiles[0].text;
// Resolve real React through an ordinary temporary source module; no Harness process/browser is started.
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp('/private/tmp/qiuya-workbench-react-unit-');
await symlink(join(rootPath, 'node_modules'), join(dir, 'node_modules'), 'dir');
await writeFile(join(dir, 'runtime.mjs'), source);
const ui = await import(pathToFileURL(join(dir, 'runtime.mjs')).href);
const defer = () => { let resolve, reject; const promise = new Promise((y, n) => { resolve = y; reject = n; }); return { promise, resolve, reject }; }, tick = () => new Promise(r => setImmediate(r));
const target = (chat = 'chat-a', extra = {}) => ({ chatSessionId: chat, environmentId: randomUUID(), workbenchTabId: randomUUID(), kind: 'browser', targetId: 'target-' + chat, appId: 'browser:' + chat, epoch: 1, title: 'Synthetic site', origin: 'https://site.test', state: 'ready', ...extra });
const frame = (t, viewOnly = true) => ({ target: t, viewOnly, observation: { targetId: t.targetId, frameId: randomUUID(), imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 100, height: 100, elements: '', geometry: { x: 0, y: 0, width: 100, height: 100, scale: 1 } } });
async function mount(Component, props) { const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://synthetic.test/' }), old = {}; for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class {
        constructor(fn) { this.fn = fn; }
        observe() { this.fn(); }
        disconnect() { }
    } })) {
    old[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
} dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() { return {}; } }; }; const root = createRoot(dom.window.document.getElementById('root')); await act(async () => { root.render(React.createElement(Component, props)); await tick(); }); return { dom, root, async render(next) { await act(async () => { root.render(React.createElement(Component, next)); await tick(); }); }, async cleanup() { await act(async () => root.unmount()); dom.window.close(); for (const [k, v] of Object.entries(old)) {
        if (v)
            Object.defineProperty(globalThis, k, v);
        else
            delete globalThis[k];
    } } }; }
function pointer(dom, element, type, x, y) { const event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }); Object.defineProperty(event, 'pointerId', { value: 7 }); element.dispatchEvent(event); }
import { createHash } from 'node:crypto';
const imageSHA = createHash('sha256').update(Buffer.from('/9j/2Q==', 'base64')).digest('hex');
function context() { const t = target('chat-a', { state: 'humanControl' }), address = 'dsh-resource://qiuya-workbench/chat-a/' + t.workbenchTabId, calls = [], signal = new AbortController(), info = { tab: { id: 'tab-a', visible: true, signal: signal.signal, navigation: { address, revision: 1 }, actions: { bindCommands() { return () => { }; }, close() { calls.push(['hide']); }, openResource() { } } }, panel: { id: 'panel-a' } }, capture = { captureId: randomUUID(), capture: { anchor: { chatSessionId: t.chatSessionId, environmentId: t.environmentId, workbenchTabId: t.workbenchTabId, targetId: t.targetId, appId: t.appId, kind: t.kind, epoch: t.epoch, frameId: 'actual-frozen', width: 100, height: 100, imageSHA256: imageSHA, viewportVersion: 'actual-document-1', geometry: { x: 0, y: 0, width: 100, height: 100, scale: 1 } }, imageBase64: '/9j/2Q==', mediaType: 'image/jpeg' }, elementHitTest: true, expiresAt: Date.now() + 60000 }, state = { captureBefore: null, check: true }, annotations = { async capture(value, signal) { calls.push(['capture', value, signal]); await state.captureBefore?.(); return capture; }, async check(chat, id, ids, signal) { calls.push(['check', chat, id, ids, signal]); return state.check ? { valid: true, captureId: id, anchor: capture.capture.anchor, checkedAgainst: { frameId: randomUUID(), imageSHA256: imageSHA, viewportVersion: 'actual-document-1' } } : { valid: false, captureId: id, reason: 'scroll' }; }, async release(...args) { calls.push(['release', ...args]); }, forget() { calls.push(['forget']); }, async hitTest(chat, id, point) { calls.push(['hitTest', chat, id, point]); return { captureId: id, elementId: randomUUID(), viewportVersion: 'actual-document-1', role: 'button', name: 'Synthetic', rectangle: { x: 10, y: 10, width: 20, height: 20 } }; } }, api = { async preview() { calls.push(['preview']); return frame(t, false); }, async navigation() { return { canGoBack: true, canGoForward: false, url: 'https://site.test/page' }; }, async humanAct() { calls.push(['act']); }, async control() { calls.push(['control']); } }, binding = { sessionId: 'chat-a', session: { sessionId: 'chat-a', beginSubmission() { calls.push(['begin']); throw Error('No submission in edit test'); }, prompt() { calls.push(['prompt']); throw Error('No submission in edit test'); } }, eventSource: { subscribe() { return () => { }; }, getSnapshot() { return { entries: [] }; } } }, props = { sessionId: 'chat-a', api, annotations, binding: () => binding, current: () => true, useTabInfo: () => info, useResource: () => ({ status: 'live', value: { target: t } }), open() { }, refresh() { }, float() { }, dock() { }, split() { } }; return { t, calls, capture, info, state, signal, props }; }
const button = (m, label) => [...m.dom.window.document.querySelectorAll('button')].find(e => e.textContent === label);
async function open(f, m) { await act(async () => { button(m, '批注画面').click(); await tick(); }); assert(m.dom.window.document.querySelector('[data-qyt-annotation-capture]')); const scroll = m.dom.window.document.querySelector('[aria-label="批注编辑区"]'); assert(scroll); assert.equal(scroll.getAttribute('role'),'region'); assert.equal(scroll.tabIndex,0); assert.equal(m.dom.window.getComputedStyle(scroll).overflow,'auto'); }
test('real workbench entry replaces actual live human input surface with editor and disables device controls while drawing zero input', async () => { const f = context(), m = await mount(ui.WorkbenchTab, f.props); try {
    assert(m.dom.window.document.querySelector('.qyt-workbench-image-stage'));
    await open(f, m);
    assert.equal(m.dom.window.document.querySelector('.qyt-workbench-image-stage'), null);
    for (const name of ['暂停', '接管', '继续', '停止', '新网页', '退出专用浏览器', '关闭网页'])
        assert.equal(button(m, name).disabled, true, name);
    assert.equal(m.dom.window.document.querySelector('[aria-label="当前网页地址"]').disabled, true);
    const actions = m.dom.window.document.querySelector('.qyt-workbench-actions'), menu = actions.querySelector('details');
    assert(actions.querySelector('button').disabled);
    assert.equal(menu.querySelector('summary').getAttribute('aria-label'), '更多工作台操作');
    await act(async () => { menu.querySelector('summary').click(); });
    assert.equal(menu.open, true);
    for (const name of ['弹出面板', '收回侧栏', '分栏查看', '隐藏视图']) assert.equal(button(m, name).disabled, false);
    const svg = m.dom.window.document.querySelector('svg');
    await act(async () => { pointer(m.dom, svg, 'pointerdown', 60, 10); pointer(m.dom, svg, 'pointermove', 120, 80); pointer(m.dom, svg, 'pointerup', 120, 80); });
    assert.equal(m.dom.window.document.querySelectorAll('svg rect').length, 1);
    assert.equal(f.calls.some(c => ['act', 'control', 'prompt', 'begin'].includes(c[0])), false);
}
finally {
    await m.cleanup();
} ; assert.equal(f.calls.filter(c => c[0] === 'release').length, 1); });
test('cancel uses one owner source release and restores live preview without changing Agent target or sending prompt', async () => { const f = context(), m = await mount(ui.WorkbenchTab, f.props); try {
    await open(f, m);
    await act(async () => { button(m, '取消').click(); await tick(); });
    assert.equal(m.dom.window.document.querySelector('[data-qyt-annotation-capture]'), null);
    assert(m.dom.window.document.querySelector('.qyt-workbench-image-stage'));
    assert.equal(f.calls.filter(c => c[0] === 'release').length, 1);
    assert.equal(f.calls.some(c => ['act', 'control', 'prompt', 'begin'].includes(c[0])), false);
}
finally {
    await m.cleanup();
} });
test('real tab navigation revision disposes hidden editor lease and allows a new capture instead of retaining old ref forever', async () => { const f = context(), m = await mount(ui.WorkbenchTab, f.props); try {
    await open(f, m);
    f.info.tab.navigation = { ...f.info.tab.navigation, revision: 2 };
    await m.render({ ...f.props });
    assert.equal(f.calls.filter(c => c[0] === 'release').length, 1);
    assert.equal(m.dom.window.document.querySelector('[data-qyt-annotation-capture]'), null);
    await open(f, m);
    assert.equal(f.calls.filter(c => c[0] === 'capture').length, 2);
    assert.equal(f.calls.some(c => ['act', 'control', 'prompt'].includes(c[0])), false);
}
finally {
    await m.cleanup();
} });
test('unmount while capture is pending aborts exact request; late capture is released and never mounts or submits', async () => { const f = context(), held = defer(); f.state.captureBefore = () => held.promise; const m = await mount(ui.WorkbenchTab, f.props); await act(async () => { button(m, '批注画面').click(); await tick(); }); const request = f.calls.find(c => c[0] === 'capture'); await m.cleanup(); assert.equal(request[2].aborted, true); held.resolve(); await tick(); await tick(); assert.equal(f.calls.filter(c => c[0] === 'release').length, 1); assert.equal(f.calls.some(c => ['act', 'control', 'prompt', 'begin'].includes(c[0])), false); });
test('installed public SDK contribution obtains exact active chat SessionBinding through real sessions service and refuses foreign chat', async () => { const m = await mount(() => null, {}), calls = [], binding = { sessionId: 'chat-a' }, slots = [], sessions = { binding(chat) { calls.push(chat); return binding; } }, ctx = { get(name) { return name === 'sessions' ? sessions : { rpc: { call() { throw Error('No startup RPC'); } } }; }, resources: { register() { return () => { }; } }, sidebarRightTabs: { register() { return () => { }; } }, slots: { inject(name, cb) { return cb(); }, register(definition, component) { slots.push({ definition, component }); return () => { }; } }, sidebarRight: { mounted: { getSnapshot() { return 'chat-a'; } } } }, dispose = ui.installWorkbenchClient(ctx, {}); try {
    const face = slots.find(s => s.definition.name === 'sidebar.right.pane.tab').definition.inject('chat-a');
    assert.equal(face.binding('chat-a'), binding);
    assert.equal(face.binding('chat-b'), undefined);
    assert.deepEqual(calls, ['chat-a']);
    assert.equal(typeof face.annotations.capture, 'function');
}
finally {
    dispose();
    await m.cleanup();
} });
