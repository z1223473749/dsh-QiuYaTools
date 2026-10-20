import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const run = promisify(execFile)
const requiredMembers = ['package/package.json', 'package/lib/index.js']
const defaults = {
  enabled: true,
  pastedTextEnabled: true,
  sessionWindowsEnabled: true,
  bulkArchiveEnabled: true,
  planCommentsEnabled: true,
  sidebarToolsEnabled: true,
  promptSuggestionsEnabled: true,
  qThemeEnabled: false,
  computerUseEnabled: false,
  pasteCharacterThreshold: 1000,
  pasteLineThreshold: 15,
}

function safeMembers(listing) {
  const members = listing.trimEnd().split('\n')
  for (const member of members) {
    const path = member.replace(/\/$/u, '')
    if (!path.startsWith('package/') && path !== 'package'
      || /[\\\x00-\x1f\x7f]/u.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Package contains an unsafe archive path')
    }
  }
  for (const required of requiredMembers) {
    if (members.filter(member => member === required).length !== 1) throw new Error(`Package must contain exactly one ${required}`)
  }
}

/** Import the shipped Host outside the workspace; no package installation or Host activation. */
export async function verifyPackage(archivePath, { temporaryRoot = tmpdir() } = {}) {
  const archive = resolve(archivePath)
  const archiveStat = await stat(archive)
  if (!archiveStat.isFile() || archiveStat.size > 64 * 1024 * 1024) throw new Error('Expected a package archive smaller than 64 MiB')
  const environment = { ...process.env }
  delete environment.NODE_PATH
  delete environment.NODE_OPTIONS
  const tarOptions = { encoding: 'utf8', env: environment, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }
  const { stdout: listing } = await run('tar', ['-tzf', archive], tarOptions)
  safeMembers(listing)
  // Only copy these fixed regular destinations. Archive paths, links, scripts,
  // helpers, package node_modules and sibling source files are never extracted.
  const [{ stdout: metadata }, { stdout: host }] = await Promise.all(requiredMembers.map(member =>
    run('tar', ['-xzOf', archive, member], tarOptions)))
  const pkg = JSON.parse(metadata)
  if (pkg.name !== 'dsh-qiuya-tools' || pkg.type !== 'module' || typeof pkg.version !== 'string' || !pkg.version) {
    throw new Error('Unexpected package identity or module format')
  }
  if (pkg.main !== './lib/index.js' || pkg.exports?.['.'] !== './lib/index.js') throw new Error('Unexpected Host entry point')
  const temporary = await mkdtemp(join(temporaryRoot, 'qiuya-package-verify-'))
  try {
    const directory = join(temporary, 'package')
    await mkdir(join(directory, 'lib'), { recursive: true, mode: 0o700 })
    await writeFile(join(directory, 'package.json'), metadata, { flag: 'wx', mode: 0o600 })
    await writeFile(join(directory, 'lib/index.js'), host, { flag: 'wx', mode: 0o600 })
    const probe = `
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      assert.equal(process.env.NODE_PATH, undefined);
      assert.equal(process.env.NODE_OPTIONS, undefined);
      const plugin = await import(pathToFileURL(process.argv[1]).href);
      assert.equal(typeof plugin.apply, 'function', 'Host must export apply');
      const standard = plugin.Config?.['~standard'];
      assert.equal(standard?.version, 1, 'Config must implement Standard Schema v1');
      assert.equal(standard.vendor, 'schemastery', 'Config must retain the host schema contract');
      assert.equal(typeof standard.validate, 'function');
      const parsed = standard.validate({});
      assert.equal(typeof parsed?.then, 'undefined', 'Cordis requires synchronous Config validation');
      assert.equal(parsed.issues, undefined, 'Default settings must validate');
      const config = parsed.value;
      for (const [field, expected] of Object.entries(${JSON.stringify(defaults)})) {
        assert.equal(typeof config[field]?.get, 'function', field + ' must remain volatile');
        assert.equal(Symbol.for('cosmokit.volatile.write') in config[field], true, field + ' must retain the shared volatile protocol');
        assert.equal(config[field].get(), expected, field + ' has an unexpected default');
      }
      const invalid = standard.validate({ pasteCharacterThreshold: 0 });
      assert.ok(invalid.issues?.length, 'Config must reject an out-of-range threshold');
      const registrations = [];
      const recordOnly = {
        inject(dependencies, callback) {
          assert.ok(Array.isArray(dependencies) && dependencies.length);
          assert.ok(dependencies.every(name => typeof name === 'string' && name));
          assert.equal(typeof callback, 'function');
          registrations.push(dependencies);
          // Do not run callback: no services, effects, model calls or helpers start.
          return { dispose: async () => {} };
        },
        effect(callback) { assert.equal(typeof callback, 'function'); return () => {}; },
      };
      await plugin.apply(recordOnly, config);
      assert.ok(registrations.some(names => names.includes('connection')), 'Host must register its connection-dependent features');
      console.log(JSON.stringify({ imported: true, defaults: true, applied: true }));
    `
    try {
      const result = await run(process.execPath, ['--input-type=module', '--eval', probe, join(directory, 'lib/index.js')], {
        cwd: temporary, env: environment, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
      })
      const check = JSON.parse(result.stdout.trim())
      if (!check.imported || !check.defaults || !check.applied) throw new Error('Incomplete Host verification')
    } catch (error) {
      const detail = typeof error.stderr === 'string' ? error.stderr.trim().slice(0, 8192) : error.message
      throw new Error(`Portable Host verification failed: ${detail}`, { cause: error })
    }
    return { name: pkg.name, version: pkg.version }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-package.mjs <package.tgz>')
  const result = await verifyPackage(process.argv[2])
  console.log(`Verified portable Host: ${result.name}@${result.version}`)
}

if (process.argv[1] && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) {
  try { await main() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
