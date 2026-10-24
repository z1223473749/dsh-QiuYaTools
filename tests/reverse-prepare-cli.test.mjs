/** Actual public CLI early argument gates; child has launch/write hooks denied. No native or VM execution. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, mkdtemp, copyFile, symlink, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repo = fileURLToPath(new URL('../', import.meta.url))
const guard = "import cp from'node:child_process';import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';let forbidden=0;for(const n of['spawn','spawnSync','exec','execFile','execSync','execFileSync','fork'])cp[n]=()=>{forbidden++;throw Error('QYT_PREPARE_FORBIDDEN_EFFECT:'+n)};for(const n of['mkdir','writeFile','rm','rename','copyFile','unlink'])fs.promises[n]=async()=>{forbidden++;throw Error('QYT_PREPARE_FORBIDDEN_EFFECT:fs.'+n)};syncBuiltinESMExports();process.once('exit',()=>process.stdout.write(JSON.stringify({testOnlyNoEffects:true,forbiddenCalls:forbidden})+'\\n'));"
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'qiuya-reverse-prepare-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of ['prepare-reverse-remote-acceptance.mjs', 'reverse-remote-carrier.mjs', 'reverse-remote-delivery.mjs', 'windows-remote-delivery.mjs']) {
    const destination = join(root, 'scripts', name)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(repo, 'scripts', name), destination)
  }
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir')
  const helper = join(root, 'lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer'), bytes = Buffer.from('metadata-only-fixture-never-executed')
  await mkdir(dirname(helper), { recursive: true }); await writeFile(helper, bytes)
  const preload = join(root, 'deny-effects.mjs'); await writeFile(preload, guard)
  return { root, preload, helperSHA256: createHash('sha256').update(bytes).digest('hex') }
}
async function invoke(f, args) {
  const child = spawn(process.execPath, ['--import', f.preload, join(f.root, 'scripts/prepare-reverse-remote-acceptance.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, QIUYA_PD_VM: '', QIUYA_PD_HOST_IP: '' } })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  return { code, stdout, stderr }
}
for (const name of ['missing both', 'receipt alone', 'missing receipt', 'empty receipt', 'malformed SHA']) {
  test('public reverse prepare rejects ' + name + ' before any child launch or preparation write', async t => {
    const f = await fixture(t)
    const cases = {
      'missing both': [[], 'Pass --expect-helper-sha256'],
      'receipt alone': [['--runtime-receipt', '/unused/receipt.json'], 'Pass --expect-helper-sha256'],
      'missing receipt': [['--expect-helper-sha256', f.helperSHA256], 'Pass --runtime-receipt'],
      'empty receipt': [['--expect-helper-sha256', f.helperSHA256, '--runtime-receipt', ''], 'Pass --runtime-receipt'],
      'malformed SHA': [['--expect-helper-sha256', 'invalid', '--runtime-receipt', '/unused/receipt.json'], 'Pass --expect-helper-sha256'],
    }
    const [args, expected] = cases[name], actual = await invoke(f, args)
    assert.notEqual(actual.code, 0)
    assert(actual.stderr.includes(expected), actual.stderr)
    assert(!actual.stderr.includes('QYT_PREPARE_FORBIDDEN_EFFECT'), actual.stderr)
    assert.deepEqual(JSON.parse(actual.stdout.trim()), { testOnlyNoEffects: true, forbiddenCalls: 0 })
  })
}
