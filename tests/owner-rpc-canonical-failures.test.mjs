import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import { serverResponseSchema } from '@deepseek-ai/dsh-client-connection';
import { build } from 'esbuild';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const directory = await mkdtemp('/private/tmp/owner-rpc-schema-');
const entry = join(directory, 'runtime.mjs');
const modules = ['annotations', 'workbench', 'acceptance-workflows', 'acceptance-templates', 'browser-diagnostics', 'acceptance-runs'];
const built = await build({ stdin: { contents: modules.map(name => `export * from './src/features/${name}/host.ts'`).join(';'), resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' });
await writeFile(entry, built.outputFiles[0].contents);
const product = await import(pathToFileURL(entry).href);
const privateMessage = 'private-path-and-provider-error-never-publish';
const fail = () => { throw Error(privateMessage); };
const resolveScope = async (chatSessionId, signal) => ({ chatSessionId, signal, assertCurrent() { signal.throwIfAborted(); } });
const target = { chatSessionId: 'own-chat', environmentId: randomUUID(), workbenchTabId: randomUUID(), targetId: 'own-target', appId: 'own-app', kind: 'browser', epoch: 1 };
const definitions = [
    ['annotations', (ctx) => product.installAnnotationHost(ctx, { source: { capture: fail }, resolveScope }), { op: 'capture', chatSessionId: 'own-chat', target }, 'UNAVAILABLE'],
    ['workbench', (ctx) => product.installWorkbenchHost(ctx, { registry: { views: fail }, permissions: {}, resolveScope }), { op: 'status', chatSessionId: 'own-chat' }, 'WORKBENCH_UNAVAILABLE'],
    ['workflows', (ctx) => product.installAcceptanceWorkflowHost(ctx, { list: fail }, { resolveScope }), { op: 'list', chatSessionId: 'own-chat' }, 'WORKFLOW_UNAVAILABLE'],
    ['templates', (ctx) => product.installAcceptanceTemplateHost(ctx, { list: fail }, { resolveScope }), { op: 'list', chatSessionId: 'own-chat' }, 'TEMPLATE_UNAVAILABLE'],
    ['diagnostics', (ctx) => product.installBrowserDiagnosticHost(ctx, { status: fail }, resolveScope), { op: 'status', chatSessionId: 'own-chat' }, 'DIAGNOSTICS_UNAVAILABLE'],
    ['runs', (ctx) => product.installAcceptanceRunHost(ctx, { list: fail }, { resolveScope, readEvidence: fail }), { op: 'list', chatSessionId: 'own-chat' }, 'RUN_UNAVAILABLE'],
];
for (const [name, install, payload, errorCode] of definitions) {
    test(`${name} actual public Connection client parses a Host provider failure with canonical details and preserves its correlated error`, async (t) => {
        let route;
        const connection = { browserPeer: { principal: { kind: 'owner' } }, fetch: { register(value) { route = value; return async () => { }; } } };
        const remove = install({ get(name) { assert.equal(name, 'connection'); return connection; } });
        const client = new Context(), wire = [];
        installConnection(client, { interactions: 'none', location: { hostname: 'localhost' }, transport: { fetch: async (input, init) => {
                    const response = await route.fetch(new Request(new URL(input, 'http://own.test/'), init));
                    wire.push(await response.clone().json());
                    return response;
                } } });
        t.after(async () => { await remove(); await client.fiber.dispose(); });
        const result = await client.get('connection').rpc.call('/api', route.path.slice('/api/'.length), payload, new AbortController().signal);
        assert.equal(result.ok, false);
        assert.equal(result.error.code, errorCode);
        assert.deepEqual(result.error.details, {});
        assert.equal(wire.length, 1, 'Failure is reported once, without retrying a device or provider');
        assert.equal(serverResponseSchema.safeParse(wire[0]).success, true);
        assert.equal(typeof wire[0].rpcId, 'string');
        assert(wire[0].rpcId.length > 0);
        assert(!JSON.stringify(wire[0]).includes(privateMessage));
    });
}
