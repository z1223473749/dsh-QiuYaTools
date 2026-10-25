import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { hasVisibleMacPreviewFrame, waitForOwnedMacPreview } from './fixtures/harness-preview-readiness.mjs';
const fixture = JSON.parse(await readFile(new URL('./fixtures/macos-preview-readonly-ax-samples.json', import.meta.url)));
const source = await readFile(new URL('./fixtures/harness-preview-macos.swift', import.meta.url), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
test('actual pixel-positive but AX-incomplete observations still reject; original and read-only-hit complete samples pass', () => {
  assert.equal(fixture.samples.oldFailed.length, 3);
  for (const sample of fixture.samples.oldFailed) {
    assert(sample.recognizedText.some(text => /\d+\s*ms/u.test(text)));
    assert.equal(hasVisibleMacPreviewFrame(sample), false);
  }
  assert.equal(hasVisibleMacPreviewFrame(fixture.samples.oldPassed[0]), true);
  const current = fixture.samples.currentReadOnlyHit[0];
  assert.equal(hasVisibleMacPreviewFrame(current), true);
  const { firstVisit, lastVisit, globalHitProbe } = current.axReadEvidence;
  assert.equal(firstVisit.pauseFoundByOriginalNamedPredicate, false);
  assert.equal(firstVisit.nodeCount, 7);
  assert.equal(lastVisit.pauseFoundByOriginalNamedPredicate, true);
  assert.equal(lastVisit.nodeCount, 25);
  for (const key of ['authenticatedOwnHit', 'identityBeforeAfterValidated', 'sameExpectedPID', 'sameExpectedAXWindow']) assert.equal(globalHitProbe[key], true);
  assert.equal(globalHitProbe.inputEventsPosted, 0);
  assert.equal(globalHitProbe.ownershipGranted, false);
});
test('all original labels, actual canvas dimensions and successful visible latency remain mandatory', () => {
  const ready = { labels: ['暂停', '接管', '继续', '停止', '实时电脑画面'], canvas: { width: 640, height: 358 }, recognizedText: ['44 ms'] };
  assert.equal(hasVisibleMacPreviewFrame(ready), true);
  for (const label of ready.labels) assert.equal(hasVisibleMacPreviewFrame({ ...ready, labels: ready.labels.filter(value => value !== label) }), false);
  for (const canvas of [undefined, { width: 0, height: 358 }, { width: 640, height: 0 }, { width: NaN, height: 358 }]) assert.equal(hasVisibleMacPreviewFrame({ ...ready, canvas }), false);
  assert.equal(hasVisibleMacPreviewFrame({ ...ready, recognizedText: ['waiting'] }), false);
});
test('rejected AX evidence cannot become a fabricated ready acknowledgement at the existing deadline', async () => {
  let reads = 0, attempts = 0;
  await assert.rejects(waitForOwnedMacPreview(async () => { reads++; return { labels: [], recognizedText: ['56 ms'] }; }, { timeoutMs: 0, onAttempt: () => attempts++ }), /did not expose/u);
  assert.equal(reads, 1); assert.equal(attempts, 1);
});
test('existing input, physical route and original traversal are byte exact, and the public source keeps its build placeholder', () => {
  for (const [start, pin] of Object.entries(fixture.inputSlices)) {
    const end = start === 'private func visit(' ? 'private func observedVisit(' : pin.end;
    const value = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
    assert.equal(Buffer.byteLength(value), pin.bytes);
    assert.equal(sha(value), pin.sha256);
  }
  assert.equal(sha(source), fixture.afterSwiftSHA256);
  assert.match(source, /guard digest == "0{64}"/u);
  assert.match(source, /nodes\(allowReadOnlyProbe: op == "observe"\)/u);
  assert.match(source, /attempt == 0 && !pauseFound && allowReadOnlyProbe/u);
});
test('the additional getter stays exact-owned, read-only and bounded without replacing the original readiness policy', async () => {
  const observed = source.slice(source.indexOf('private func observedVisit('), source.indexOf('private func axWindow('));
  const hit = source.slice(source.indexOf('    private func readonlyAXHit('), source.indexOf('    func physicalHit('));
  assert.doesNotMatch(observed + hit, /CGEvent\(|\.post\(tap:|\.postToPid\(|AXUIElementPerformAction\(|AXUIElementSetAttributeValue\(|\.activate\(/u);
  for (const pattern of [/guard depth < 16/u, /guard values.count < 600/u, /addingTimeInterval\(1\.5\)/u, /seen.insert\(hash\).inserted/u, /!CFEqual\(prior, node\)/u, /readRows.count < 16/u]) assert.match(observed, pattern);
  assert.equal((hit.match(/try validate\(\)/gu) ?? []).length, 2);
  assert.match(hit, /CFEqual\(\$0, expectedWindow\)/u);
  assert.match(hit, /if ownHit, let element = hit.element/u);
  assert.match(hit, /ownershipGranted": false/u);
  assert.match(source, /for attempt in 0\.\.<60/u); assert.match(source, /50_000_000/u);
  assert.equal(sha(await readFile(new URL('./fixtures/harness-preview-readiness.mjs', import.meta.url))), 'f8b91c8a8b07b80be1d6f3e5d828eb5acb82eb251a5afab77e69da18a2f3fe80');
});
