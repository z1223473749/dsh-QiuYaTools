import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canReuseMacOSComputer, macOSComputerApplicationDigest, macOSComputerInputFingerprint, recordMacOSComputerBuild } from '../scripts/macos-computer-build-cache.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'qyt-build-cache-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const application = join(root, 'Computer.app'), receiptPath = join(root, 'cache/receipt.json')
  await mkdir(join(application, 'Contents/MacOS'), { recursive: true })
  await mkdir(join(application, 'Contents/Resources'))
  const binary = join(application, 'Contents/MacOS/helper'), icon = join(application, 'Contents/Resources/icon.icns')
  await writeFile(binary, 'synthetic fixture; never executed', { mode: 0o755 })
  await writeFile(icon, 'icon fixture')
  await writeFile(join(application, 'Contents/Info.plist'), 'plist fixture')
  let verifications = 0
  const args = { receiptPath, application, fingerprint: 'a'.repeat(64), verifySignature: async () => { verifications++ } }
  return { root, args, binary, icon, verifications: () => verifications }
}

test('a bundle without a build receipt is never adopted as a matching source build', async t => {
  const f = await fixture(t)
  assert.equal(await canReuseMacOSComputer(f.args), false)
  assert.equal(f.verifications(), 0)
})

test('an unchanged, signature-verified bundle is reused without changing app bytes or modification times', async t => {
  const f = await fixture(t), before = await macOSComputerApplicationDigest(f.args.application), metadata = await lstat(f.binary, { bigint: true })
  await recordMacOSComputerBuild(f.args)
  assert.equal(await canReuseMacOSComputer(f.args), true)
  assert.equal(f.verifications(), 1)
  assert.equal(await macOSComputerApplicationDigest(f.args.application), before)
  assert.equal((await lstat(f.binary, { bigint: true })).mtimeNs, metadata.mtimeNs)
  const receipt = JSON.parse(await readFile(f.args.receiptPath, 'utf8'))
  assert.equal(receipt.applicationDigest, before)
})

test('a changed executable, icon, sealed identity or added file invalidates reuse before signature verification', async t => {
  for (const relative of ['Contents/MacOS/helper', 'Contents/Resources/icon.icns', 'Contents/Info.plist', 'Contents/unexpected']) {
    const f = await fixture(t)
    await recordMacOSComputerBuild(f.args)
    await writeFile(join(f.args.application, relative), 'modified fixture')
    assert.equal(await canReuseMacOSComputer(f.args), false, relative)
    assert.equal(f.verifications(), 0)
  }
})

test('missing output, changed executable permissions and symlink replacement invalidate reuse', async t => {
  for (const mutate of [f => rm(f.binary), f => chmod(f.binary, 0o644), async f => {
    await rm(f.icon); await symlink(f.binary, f.icon)
  }]) {
    const f = await fixture(t)
    await recordMacOSComputerBuild(f.args)
    await mutate(f)
    assert.equal(await canReuseMacOSComputer(f.args), false)
  }
})

test('a strict signature failure, changed build fingerprint or malformed receipt requires rebuilding', async t => {
  const f = await fixture(t)
  await recordMacOSComputerBuild(f.args)
  assert.equal(await canReuseMacOSComputer({ ...f.args, verifySignature: async () => { throw new Error('invalid seal') } }), false)
  assert.equal(await canReuseMacOSComputer({ ...f.args, fingerprint: 'b'.repeat(64) }), false)
  await writeFile(f.args.receiptPath, '{invalid json')
  assert.equal(await canReuseMacOSComputer(f.args), false)
})

test('output changing during signature verification cannot be reused', async t => {
  const f = await fixture(t)
  await recordMacOSComputerBuild(f.args)
  assert.equal(await canReuseMacOSComputer({ ...f.args, verifySignature: () => writeFile(f.icon, 'concurrently changed output') }), false)
})

test('source, artwork, plist, compiler flags, architecture, signer and toolchain changes alter the fingerprint', async t => {
  const f = await fixture(t), files = [f.binary, f.icon]
  const settings = { plist: 'v1', architectures: ['arm64'], flags: ['-O'], signingIdentity: '-', tools: ['swift-1'], environment: { SDKROOT: '/sdk/1' } }
  const original = await macOSComputerInputFingerprint(files, settings)
  assert.equal(await macOSComputerInputFingerprint(files, settings), original)
  for (const change of [{ plist: 'v2' }, { architectures: ['arm64', 'x86_64'] }, { flags: ['-Onone'] }, { signingIdentity: 'certificate-fixture' }, { tools: ['swift-2'] }, { environment: { SDKROOT: '/sdk/2' } }]) {
    assert.notEqual(await macOSComputerInputFingerprint(files, { ...settings, ...change }), original)
  }
  await writeFile(f.binary, 'new native source fixture')
  assert.notEqual(await macOSComputerInputFingerprint(files, settings), original)
  await writeFile(f.binary, 'synthetic fixture; never executed')
  await writeFile(f.icon, 'new artwork fixture')
  assert.notEqual(await macOSComputerInputFingerprint(files, settings), original)
})
