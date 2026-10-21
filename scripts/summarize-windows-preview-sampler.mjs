/** Test-only derived evidence. Never changes the original native report. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

for (const directory of process.argv.slice(2)) {
  const reportPath = join(directory, 'report.json')
  const bytes = await readFile(reportPath)
  const reportHash = createHash('sha256').update(bytes).digest('hex')
  const report = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''))
  const path = join(directory, 'acceptance-summary.json')
  const summary = JSON.parse(await readFile(path, 'utf8'))
  assert.ok(Array.isArray(report.unverified) && report.unverified.every(value => typeof value === 'string'))
  assert.ok(report.unverified.includes('physical HID click on own preview during drag'))
  const keyboardChecks = ['WIN-PHYSICAL-RUNNER-01', 'WIN-PHYSICAL-ESCAPE-DRAG-01', 'WIN-PHYSICAL-HUMAN-EVENT-01', 'WIN-PHYSICAL-MOUSE-RELEASE-01']
  assert.equal(report.passed, true)
  assert.ok(keyboardChecks.every(id => report.checks.some(check => check.id === id && check.passed === true)), 'Original physical-Escape checks must actually pass')
  const checkpoint = JSON.parse((await readFile(join(directory, 'physical-owner-guard.json'), 'utf8')).replace(/^\uFEFF/u, ''))
  assert.equal(checkpoint.foreground, checkpoint.expectedWindow)
  assert.equal(checkpoint.owner, checkpoint.journalOwner)
  assert.equal(checkpoint.held.length, 0)
  // The old property name incorrectly suggested that the unverified entries
  // were covered. Keep the original report's explicit status in the summary.
  delete summary.coverage
  summary.unverified = [...report.unverified]
  summary.verifiedPhysicalHid = {
    input: 'single VM-specific Escape keyboard event',
    exactOwnerCheckpointMatched: true,
    source: 'prlctl send-key-event; original native physical-Escape checks',
  }
  summary.physicalPreviewMouseClick = {
    verified: false,
    boundary: 'A physical Escape keyboard event does not verify a physical HID mouse click on the preview during drag.',
  }
  await writeFile(path, JSON.stringify(summary, null, 2) + '\n')
  assert.equal(createHash('sha256').update(await readFile(reportPath)).digest('hex'), reportHash, 'The original report changed')
  console.log(JSON.stringify({ directory, reportUnchanged: true, unverified: summary.unverified, physicalPreviewMouseClickVerified: false }))
}
