import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { verifyPackage } from '../scripts/verify-package.mjs'

const metadata = JSON.stringify({ name: 'dsh-qiuya-tools', version: '0.5.1', type: 'module', main: './lib/index.js', exports: { '.': './lib/index.js' } })
const host = `
  const defaults = { enabled:true,pastedTextEnabled:true,sessionWindowsEnabled:true,bulkArchiveEnabled:true,planCommentsEnabled:true,sidebarToolsEnabled:true,promptSuggestionsEnabled:true,qThemeEnabled:false,computerUseEnabled:true,pasteCharacterThreshold:1000,pasteLineThreshold:15 };
  export const Config = { ['~standard']: {version:1,vendor:'schemastery',validate(input) {
    if(input.pasteCharacterThreshold===0) return {issues:[{message:'Invalid threshold'}]};
    return {value:Object.fromEntries(Object.entries(defaults).map(([name,value])=>[name,{get:()=>value,[Symbol.for('cosmokit.volatile.write')]:()=>{}}]))};
  }}};
  export function apply(ctx) {ctx.inject(['connection'],()=>{throw new Error('MUST NOT ACTIVATE HOST FEATURES')});}
`

function archive(entries) {
  const blocks = []
  for (const [name, text] of entries) {
    const bytes = Buffer.from(text), header = Buffer.alloc(512)
    header.write(name, 0, 100); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116)
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124); header.write('00000000000\0', 136)
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263)
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

async function fixture(t, entries = [['package/package.json', metadata], ['package/lib/index.js', host]]) {
  const directory = await mkdtemp(join(tmpdir(), 'qiuya-verify-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'package.tgz'), temporaryRoot = join(directory, 'verification')
  await mkdir(temporaryRoot)
  await writeFile(path, archive(entries))
  return { path, temporaryRoot, options: { temporaryRoot } }
}

test('packed Host imports with clean environment, validates defaults and only records apply registrations', async t => {
  const f = await fixture(t)
  const previous = { NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_PATH: process.env.NODE_PATH }
  process.env.NODE_OPTIONS = '--require /this-development-hook-must-not-run.cjs'
  process.env.NODE_PATH = '/this-development-dependency-directory-must-not-be-used'
  try {
    assert.deepEqual(await verifyPackage(f.path, f.options), { name: 'dsh-qiuya-tools', version: '0.5.1' })
  } finally {
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value
  }
  assert.deepEqual(await readdir(f.temporaryRoot), [], 'success must remove the extracted smoke fixture')
})

test('bare runtime dependencies fail rather than borrowing workspace packages, with cleanup on failure', async t => {
  const f = await fixture(t, [['package/package.json', metadata], ['package/lib/index.js', `import schema from '@deepseek-ai/schemastery';\n${host}`]])
  await assert.rejects(verifyPackage(f.path, f.options), /Cannot find package '@deepseek-ai\/schemastery'/)
  assert.deepEqual(await readdir(f.temporaryRoot), [], 'failure must remove the extracted smoke fixture')
})

test('invalid Config defaults fail after import and apply cannot mask the mismatch', async t => {
  const f = await fixture(t, [['package/package.json', metadata], ['package/lib/index.js', host.replace('enabled:true', 'enabled:false')]])
  await assert.rejects(verifyPackage(f.path, f.options), /enabled has an unexpected default/)
  assert.deepEqual(await readdir(f.temporaryRoot), [])
})

test('only fixed members are staged; runtime imports of other archive files are rejected', async t => {
  const f = await fixture(t, [['package/package.json', metadata], ['package/lib/index.js', `import './side-effect.js';\n${host}`], ['package/lib/side-effect.js', "throw new Error('MUST NOT RUN OTHER ARCHIVE FILES')"]])
  await assert.rejects(verifyPackage(f.path, f.options), /Cannot find module/)
  assert.deepEqual(await readdir(f.temporaryRoot), [])
})

test('duplicate required members and unsafe paths fail before any extraction', async t => {
  for (const extra of [['package/lib/index.js', host], ['../outside.txt', 'must not be extracted']]) {
    const f = await fixture(t, [['package/package.json', metadata], ['package/lib/index.js', host], extra])
    await assert.rejects(verifyPackage(f.path, f.options), /exactly one|unsafe archive path/)
    assert.deepEqual(await readdir(f.temporaryRoot), [])
  }
})

test('release verifies the final named archive after packing and before publishing', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const pack = workflow.indexOf('node scripts/prepare-release.mjs')
  const verify = workflow.indexOf('node scripts/verify-package.mjs artifacts/dsh-qiuya-tools.tgz')
  const publish = workflow.indexOf('gh release create')
  assert.ok(pack >= 0 && verify > pack && publish > verify)
})
