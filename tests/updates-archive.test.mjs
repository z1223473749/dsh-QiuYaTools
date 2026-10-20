import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'

const root = new URL('../', import.meta.url)
const source = (await build({
  entryPoints: [new URL('src/updates/archive.ts', root).pathname],
  bundle: true, write: false, platform: 'node', format: 'esm',
})).outputFiles[0].text
const { validateUpdateArchive } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const options = { packageName: 'dsh-qiuya-tools', version: '0.2.3', architecture: 'arm64' }
const helperPath = 'package/lib/QiuYaTools Sessions.app/Contents/MacOS/qiuya-session-window'

function octal(header, offset, width, value) {
  header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii')
}

function checksum(header) {
  header.fill(32, 148, 156)
  octal(header, 148, 8, header.reduce((total, byte) => total + byte, 0))
  return header
}

function entry(path, content = '', { type = '0', mode = 0o644, link = '', declaredSize, prefix = '' } = {}) {
  const data = Buffer.from(content)
  const header = Buffer.alloc(512)
  assert.ok(Buffer.byteLength(path) <= 100)
  header.write(path, 0, 100)
  octal(header, 100, 8, mode)
  octal(header, 108, 8, 0)
  octal(header, 116, 8, 0)
  octal(header, 124, 12, declaredSize ?? data.length)
  octal(header, 136, 12, 0)
  header.write(type, 156, 1, 'ascii')
  header.write(link, 157, 100)
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  header.write(prefix, 345, 155)
  checksum(header)
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)])
}

function paxRecord(key, value) {
  const body = `${key}=${value}\n`
  let length = Buffer.byteLength(body) + 2
  while (length !== Buffer.byteLength(body) + String(length).length + 1) length = Buffer.byteLength(body) + String(length).length + 1
  return `${length} ${body}`
}

function thin(cpu = 0x0100000c) {
  const bytes = Buffer.alloc(56)
  bytes.writeUInt32LE(0xfeedfacf, 0)
  bytes.writeUInt32LE(cpu, 4)
  bytes.writeUInt32LE(2, 12)
  bytes.writeUInt32LE(1, 16)
  bytes.writeUInt32LE(24, 20)
  bytes.writeUInt32LE(0x1b, 32)
  bytes.writeUInt32LE(24, 36)
  return bytes
}

function universal() {
  const arm = thin()
  const intel = thin(0x01000007)
  const header = Buffer.alloc(48)
  header.writeUInt32BE(0xcafebabe, 0)
  header.writeUInt32BE(2, 4)
  for (const [index, cpu, offset, size] of [[0, 0x0100000c, 48, arm.length], [1, 0x01000007, 48 + arm.length, intel.length]]) {
    const row = 8 + index * 20
    header.writeUInt32BE(cpu, row)
    header.writeUInt32BE(offset, row + 8)
    header.writeUInt32BE(size, row + 12)
    header.writeUInt32BE(2, row + 16)
  }
  return Buffer.concat([header, arm, intel])
}

function fixture({ manifest = {}, helper = thin(), extra = [], helperMode = 0o755, patches = true } = {}) {
  return [
    entry('package/package.json', JSON.stringify({ name: options.packageName, version: options.version, dsh: { bundle: { patch: './cordis.patch.yml' } }, ...manifest })),
    ...(patches ? [entry('package/cordis.patch.yml', '- insert: []\n')] : []),
    entry(helperPath, helper, { mode: helperMode }),
    ...extra,
  ]
}

function archive(entries) {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))
}

test('validates package identity, bundle patch and native arm64/universal helpers', () => {
  const metadata = validateUpdateArchive(archive(fixture()), options)
  assert.equal(metadata.packageName, options.packageName)
  assert.equal(metadata.version, options.version)
  assert.deepEqual(metadata.architectures, ['arm64'])
  assert.ok(metadata.files.includes(helperPath))
  assert.ok(metadata.unpackedBytes > 56)
  const bytes = archive(fixture({ helper: universal() }))
  assert.deepEqual(validateUpdateArchive(bytes, options).architectures, ['arm64', 'x64'])
  assert.deepEqual(validateUpdateArchive(bytes, { ...options, architecture: 'x64' }).architectures, ['arm64', 'x64'])
})

test('supports npm PAX long UTF-8 paths and USTAR prefixes', () => {
  const path = `package/lib/${'长路径'.repeat(35)}/entry.js`
  const bytes = archive(fixture({ extra: [
    entry('PaxHeader/entry', paxRecord('path', path) + paxRecord('mtime', '1.25') + paxRecord('size', '9'), { type: 'x' }),
    entry('placeholder', 'export {}', { declaredSize: 1 }),
    entry('nested.js', 'export {}', { prefix: 'package/lib' }),
  ] }))
  const metadata = validateUpdateArchive(bytes, options)
  assert.ok(metadata.files.includes(path))
  assert.ok(metadata.files.includes('package/lib/nested.js'))
})

test('rejects traversal, absolute paths, backslashes and files outside package', () => {
  for (const path of ['package/../escape', '../escape', '/package/escape', 'package//escape', 'package/./escape', 'package\\escape', 'C:/package/escape', 'other/escape']) {
    assert.throws(() => validateUpdateArchive(archive(fixture({ extra: [entry(path)] })), options), /Invalid update archive/)
  }
  for (const path of ['../escape', '/package/escape']) {
    const extra = [entry('PaxHeader/entry', paxRecord('path', path), { type: 'x' }), entry('placeholder')]
    assert.throws(() => validateUpdateArchive(archive(fixture({ extra })), options), /Invalid update archive/)
  }
  const overridden = [entry('PaxHeader/entry', paxRecord('path', 'package/safe'), { type: 'x' }), entry('../escape')]
  assert.throws(() => validateUpdateArchive(archive(fixture({ extra: overridden })), options), /unsafe tar path/)
})

test('rejects links, devices, unsupported PAX metadata and ambiguous files', () => {
  for (const type of ['1', '2', '3', '4', '6', '7', 'L', 'K']) {
    assert.throws(() => validateUpdateArchive(archive(fixture({ extra: [entry('package/bad', '', { type })] })), options), /unsupported tar entry type/)
  }
  assert.throws(() => validateUpdateArchive(archive(fixture({ extra: [entry('package/bad', '', { link: '/outside' })] })), options), /links are not allowed/)
  assert.throws(() => validateUpdateArchive(archive(fixture({ extra: [entry('package/cordis.patch.yml')] })), options), /duplicate tar entry/)
  assert.throws(() => validateUpdateArchive(archive(fixture({ extra: [entry('package/PACKAGE.JSON')] })), options), /duplicate tar entry/)
  assert.throws(() => validateUpdateArchive(archive(fixture({ extra: [entry('package/café'), entry('package/cafe\u0301')] })), options), /duplicate tar entry/)
  assert.throws(() => validateUpdateArchive(archive(fixture({ extra: [entry('package/file'), entry('package/file/child')] })), options), /conflicts with a directory/)
  assert.throws(() => validateUpdateArchive(archive(fixture({ extra: [entry('package/file/child'), entry('package/file')] })), options), /conflicts with a directory/)
  for (const key of ['linkpath', 'GNU.sparse.map', 'SCHILY.xattr.user.test']) {
    const extra = [entry('PaxHeader/entry', paxRecord(key, 'value'), { type: 'x' }), entry('package/extra')]
    assert.throws(() => validateUpdateArchive(archive(fixture({ extra })), options), /unsupported PAX metadata/)
  }
  assert.throws(() => validateUpdateArchive(archive(fixture({ extra: [entry('PaxHeader/global', paxRecord('path', 'package/extra'), { type: 'g' })] })), options), /global PAX/)
})

test('rejects mismatched names, versions, missing bundle patches and unsafe patch paths', () => {
  for (const manifest of [{ name: 'other-plugin' }, { version: '9.9.9' }, { dsh: {} }, { dsh: { bundle: { patch: '../outside.yml' } } }]) {
    assert.throws(() => validateUpdateArchive(archive(fixture({ manifest })), options), /Invalid update archive/)
  }
  assert.throws(() => validateUpdateArchive(archive(fixture({ patches: false })), options), /missing bundle patch/)
  assert.throws(() => validateUpdateArchive(archive(fixture({ helperMode: 0o644 })), options), /missing executable native helper/)
})

test('rejects invalid, truncated, incompatible and inconsistent Mach-O helpers', () => {
  assert.throws(() => validateUpdateArchive(archive(fixture()), { ...options, architecture: 'x64' }), /does not support this architecture/)
  for (const helper of [Buffer.from('not native'), thin().subarray(0, 40), thin(7)]) {
    assert.throws(() => validateUpdateArchive(archive(fixture({ helper })), options), /Invalid update archive/)
  }
  const badFat = universal()
  badFat.writeUInt32BE(0x01000007, 8)
  assert.throws(() => validateUpdateArchive(archive(fixture({ helper: badFat })), options), /architecture mismatch/)
  const overlap = universal()
  overlap.writeUInt32BE(48, 36)
  assert.throws(() => validateUpdateArchive(archive(fixture({ helper: overlap })), options), /universal helper slice/)
})

test('rejects malformed checksums, truncation, oversized entries and trailing archives', () => {
  assert.throws(() => validateUpdateArchive(Buffer.from('not gzip'), options), /gzip/)
  const badChecksum = fixture()
  badChecksum[0][0] ^= 1
  assert.throws(() => validateUpdateArchive(archive(badChecksum), options), /checksum/)
  assert.throws(() => validateUpdateArchive(gzipSync(Buffer.alloc(513)), options), /truncated tar/)
  assert.throws(() => validateUpdateArchive(gzipSync(Buffer.concat(fixture())), options), /missing tar ending/)
  assert.throws(() => validateUpdateArchive(archive(fixture({ extra: [entry('package/big', '', { declaredSize: 256 * 1024 * 1024 + 1 })] })), options), /exceeds the limit/)
  const trailing = Buffer.concat([...fixture(), Buffer.alloc(1024), entry('package/after-end'), Buffer.alloc(1024)])
  assert.throws(() => validateUpdateArchive(gzipSync(trailing), options), /tar ending/)
  assert.throws(() => validateUpdateArchive(archive(Array.from({ length: 10_001 }, (_, index) => entry(`package/item-${index}`))), options), /too many tar entries/)
})

test('validates the actual prebuilt npm package when the local release fixture is available', async t => {
  let bytes
  try { bytes = await readFile(new URL('artifacts/dsh-qiuya-tools-0.2.3.tgz', root)) }
  catch (error) {
    if (error.code === 'ENOENT') { t.skip('local release fixture is not checked in'); return }
    throw error
  }
  const metadata = validateUpdateArchive(bytes, options)
  assert.ok(metadata.files.includes(helperPath))
})
