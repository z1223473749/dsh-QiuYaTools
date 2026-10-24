import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import { serverResponseSchema } from '@deepseek-ai/dsh-client-connection';
import { build } from 'esbuild';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
const dir = await mkdtemp('/private/tmp/annotation-submit-sdk-'), file = join(dir, 'runtime.mjs'), built = await build({ stdin: { contents: "export * from './src/features/annotations/host.ts';export * from './src/features/annotations/client-api.ts';export * from './src/features/annotations/session.ts';export * from './src/features/annotations/contract.ts'", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' });
await writeFile(file, built.outputFiles[0].contents);
const ui = await import(pathToFileURL(file).href), tick = () => new Promise(r => setImmediate(r)), defer = () => { let resolve; return { promise: new Promise(r => resolve = r), resolve }; }, sha = b => createHash('sha256').update(b).digest('hex');
function png(width, height) { const crc = b => { let c = 0xffffffff; for (const n of b) {
    c ^= n;
    for (let k = 0; k < 8; k++)
        c = c >>> 1 ^ ((c & 1) ? 0xedb88320 : 0);
} return (c ^ 0xffffffff) >>> 0; }, chunk = (name, bytes) => { const type = Buffer.from(name), b = Buffer.alloc(bytes.length + 12); b.writeUInt32BE(bytes.length); type.copy(b, 4); bytes.copy(b, 8); b.writeUInt32BE(crc(Buffer.concat([type, bytes])), b.length - 4); return b; }, h = Buffer.alloc(13); h.writeUInt32BE(width); h.writeUInt32BE(height, 4); h[8] = 8; h[9] = 2; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', h), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))]); }
async function setup(t, { pollMs = 500 } = {}) { const controller = new AbortController(), target = { chatSessionId: 'own-chat', environmentId: randomUUID(), workbenchTabId: randomUUID(), targetId: 'own-target', appId: 'own-app', kind: 'browser', epoch: 9 }, captureId = randomUUID(), jpeg = Buffer.from([255, 216, 255, 217]), anchor = { ...target, frameId: 'real-frozen-frame', width: 20, height: 10, geometry: { x: 0, y: 0, width: 20, height: 10, scale: 1 }, imageSHA256: sha(jpeg), viewportVersion: 'real-document-1' }, captured = { captureId, capture: { anchor, imageBase64: jpeg.toString('base64'), mediaType: 'image/jpeg' }, elementHitTest: true, expiresAt: Date.now() + 120000 }, state = { checks: 0, active: 0, maxActive: 0, beforeCheck: null, renderBefore: null, checkValue: true, owner: true, throwCheck: false }, calls = [], wire = []; let route; const peer = { principal: { kind: 'owner' } }, connection = { browserPeer: peer, fetch: { register(r) { route = r; return () => { }; } } }, hostContext = { get(name) { assert.equal(name, 'connection'); return connection; } }, source = { async capture(scope) { scope.assertCurrent(); return captured; }, async check(scope, id) { state.checks++; state.active++; state.maxActive = Math.max(state.maxActive, state.active); try {
        if (state.throwCheck)
            throw Error('private-provider-error-do-not-publish');
        await state.beforeCheck?.(state.checks, scope.signal);
        scope.assertCurrent();
        return state.checkValue ? { captureId: id, valid: true, anchor, checkedAgainst: { frameId: randomUUID(), imageSHA256: anchor.imageSHA256, viewportVersion: anchor.viewportVersion } } : { captureId: id, valid: false, reason: 'navigation' };
    }
    finally {
        state.active--;
    } }, async hitTest() { throw Error('not needed'); }, async release() { return; } }, dispose = ui.installAnnotationHost(hostContext, { source, async resolveScope(chat, signal) { return { chatSessionId: chat, signal, assertCurrent() { signal.throwIfAborted(); if (!state.owner)
            throw Error('owner changed'); } }; } }), client = new Context(); installConnection(client, { interactions: 'none', location: { hostname: 'localhost' }, transport: { fetch: async (input, init) => { const response = await route.fetch(new Request(new URL(input, 'http://own.test/'), init)); wire.push(await response.clone().json()); return response; } } }); const api = ui.createAnnotationAPI(() => client.get('connection')), bytes = png(20, 10), image = { data: bytes.toString('base64'), width: 20, height: 10, mediaType: 'image/png', sha256: sha(bytes) }, binding = { sessionId: 'own-chat', session: { sessionId: 'own-chat', beginSubmission(value) { calls.push(['begin', value]); return { requestId: 'actual-request', abandon() { calls.push(['abandon']); } }; }, async prompt(...args) { calls.push(['prompt', ...args]); return { ok: true, value: { accepted: true } }; } }, eventSource: { subscribe() { return () => { }; }, getSnapshot() { return { entries: [] }; } } }, session = await ui.AnnotationEditorSession.open({ api, target, currentChat: () => state.owner ? 'own-chat' : 'foreign-chat', binding: () => binding, signal: controller.signal, pollMs, render: async () => { await state.renderBefore?.(); return image; } }), draft = ui.setAnnotationNote(ui.createAnnotationDraft(captured.capture), '请修改这张自有画面'); t.after(async () => { await session.dispose().catch(() => { }); await dispose(); await client.fiber.dispose(); }); return { controller, target, captureId, anchor, captured, state, calls, wire, api, session, draft, client, connection, route, source }; }
test('real publicConnection HTTP caller accepts canonicalAnnotation failure and preservesfinite code, never rawprovider data', async (t) => { const f = await setup(t); f.state.throwCheck = true; await assert.rejects(f.api.check('own-chat', f.captureId, [], new AbortController().signal), e => e instanceof ui.AnnotationError && e.code === 'UNAVAILABLE'); const r = f.wire.at(-1); assert.equal(serverResponseSchema.safeParse(r).success, true); assert.deepEqual(r.result.error.details, {}); assert(!JSON.stringify(r).includes('private-provider-error')); });
test('final verifier alreadyrunning excludeslaterperiodicpoll; one check reachesHost and one publicprompt', async (t) => { const f = await setup(t), entered = defer(), held = defer(); f.state.beforeCheck = async (n) => { if (n === 1) {
    entered.resolve();
    await held.promise;
} }; const submitting = f.session.submission.submit(f.draft), outcome = submitting.then(() => ({ ok: true }), error => ({ error })); await entered.promise; const polling = f.session.check(); await tick(); const beforeRelease = f.state.checks; held.resolve(); await polling; const result = await outcome; assert.equal(beforeRelease, 1, 'No periodiccheck may change Hostlease.serial while explicitverification awaits'); assert.equal(result.ok, true, result.error?.message); assert.equal(f.calls.filter(x => x[0] === 'prompt').length, 1); assert.equal(f.state.maxActive, 1); });
test('existingperiodicpoll drainsbeforefinalverification; no concurrentHostread or earlypublicprompt', async (t) => { const f = await setup(t), entered = defer(), held = defer(); f.state.beforeCheck = async (n) => { if (n === 1) {
    entered.resolve();
    await held.promise;
} }; const polling = f.session.check(); await entered.promise; const verifying = submissionState(f.session, 'verifying'), submitting = f.session.submission.submit(f.draft), outcome = submitting.then(() => ({ ok: true }), error => ({ error })); await verifying; const before = { checks: f.state.checks, prompts: f.calls.filter(x => x[0] === 'prompt').length }; held.resolve(); await polling; const result = await outcome; assert.deepEqual(before, { checks: 1, prompts: 0 }); assert.equal(result.ok, true, result.error?.message); assert.equal(f.state.checks, 2, 'The final verifier mustperformits own new Hostread'); assert.equal(f.state.maxActive, 1); assert.equal(f.calls.filter(x => x[0] === 'prompt').length, 1); });
test('existingpoll trueinvalidation cannotbe ignored bysubmit; draftneverissuespublicbegin or prompt', async (t) => { const f = await setup(t), entered = defer(), held = defer(); f.state.beforeCheck = async (n) => { if (n === 1) {
    entered.resolve();
    await held.promise;
    f.state.checkValue = false;
} }; const polling = f.session.check(); await entered.promise; const verifying = submissionState(f.session, 'verifying'), submitting = f.session.submission.submit(f.draft), outcome = submitting.then(() => ({ ok: true }), error => ({ error })); await verifying; held.resolve(); await polling; const result = await outcome; assert(result.error); assert.equal(f.calls.length, 0); assert.equal(f.state.checks, 1); assert.equal(f.session.getSnapshot().invalid, true); });
test('renderingphasefreezes500ms polls beforeissued, finalread staysfresh andnosubmitreplay', async (t) => { const f = await setup(t), entered = defer(), held = defer(); f.state.renderBefore = async () => { entered.resolve(); await held.promise; }; const submitting = f.session.submission.submit(f.draft), outcome = submitting.then(() => ({ ok: true }), error => ({ error })); await entered.promise; await f.session.check(); const before = f.state.checks; held.resolve(); const result = await outcome; assert.equal(before, 0); assert.equal(result.ok, true, result.error?.message); assert.equal(f.state.checks, 1); assert.equal(f.calls.filter(x => x[0] === 'prompt').length, 1); await assert.rejects(f.session.submission.submit(f.draft)); assert.equal(f.calls.filter(x => x[0] === 'prompt').length, 1); });
function submissionState(session, expected) {
    if (session.submission.getSnapshot().state === expected)
        return Promise.resolve();
    return new Promise(resolve => { const off = session.submission.subscribe(() => { if (session.submission.getSnapshot().state === expected) {
        off();
        resolve();
    } }); });
}
for (const reason of ['cancel', 'owner']) {
    test(`${reason} during drain of an already issued read blocks the queued final check and public prompt`, async (t) => {
        const f = await setup(t), entered = defer(), held = defer();
        f.state.beforeCheck = async (n) => { if (n === 1) {
            entered.resolve();
            await held.promise;
        } };
        const polling = f.session.check();
        await entered.promise;
        const verifying = submissionState(f.session, 'verifying');
        const submitting = f.session.submission.submit(f.draft);
        const rejected = assert.rejects(submitting);
        await verifying;
        if (reason === 'cancel')
            f.session.submission.cancel();
        else
            f.state.owner = false;
        held.resolve();
        await polling;
        await rejected;
        assert.equal(f.state.checks, 1, 'A queued final read must not reach the Host after cancellation or owner drift');
        assert.equal(f.calls.length, 0);
        assert.equal(f.session.submission.getSnapshot().issued, false);
    });
}
test('the real scheduled poll is cleared during rendering, not merely skipped by manual callers', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await setup(t), entered = defer(), held = defer();
    f.state.renderBefore = async () => { entered.resolve(); await held.promise; };
    const submitting = f.session.submission.submit(f.draft);
    await entered.promise;
    t.mock.timers.tick(500);
    await tick();
    assert.equal(f.state.checks, 0);
    held.resolve();
    await submitting;
    assert.equal(f.state.checks, 1);
    assert.equal(f.calls.filter(c => c[0] === 'prompt').length, 1);
});
test('a real final Host failure becomes a finite localized rejection, preserves the draft, and never issues or replays public prompt', async t => {
    const f = await setup(t);
    f.state.throwCheck = true;
    await assert.rejects(f.session.submission.submit(f.draft), error => error instanceof ui.AnnotationError && error.code === 'UNAVAILABLE');
    assert.equal(f.session.submission.getSnapshot().state, 'rejected');
    assert.equal(f.session.submission.getSnapshot().issued, false);
    assert.equal(f.session.submission.getSnapshot().message, '批注画面暂不可用，请重新截取。');
    assert.equal(f.draft.note, '请修改这张自有画面');
    assert.equal(f.calls.length, 0);
    const previousChecks = f.state.checks;
    await assert.rejects(f.session.submission.submit(f.draft));
    assert.equal(f.state.checks, previousChecks);
    assert.equal(f.calls.length, 0);
});
