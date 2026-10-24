import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

// The installed Harness browser loader provides React, not the Host session
// brand factory. Execute the real bundled entry against that boundary so a
// type-only SDK dependency cannot silently become a browser runtime require.
test('template browser module loads and parses current resources with real React and no Host session runtime', async () => {
  const output = await build({ absWorkingDir: process.cwd(), entryPoints: ['src/features/acceptance-templates/client.tsx'], bundle: true, write: false, platform: 'browser', format: 'cjs', target: 'es2022', packages: 'external', jsx: 'automatic', logLevel: 'silent' });
  const actual = createRequire(import.meta.url), module = { exports: {} }, requested = [];
  const require = name => {
    requested.push(name);
    assert(['react', 'react/jsx-runtime'].includes(name), 'Unavailable in actual browser module table: ' + name);
    return actual(name);
  };
  runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, require, URL, AbortController, AbortSignal, crypto: webcrypto }, { timeout: 1000 });
  assert(requested.includes('react'));
  const api = module.exports, chat = 'session-isolated-browser-load';
  assert.equal(typeof api.installAcceptanceTemplateClient, 'function');
  const address = api.templateAddress(chat);
  assert.equal(api.parseTemplateAddress(address).chatSessionId, chat);
  assert.equal(api.parseTemplateAddress('https://outside.invalid/'), null);
  assert.equal(api.parseTemplateAddress(address + '?unexpected=yes'), null);
});
