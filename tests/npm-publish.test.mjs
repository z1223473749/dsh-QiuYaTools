import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { publishNpmRelease } from '../scripts/publish-npm.mjs'

const exec = promisify(execFile)
const sha = 'a'.repeat(40)
const pkg = {
  name: 'dsh-qiuya-tools', version: '0.5.2', type: 'module',
  main: './lib/index.js', exports: { '.': './lib/index.js' },
  repository: { type: 'git', url: 'git+https://github.com/z1223473749/dsh-QiuYaTools.git' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}
const release = { tagName: 'v0.5.2', isDraft: false, isPrerelease: false, publishedAt: '2026-10-20T12:00:00Z' }
const absent = { code: 1, stdout: JSON.stringify({ error: { code: 'E404' } }), stderr: '' }
const ok = value => ({ code: 0, stdout: JSON.stringify(value), stderr: '' })
const host = `
const defaults={enabled:true,pastedTextEnabled:true,sessionWindowsEnabled:true,bulkArchiveEnabled:true,planCommentsEnabled:true,sidebarToolsEnabled:true,promptSuggestionsEnabled:true,qThemeEnabled:false,pasteCharacterThreshold:1000,pasteLineThreshold:15};
export const Config={['~standard']:{version:1,vendor:'schemastery',validate(input){
  if(input.pasteCharacterThreshold===0)return{issues:[{message:'Invalid threshold'}]};
  return{value:Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,{get:()=>value,[Symbol.for('cosmokit.volatile.write')]:()=>{}}]))};
}}};
export function apply(ctx){ctx.inject(['connection'],()=>{throw new Error('Must not activate real features')});}
`

function tarball(metadata = pkg, entry = host) {
  const blocks = []
  for (const [name, source] of [['package/package.json', JSON.stringify(metadata)], ['package/lib/index.js', entry]]) {
    const bytes = Buffer.from(source), header = Buffer.alloc(512)
    header.write(name, 0, 100); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116)
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124); header.write('00000000000\0', 136)
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263)
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'qiuya-npm-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const temporaryRoot = join(root, 'temporary')
  await mkdir(temporaryRoot)
  await writeFile(join(root, 'package.json'), JSON.stringify({ ...pkg, ...options.package }))
  const env = {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'z1223473749/dsh-QiuYaTools',
    GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v0.5.2', GITHUB_SHA: sha,
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.test/', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-oidc',
    ...options.env,
  }
  const bytes = tarball({ ...pkg, ...options.archivePackage }, options.host ?? host)
  const checksum = `${createHash('sha256').update(bytes).digest('hex')}  dsh-qiuya-tools.tgz\n`
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  const calls = [], published = [], waits = [], reports = [], queries = [...options.queries ?? [absent]], latest = [...options.latest ?? [ok('0.5.1')]]
  const run = async (command, args, execution) => {
    calls.push({ command, args: [...args], execution })
    if (command === 'git') return { code: 0, stdout: options.gitSha ?? sha, stderr: '' }
    if (command === 'npm' && args[0] === '--version') return { code: 0, stdout: options.npmVersion ?? '11.21.0', stderr: '' }
    if (command === 'gh' && args[1] === 'view') return ok({ ...release, ...options.release })
    if (command === 'gh' && args[1] === 'download') {
      const directory = args[args.indexOf('--dir') + 1]
      await writeFile(join(directory, 'dsh-qiuya-tools.tgz'), bytes)
      await writeFile(join(directory, 'SHA256SUMS'), options.checksum ?? checksum)
      return { code: 0, stdout: '', stderr: '' }
    }
    if (command === 'tar') return { code: 0, ...await exec(command, args, { encoding: 'utf8' }) }
    if (command === 'npm' && args[0] === 'view') {
      if (args[2] === 'dist-tags.latest') return !options.latest && published.length && options.publish?.code !== 1 ? ok(pkg.version) : latest.length > 1 ? latest.shift() : latest[0]
      return queries.shift() ?? (published.length && options.publish?.code !== 1 ? ok(integrity) : absent)
    }
    if (command === 'npm' && args[0] === 'publish') {
      published.push(await readFile(args[1]))
      return options.publish ?? ok({})
    }
    throw new Error('Unexpected command: ' + command)
  }
  return { root, env, bytes, checksum, integrity, calls, published, waits, reports, temporaryRoot,
    publish: () => publishNpmRelease({ root, env, run, temporaryRoot, wait: async milliseconds => { waits.push(milliseconds) }, report: message => reports.push(message) }) }
}

test('all supported release paths publish the verified release bytes without rebuilding or legacy tokens', async t => {
  for (const event of ['push', 'release', 'workflow_dispatch']) await t.test(event, async t => {
    const f = await fixture(t, { env: { GITHUB_EVENT_NAME: event, NODE_AUTH_TOKEN: 'synthetic-legacy', NPM_TOKEN: 'synthetic-legacy' } })
    assert.deepEqual(await f.publish(), { status: 'published', version: pkg.version, integrity: f.integrity, distTag: 'latest' })
    assert.deepEqual(f.published, [f.bytes])
    const publish = f.calls.find(call => call.command === 'npm' && call.args[0] === 'publish')
    assert.deepEqual(publish.args.slice(2), ['--ignore-scripts', '--access', 'public', '--tag', 'latest', '--registry=https://registry.npmjs.org', '--json'])
    assert.equal(publish.execution.env.NODE_AUTH_TOKEN, undefined)
    assert.equal(publish.execution.env.NPM_TOKEN, undefined)
    assert.equal(f.calls.some(call => ['ci', 'install', 'pack', 'run'].includes(call.args[0])), false)
    assert.deepEqual(await readdir(f.temporaryRoot), [])
  })
})

test('stable tag, package identity, repository and commit checks fail before any download or publication', async t => {
  for (const options of [
    { env: { GITHUB_REF: 'refs/heads/main' } },
    { env: { GITHUB_REF: 'refs/tags/v0.5.3' } },
    { package: { version: '0.5.2-beta.1' }, env: { GITHUB_REF: 'refs/tags/v0.5.2-beta.1' } },
    { package: { name: 'other-package' } },
    { package: { repository: { url: 'https://github.com/another/repo' } } },
    { env: { GITHUB_REPOSITORY: 'fork/repo' } },
    { env: { GITHUB_EVENT_NAME: 'pull_request' } },
    { env: { GITHUB_SHA: '' } },
    { gitSha: 'b'.repeat(40) },
    { npmVersion: '10.9.3' },
  ]) {
    const f = await fixture(t, options)
    await assert.rejects(f.publish())
    assert.equal(f.calls.some(call => call.args[1] === 'download'), false)
    assert.deepEqual(f.published, [])
  }
})

test('drafts, prereleases, unpublished and mismatched GitHub releases never publish', async t => {
  for (const patch of [{ isDraft: true }, { isPrerelease: true }, { publishedAt: null }, { tagName: 'v0.5.1' }]) {
    const f = await fixture(t, { release: patch })
    await assert.rejects(f.publish(), /published stable GitHub release/)
    assert.deepEqual(f.published, [])
  }
})

test('checksum, archive metadata and clean-room Host failures stop before npm lookup', async t => {
  for (const options of [
    { checksum: `${'0'.repeat(64)}  dsh-qiuya-tools.tgz\n` },
    { checksum: `${'0'.repeat(64)}  another.tgz\n` },
    { archivePackage: { version: '0.5.1' } },
    { archivePackage: { name: 'another-package' } },
    { archivePackage: { repository: { url: 'https://github.com/another/repo' } } },
    { host: `import missing from 'must-not-resolve';\n${host}` },
  ]) {
    const f = await fixture(t, options)
    await assert.rejects(f.publish())
    assert.equal(f.calls.some(call => call.command === 'npm' && call.args[0] === 'view'), false)
    assert.deepEqual(f.published, [])
    assert.deepEqual(await readdir(f.temporaryRoot), [])
  }
  const f = await fixture(t)
  const duplicate = await fixture(t, { checksum: f.checksum + f.checksum })
  await assert.rejects(duplicate.publish(), /SHA256 mismatch/)
})

test('an existing npm version skips only when its SHA512 matches the exact GitHub archive', async t => {
  const f = await fixture(t)
  const same = await fixture(t, { queries: [ok(f.integrity)], latest: [ok(pkg.version)] })
  assert.equal((await same.publish()).status, 'already-published')
  assert.deepEqual(same.published, [])
  const different = await fixture(t, { queries: [ok(`sha512-${Buffer.alloc(64, 1).toString('base64')}`)] })
  await assert.rejects(different.publish(), /different release bytes/)
  assert.deepEqual(different.published, [])
})

test('registry network, authentication, server, malformed and empty replies are never mistaken for absence', async t => {
  for (const result of [
    { code: 1, stdout: JSON.stringify({ error: { code: 'ENOTFOUND' } }), stderr: '' },
    { code: 1, stdout: JSON.stringify({ error: { code: 'E401' } }), stderr: '' },
    { code: 1, stdout: JSON.stringify({ error: { code: 'E503' } }), stderr: '' },
    { code: 1, stdout: '', stderr: 'E404 in an unstructured proxy response' },
    { code: 0, stdout: 'not json', stderr: '' }, ok(null), ok(''),
  ]) {
    const f = await fixture(t, { queries: [result] })
    await assert.rejects(f.publish())
    assert.deepEqual(f.published, [])
  }
})

test('missing OIDC cannot fall back to a legacy token', async t => {
  const f = await fixture(t, { env: { ACTIONS_ID_TOKEN_REQUEST_TOKEN: '', NODE_AUTH_TOKEN: 'synthetic-legacy' } })
  await assert.rejects(f.publish(), /OIDC is unavailable/)
  assert.deepEqual(f.published, [])
})

test('a failed publish is successful only after the registry confirms the same bytes', async t => {
  const initial = await fixture(t)
  const lostResponse = await fixture(t, { queries: [absent, ok(initial.integrity)], latest: [ok('0.5.1'), ok(pkg.version)], publish: { code: 1, stdout: '', stderr: 'connection closed' } })
  assert.equal((await lostResponse.publish()).status, 'already-published')
  assert.equal(lostResponse.published.length, 1)
  for (const next of [absent, ok(`sha512-${Buffer.alloc(64, 1).toString('base64')}`), { code: 1, stdout: '', stderr: 'network error' }]) {
    const f = await fixture(t, { queries: [absent, next], publish: { code: 1, stdout: '', stderr: 'failed' } })
    await assert.rejects(f.publish())
    assert.equal(f.published.length, 1, 'there is no blind second publish attempt')
  }
})

test('the actual CLI runs fake gh/npm child processes and publishes only the downloaded archive', async t => {
  const f = await fixture(t)
  const bin = join(f.root, 'bin'), scripts = join(f.root, 'scripts'), assets = join(f.root, 'assets')
  await Promise.all([mkdir(bin), mkdir(scripts), mkdir(assets)])
  for (const name of ['publish-npm.mjs', 'verify-package.mjs']) await copyFile(new URL(`../scripts/${name}`, import.meta.url), join(scripts, name))
  await writeFile(join(assets, 'dsh-qiuya-tools.tgz'), f.bytes)
  await writeFile(join(assets, 'SHA256SUMS'), f.checksum)
  const fake = `#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';import{createHash}from'node:crypto';
const name=path.basename(process.argv[1]),args=process.argv.slice(2),root=process.env.FIXTURE_ROOT;
fs.appendFileSync(path.join(root,'commands.jsonl'),JSON.stringify({name,args,legacy:!!process.env.NODE_AUTH_TOKEN||!!process.env.NPM_TOKEN})+'\\n');
if(name==='git')console.log(process.env.GITHUB_SHA);
else if(name==='gh'&&args[1]==='view')console.log(${JSON.stringify(JSON.stringify(release))});
else if(name==='gh'&&args[1]==='download'){const dir=args[args.indexOf('--dir')+1];for(const file of ['dsh-qiuya-tools.tgz','SHA256SUMS'])fs.copyFileSync(path.join(root,'assets',file),path.join(dir,file));}
else if(name==='npm'&&args[0]==='--version')console.log('11.21.0');
else if(name==='npm'&&args[0]==='view'&&args[2]==='dist-tags.latest')console.log(JSON.stringify(fs.existsSync(path.join(root,'published.tgz'))?'0.5.2':'0.5.1'));
else if(name==='npm'&&args[0]==='view'&&fs.existsSync(path.join(root,'published.tgz')))console.log(JSON.stringify('sha512-'+createHash('sha512').update(fs.readFileSync(path.join(root,'published.tgz'))).digest('base64')));
else if(name==='npm'&&args[0]==='view'){console.log(JSON.stringify({error:{code:'E404'}}));process.exitCode=1;}
else if(name==='npm'&&args[0]==='publish'){fs.copyFileSync(args[1],path.join(root,'published.tgz'));console.log('{}');}
else{console.error('Unexpected fake command');process.exitCode=2;}
`
  for (const name of ['gh', 'git', 'npm']) await writeFile(join(bin, name), fake, { mode: 0o700 })
  const result = await exec(process.execPath, [join(scripts, 'publish-npm.mjs')], {
    cwd: f.root, env: { ...process.env, ...f.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_ROOT: f.root, NODE_AUTH_TOKEN: 'synthetic-legacy' },
    encoding: 'utf8', timeout: 15_000,
  })
  assert.equal(JSON.parse(result.stdout).status, 'published')
  assert.deepEqual(await readFile(join(f.root, 'published.tgz')), f.bytes)
  const calls = (await readFile(join(f.root, 'commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(calls.every(call => !call.legacy), true)
  assert.equal(calls.filter(call => call.name === 'npm' && call.args[0] === 'publish').length, 1)
  const download = calls.find(call => call.name === 'gh' && call.args[1] === 'download')
  await assert.rejects(readFile(join(download.args[download.args.indexOf('--dir') + 1], 'dsh-qiuya-tools.tgz')), { code: 'ENOENT' })
})

test('publishing an older missing version uses a separate dist-tag and preserves a newer latest', async t => {
  const f = await fixture(t, { latest: [ok('1.0.0')] })
  assert.equal((await f.publish()).distTag, 'version-0.5.2')
  const publish = f.calls.find(call => call.command === 'npm' && call.args[0] === 'publish')
  assert.equal(publish.args[publish.args.indexOf('--tag') + 1], 'version-0.5.2')
  assert.equal(f.calls.some(call => call.command === 'npm' && call.args[0] === 'dist-tag'), false)
})

test('an existing matching version never silently ignores an unadvanced latest tag', async t => {
  const initial = await fixture(t)
  const f = await fixture(t, { queries: [ok(initial.integrity)], latest: [ok('0.5.1')] })
  await assert.rejects(f.publish(), /latest was not advanced/)
  assert.deepEqual(f.published, [])
  const older = await fixture(t, { queries: [ok(initial.integrity)], latest: [ok('1.0.0')] })
  assert.equal((await older.publish()).latestVersion, '1.0.0')
  assert.deepEqual(older.published, [])
})

test('latest lookup errors cannot accidentally downgrade or publish', async t => {
  for (const latest of [ok('1.0.0-beta.1'), ok('0.0.0-stage'), ok(null), { code: 1, stdout: JSON.stringify({ error: { code: 'E503' } }), stderr: '' }]) {
    const f = await fixture(t, { latest: [latest] })
    await assert.rejects(f.publish())
    assert.deepEqual(f.published, [])
  }
})

test('a zero publish exit is confirmed against the registry and never substitutes for actual publication', async t => {
  const initial = await fixture(t)
  const delayed = await fixture(t, { queries: [absent, absent, absent, ok(initial.integrity)] })
  assert.equal((await delayed.publish()).status, 'published')
  assert.equal(delayed.calls.filter(call => call.command === 'npm' && call.args[0] === 'publish').length, 1)
  for (const options of [
    { queries: Array.from({ length: 47 }, () => absent) },
    { queries: [absent, ok(`sha512-${Buffer.alloc(64, 1).toString('base64')}`)] },
    { latest: [ok('0.5.1')] },
  ]) {
    const f = await fixture(t, options)
    await assert.rejects(f.publish())
    assert.equal(f.published.length, 1)
  }
})

test('normal scanning can return many E404 replies before the exact version becomes public', async t => {
  const initial = await fixture(t)
  const f = await fixture(t, { queries: [...Array.from({ length: 12 }, () => absent), ok(initial.integrity)] })
  assert.equal((await f.publish()).status, 'published')
  assert.equal(f.published.length, 1, 'scanning never starts another publish')
  assert.deepEqual(f.waits, Array.from({ length: 11 }, () => 20_000))
  assert.equal(f.reports.length, 11)
  assert.deepEqual(await readdir(f.temporaryRoot), [])
})

test('a post-publish placeholder latest only waits until the stable target is actually visible', async t => {
  const f = await fixture(t, { latest: [ok('0.5.1'), ...Array.from({ length: 6 }, () => ok('0.0.0-stage')), ok(pkg.version)] })
  const result = await f.publish()
  assert.equal(result.status, 'published')
  assert.equal(result.distTag, 'latest')
  assert.deepEqual(f.waits, Array.from({ length: 6 }, () => 20_000))
  assert.equal(f.published.length, 1)
  const publish = f.calls.find(call => call.command === 'npm' && call.args[0] === 'publish')
  assert.equal(publish.args[publish.args.indexOf('--tag') + 1], 'latest', 'the stage placeholder is never compared as a newer release')
  const older = await fixture(t, { latest: [ok('1.0.0'), ok('0.0.0-stage'), ok('1.0.0')] })
  assert.equal((await older.publish()).distTag, 'version-0.5.2')
  assert.deepEqual(older.waits, [20_000], 'older-version publication also requires a confirmed stable latest')
})

test('an unpublished version or unconfirmed latest times out after exactly 15 minutes of bounded waits', async t => {
  for (const options of [
    { queries: Array.from({ length: 47 }, () => absent) },
    { latest: [ok('0.5.1'), ok('0.0.0-stage')] },
    { latest: [ok('0.5.1')] },
  ]) {
    const f = await fixture(t, options)
    await assert.rejects(f.publish(), /after 15 minutes.*rerun this workflow later/)
    assert.equal(f.waits.length, 45)
    assert.equal(f.waits.reduce((sum, delay) => sum + delay, 0), 15 * 60 * 1_000)
    assert.equal(f.published.length, 1)
    assert.deepEqual(await readdir(f.temporaryRoot), [])
  }
})

test('post-publish malformed latest, lookup failures and different bytes still fail instead of waiting or reporting success', async t => {
  for (const options of [
    { latest: [ok('0.5.1'), ok('0.5.3-beta.1')] },
    { latest: [ok('0.5.1'), ok(null)] },
    { queries: [absent, { code: 1, stdout: JSON.stringify({ error: { code: 'E503' } }), stderr: '' }] },
    { queries: [absent, ok(`sha512-${Buffer.alloc(64, 1).toString('base64')}`)] },
  ]) {
    const f = await fixture(t, options)
    await assert.rejects(f.publish())
    assert.equal(f.waits.length, 0)
    assert.equal(f.published.length, 1)
  }
})
