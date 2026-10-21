import test from 'node:test'
import assert from 'node:assert/strict'
import { validProbeIdentity, sameProbeIdentity } from '../scripts/prepare-wk-association-probe.mjs'
const row = { pid: 123, birthMicros: '1792565870288079', uniqueId: '1842062', path: '/own/helper' }

test('WK probe association requires a complete exact process identity before adopting even a reported PID', () => {
  assert.equal(validProbeIdentity(row), true)
  for (const value of [null, {}, { ...row, pid: -1 }, { ...row, pid: 2147483648 }, { ...row, birthMicros: 1792565870288079 }, { ...row, uniqueId: '0' }, { ...row, path: 'relative/helper' }, { ...row, path: '/own/\0helper' }]) assert.equal(validProbeIdentity(value), false)
  assert.equal(sameProbeIdentity({}, {}), false, 'Two incomplete responses cannot match on undefined fields')
})
test('WK probe raw protocol identity remains pinned across independent reads; canonical executable checks stay separate', () => {
  assert.equal(sameProbeIdentity(row, { ...row, ignored: true }), true)
  for (const change of [{ pid: 124 }, { birthMicros: '1792565870288080' }, { uniqueId: '1842063' }, { path: '/other/helper' }, { path: '/tmp/helper' }, { path: '/private/tmp/helper' }]) assert.equal(sameProbeIdentity(row, { ...row, ...change }), false)
  assert.equal(sameProbeIdentity({ ...row, path: '/tmp/helper' }, { ...row, path: '/private/tmp/helper' }), false, 'Do not normalize raw identities supplied back to the independent OS oracle')
})
