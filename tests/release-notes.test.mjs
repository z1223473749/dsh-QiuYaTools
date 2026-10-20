import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { extractReleaseNotes } from '../scripts/release-notes.mjs'

test('release notes select the exact version and preserve its Chinese sections only', () => {
  const source = '# 更新记录\r\n\r\n## 0.5.1\r\n较新版本\r\n## 0.5.0\r\n\r\n### 新功能\r\n\r\n- 按 Tab 填入。\r\n\r\n### 使用提醒\r\n\r\n- 完全退出并重开。\r\n\r\n## 0.4.1\r\n旧版本\r\n'
  assert.equal(extractReleaseNotes(source, '0.5.0'), '### 新功能\n\n- 按 Tab 填入。\n\n### 使用提醒\n\n- 完全退出并重开。\n')
  assert.throws(() => extractReleaseNotes(source, '0.5.01'), /Missing/)
})

test('a missing, empty, duplicate or invalid version fails instead of using other notes', () => {
  assert.throws(() => extractReleaseNotes('## 0.4.1\n旧版本', '0.5.0'), /Missing/)
  assert.throws(() => extractReleaseNotes('## 0.5.0\n \n## 0.4.1\n旧版本', '0.5.0'), /Empty/)
  assert.throws(() => extractReleaseNotes('## 0.5.0\n一\n## 0.5.0\n二', '0.5.0'), /Duplicate/)
  assert.throws(() => extractReleaseNotes('## 0.5.0\n内容', '0.5.0\n## 0.4.1'), /Invalid/)
})

test('version headings inside code examples cannot truncate or fabricate release sections', () => {
  const notes = '说明\n\n```md\n## 0.4.1\n```\n\n~~~\n## 0.6.0\n~~~\n\n- 新功能。'
  assert.equal(extractReleaseNotes(`## 0.5.0\n${notes}\n## 0.4.1\n旧版本`, '0.5.0'), `${notes}\n`)
  assert.throws(() => extractReleaseNotes('```md\n## 0.5.0\n伪标题\n```', '0.5.0'), /Missing/)
})

test('CLI writes only package version notes and exits unsuccessfully without output when they are missing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qiuya-release-notes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'scripts'))
  const script = join(root, 'scripts/release-notes.mjs')
  await copyFile(new URL('../scripts/release-notes.mjs', import.meta.url), script)
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.5.0' }))
  await writeFile(join(root, 'CHANGELOG.md'), '## 0.5.0\n\n- 中文发布说明。\n\n## 0.4.1\n旧版')
  const output = join(root, 'notes.md')
  const success = spawnSync(process.execPath, [script, output], { encoding: 'utf8' })
  assert.equal(success.status, 0, success.stderr)
  assert.equal(await readFile(output, 'utf8'), '- 中文发布说明。\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.6.0' }))
  const absent = join(root, 'missing.md')
  const failed = spawnSync(process.execPath, [script, absent], { encoding: 'utf8' })
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /Missing changelog section for 0\.6\.0/)
  await assert.rejects(readFile(absent), { code: 'ENOENT' })
})

test('publish workflow requires the checked-in version notes before building and passes them to GitHub', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.ok(workflow.indexOf('node scripts/release-notes.mjs') < workflow.indexOf('npm run check'))
  assert.match(workflow, /--notes-file "\$RUNNER_TEMP\/qiuya-release-notes\.md"/)
  assert.equal(workflow.includes('--generate-notes'), false)
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  assert.ok(extractReleaseNotes(changelog, version).trim())
  const notes = extractReleaseNotes(changelog, '0.5.0')
  assert.match(notes, /Tab/)
  assert.match(notes, /额外模型用量/)
  assert.match(notes, /完全退出并重新打开 Harness/)
})
