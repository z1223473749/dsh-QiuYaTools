import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'esbuild'

const compiled = await build({ entryPoints: ['src/features/git/service.ts'], bundle: true, write: false, format: 'esm', platform: 'node' })
const { GitService, parseGitHunks } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'))
const exec = promisify(execFile)
async function fixture(seed = { 'file.txt': 'one\ntwo\nthree\n' }) {
  const directory = await mkdtemp(join(tmpdir(), 'qyt-git-test-')), repo = join(directory, 'repo'), storage = join(directory, 'storage')
  await mkdir(repo)
  const git = async (...args) => (await exec('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo })).stdout
  await git('init', '-b', 'main'); await git('config', 'user.email', 'fixture@example.invalid'); await git('config', 'user.name', 'Git Fixture')
  for (const [path, text] of Object.entries(seed)) { await mkdir(join(repo, path, '..'), { recursive: true }); await writeFile(join(repo, path), text) }
  if (Object.keys(seed).length) { await git('add', '.'); await git('commit', '-m', 'initial') }
  const service = new GitService({ directory: storage }), control = { started: false, running: false, valid: true, idle: true }, abort = new AbortController()
  const context = () => ({ sessionId: 'chat-a', cwd: repo, started: control.started, running: control.running, signal: abort.signal, assertCurrent() { if (!control.valid) throw Error('Owner changed') }, async assertIdle() { if (!control.idle) throw Error('Other agent running') } })
  const call = (op, extra = {}) => service.execute(context(), { op, sessionId: 'chat-a', ...extra })
  return { directory, repo, storage, git, service, control, abort, context, call, async close() { service.dispose(); await rm(directory, { recursive: true, force: true }) } }
}
test('working status counts HEAD to worktree net changes once, including untracked and ignoring ignored files', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.repo, 'file.txt'), 'ONE\ntwo\nthree\n'); await f.git('add', 'file.txt')
    await writeFile(join(f.repo, 'file.txt'), 'ONE\nTWO\nthree\n'); await writeFile(join(f.repo, 'new.txt'), 'new\nline\n')
    await writeFile(join(f.repo, '.git', 'info', 'exclude'), 'ignored.txt\n'); await writeFile(join(f.repo, 'ignored.txt'), 'ignored\n')
    const value = await f.call('status')
    assert.equal(value.available, true); assert.equal(value.repoName, 'repo'); assert.equal(value.branch, 'main')
    assert.equal(value.fileCount, 2); assert.equal(value.added, 4); assert.equal(value.deleted, 2)
    assert.equal(value.files.find(x => x.path === 'file.txt').staged, true); assert.equal(value.files.find(x => x.path === 'file.txt').unstaged, true)
    const staged = await f.call('status', { scope: 'staged' }); assert.equal(staged.added, 1); assert.equal(staged.deleted, 1)
    const unstaged = await f.call('status', { scope: 'unstaged' }); assert.equal(unstaged.added, 3); assert.equal(unstaged.deleted, 1)
  } finally { await f.close() }
})
test('diff returns hunk line numbers and per-scope content, with literal special filenames', async () => {
  const f = await fixture({ '中文 file\t.txt': 'before\n' })
  try {
    await writeFile(join(f.repo, '中文 file\t.txt'), 'after\n'); const status = await f.call('status')
    assert.equal(status.files[0].path, '中文 file\t.txt')
    const diff = await f.call('diff', { path: status.files[0].path, expectedRevision: status.revision })
    assert.equal(diff.oldText, 'before\n'); assert.equal(diff.newText, 'after\n'); assert.equal(diff.hunks.length, 1)
    assert.deepEqual(diff.hunks[0], { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-before', '+after'] })
    await assert.rejects(f.call('diff', { path: '../outside' }), e => e.code === 'FILE_NOT_CHANGED')
  } finally { await f.close() }
})
test('branch changes become permanently locked after the first turn and persist after service restart', async () => {
  const f = await fixture()
  try {
    await f.call('status'); await f.call('createBranch', { branch: 'custom/name' }); assert.equal((await f.call('status')).branch, 'custom/name')
    f.control.started = true; await f.service.lock(f.context()); f.control.started = false
    await assert.rejects(f.call('selectBranch', { branch: 'main' }), e => e.code === 'BRANCH_LOCKED')
    f.service.dispose(); const resumed = new GitService({ directory: f.storage })
    try { await assert.rejects(resumed.execute(f.context(), { op: 'createBranch', sessionId: 'chat-a', branch: 'other' }), e => e.code === 'BRANCH_LOCKED') } finally { resumed.dispose() }
  } finally { await f.close() }
})
test('external branch switch is detected before writes and can restore the original binding', async () => {
  const f = await fixture()
  try {
    f.control.started = true; await f.call('status'); await f.git('switch', '-c', 'outside')
    assert.equal((await f.call('status')).bindingMismatch, true)
    await assert.rejects(f.service.checkBinding(f.context()), e => e.code === 'BRANCH_CHANGED')
    await assert.rejects(f.call('commit', { message: 'wrong branch' }), e => e.code === 'BRANCH_CHANGED')
    await f.call('restoreBinding'); assert.equal((await f.call('status')).branch, 'main'); assert.equal((await f.call('status')).locked, true)
  } finally { await f.close() }
})
test('dirty checkout is refused, custom branch can preserve current modifications, names validated', async () => {
  const f = await fixture()
  try {
    await f.git('branch', 'target'); await writeFile(join(f.repo, 'file.txt'), 'modified\n')
    await assert.rejects(f.call('selectBranch', { branch: 'target' }), e => e.code === 'DIRTY_WORKTREE')
    for (const branch of ['--detach', 'bad..name', 'HEAD', 'a b']) await assert.rejects(f.call('createBranch', { branch }), e => e.code === 'INVALID_BRANCH')
    await f.call('createBranch', { branch: 'my-feature' }); assert.equal(await readFile(join(f.repo, 'file.txt'), 'utf8'), 'modified\n')
    await assert.rejects(f.call('createBranch', { branch: 'my-feature' }), e => e.code === 'BRANCH_EXISTS')
  } finally { await f.close() }
})
test('staging, unstaging, committing, and stale revisions preserve unrelated files', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.repo, 'file.txt'), 'changed\n'); await writeFile(join(f.repo, 'other.txt'), 'other\n')
    const before = await f.call('status'); await f.call('stage', { paths: ['file.txt'], expectedRevision: before.revision })
    await assert.rejects(f.call('stage', { paths: ['other.txt'], expectedRevision: before.revision }), e => e.code === 'STALE_STATE')
    await f.call('unstage', { paths: ['file.txt'] }); assert.equal((await f.call('status', { scope: 'staged' })).files.length, 0)
    await f.call('stage', { paths: ['file.txt'] }); await f.call('commit', { message: 'just file' })
    assert.deepEqual((await f.call('status')).files.map(x => x.path), ['other.txt'])
    await assert.rejects(f.call('stage', { paths: ['../outside'] }), e => e.code === 'INVALID_PATH')
    f.control.idle = false; await assert.rejects(f.call('stage', { paths: ['other.txt'] }), /Other agent running/u)
  } finally { await f.close() }
})
test('renames, binary changes, and deleted files retain correct paths and counts', async () => {
  const f = await fixture({ 'old.txt': 'alpha\nbeta\n', 'binary.bin': Buffer.from([0, 1, 2]), 'gone.txt': 'gone\n' })
  try {
    await rename(join(f.repo, 'old.txt'), join(f.repo, 'renamed.txt')); await writeFile(join(f.repo, 'binary.bin'), Buffer.from([0, 4, 5])); await rm(join(f.repo, 'gone.txt'))
    await f.git('add', '-A'); const status = await f.call('status')
    const renamed = status.files.find(x => x.path === 'renamed.txt'); assert.equal(renamed.status, 'renamed'); assert.equal(renamed.oldPath, 'old.txt'); assert.equal(renamed.added, 0)
    assert.equal(status.files.find(x => x.path === 'binary.bin').binary, true)
    const deleted = await f.call('diff', { path: 'gone.txt' }); assert.equal(deleted.oldText, 'gone\n'); assert.equal(deleted.newText, null)
  } finally { await f.close() }
})
test('branch comparison uses merge base and excludes working modifications', async () => {
  const f = await fixture()
  try {
    await f.call('createBranch', { branch: 'feature' }); await writeFile(join(f.repo, 'file.txt'), 'feature\n'); await f.git('add', '.'); await f.git('commit', '-m', 'feature')
    await writeFile(join(f.repo, 'uncommitted.txt'), 'outside comparison\n')
    const branch = await f.call('status', { scope: 'branch', target: 'main' }); assert.equal(branch.fileCount, 1); assert.equal(branch.added, 1); assert.equal(branch.deleted, 3)
    const diff = await f.call('diff', { scope: 'branch', target: 'main', path: 'file.txt' }); assert.equal(diff.newText, 'feature\n')
  } finally { await f.close() }
})
test('unborn repos support working statistics and unstage without deleting files', async () => {
  const f = await fixture({})
  try {
    await writeFile(join(f.repo, 'first.txt'), 'first\n'); assert.equal((await f.call('status')).added, 1)
    await f.call('stage', { paths: ['first.txt'] }); assert.equal((await f.call('status', { scope: 'staged' })).added, 1)
    await f.call('unstage', { paths: ['first.txt'] }); assert.equal(await readFile(join(f.repo, 'first.txt'), 'utf8'), 'first\n')
  } finally { await f.close() }
})
test('new worktrees leave source modifications and branch unchanged', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.repo, 'file.txt'), 'source dirty\n'); const created = await f.call('createWorktree', { branch: 'parallel/custom' })
    assert.ok(created.worktreePath.startsWith(await realpath(join(f.storage, 'worktrees')))); assert.equal(created.worktreePath, await realpath(created.worktreePath)); assert.equal(created.branch, 'parallel/custom')
    assert.equal(await readFile(join(created.worktreePath, 'file.txt'), 'utf8'), 'one\ntwo\nthree\n'); assert.equal((await f.call('status')).branch, 'main')
  } finally { await f.close() }
})
test('symlink targets are rendered as link text, never external file contents', async () => {
  const f = await fixture()
  try {
    const outside = join(f.directory, 'private.txt'); await writeFile(outside, 'PRIVATE CONTENTS\n'); await symlink(outside, join(f.repo, 'link'))
    const diff = await f.call('diff', { path: 'link' }); assert.equal(diff.newText, outside); assert.ok(!diff.patch.includes('PRIVATE CONTENTS')); assert.equal(diff.file.kind, 'symlink')
  } finally { await f.close() }
})
test('non repositories report unavailable rather than zero successful Git statistics', async () => {
  const f = await fixture()
  try { const value = await f.service.execute({ ...f.context(), cwd: f.directory }, { op: 'status', sessionId: 'chat-a' }); assert.equal(value.available, false); assert.ok(value.reason) } finally { await f.close() }
})
test('hunk parser preserves explicit zero ranges and no-newline markers', () => { assert.deepEqual(parseGitHunks('@@ -0,0 +1,1 @@\n+new\n\\ No newline at end of file\n'), [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new', '\\ No newline at end of file'] }]) })
test('revision changes when file contents change without changing line counts or length', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.repo, 'file.txt'), 'first\n'); const before = await f.call('status')
    await writeFile(join(f.repo, 'file.txt'), 'other\n'); const after = await f.call('status')
    assert.equal(before.added, after.added); assert.equal(before.deleted, after.deleted); assert.notEqual(before.revision, after.revision)
    await assert.rejects(f.call('diff', { path: 'file.txt', expectedRevision: before.revision }), e => e.code === 'STALE_STATE')
  } finally { await f.close() }
})
test('large untracked text retains exact line statistics while limiting the text preview', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.repo, 'large.txt'), 'text\n'.repeat(220000))
    const status = await f.call('status'); assert.equal(status.added, 220000)
    const diff = await f.call('diff', { path: 'large.txt' }); assert.equal(diff.tooLarge, true); assert.equal(diff.newText, null); assert.equal(diff.patch, '')
  } finally { await f.close() }
})
test('push, fetch, fast-forward pull, and remote tracking selection operate on a real local bare remote', async () => {
  const f = await fixture()
  try {
    const remote = join(f.directory, 'remote.git'), peer = join(f.directory, 'peer')
    await exec('git', ['init', '--bare', remote]); await f.git('remote', 'add', 'origin', remote)
    await f.call('push'); assert.equal((await f.call('status')).upstream, 'origin/main')
    await exec('git', ['clone', '-b', 'main', remote, peer])
    const peerGit = async (...args) => (await exec('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', ...args], { cwd: peer })).stdout
    await writeFile(join(peer, 'remote.txt'), 'remote\n'); await peerGit('add', '.'); await peerGit('commit', '-m', 'remote'); await peerGit('push')
    await f.call('fetch'); assert.equal((await f.call('status')).behind, 1)
    await f.call('pull'); assert.equal(await readFile(join(f.repo, 'remote.txt'), 'utf8'), 'remote\n')
    await peerGit('switch', '-c', 'remote-topic'); await peerGit('push', '-u', 'origin', 'remote-topic'); await f.call('fetch')
    const branches = await f.call('branches'); assert.equal(branches.some(x => x.remote && x.name === 'origin/remote-topic'), true)
    await f.call('selectBranch', { branch: 'origin/remote-topic' }); assert.equal((await f.call('status')).branch, 'remote-topic')
    assert.equal((await f.call('status')).upstream, 'origin/remote-topic')
  } finally { await f.close() }
})
test('non fast-forward pull fails without changing or resetting the local branch', async () => {
  const f = await fixture()
  try {
    const remote = join(f.directory, 'remote.git'), peer = join(f.directory, 'peer')
    await exec('git', ['init', '--bare', remote]); await f.git('remote', 'add', 'origin', remote); await f.call('push')
    await exec('git', ['clone', '-b', 'main', remote, peer])
    await writeFile(join(peer, 'remote.txt'), 'remote\n'); await exec('git', ['add', '.'], { cwd: peer }); await exec('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', 'commit', '-m', 'remote'], { cwd: peer }); await exec('git', ['push'], { cwd: peer })
    await writeFile(join(f.repo, 'local.txt'), 'local\n'); await f.git('add', '.'); await f.git('commit', '-m', 'local')
    const before = (await f.call('status')).head
    await assert.rejects(f.call('pull'), e => e.code === 'GIT_CONFLICT')
    assert.equal((await f.call('status')).head, before); assert.equal(await readFile(join(f.repo, 'local.txt'), 'utf8'), 'local\n')
  } finally { await f.close() }
})
test('missing bound repositories fail checks while unrelated non-Git sessions remain usable', async () => {
  const f = await fixture()
  try {
    assert.equal(await f.service.hasBinding('chat-a'), false)
    await f.service.checkBinding({ ...f.context(), cwd: f.directory }); await f.service.lock({ ...f.context(), cwd: f.directory })
    await f.call('status'); assert.equal(await f.service.hasBinding('chat-a'), true)
    await rename(join(f.repo, '.git'), join(f.directory, 'moved-git'))
    await assert.rejects(f.service.checkBinding(f.context()), e => e.code === 'NOT_A_REPOSITORY')
  } finally { await f.close() }
})
test('unresolved conflicts appear once and preserve both staged and worktree state', async () => {
  const f = await fixture({ 'conflict.txt': 'base\n' })
  try {
    await f.git('switch', '-c', 'other'); await writeFile(join(f.repo, 'conflict.txt'), 'other\n'); await f.git('add', '.'); await f.git('commit', '-m', 'other')
    await f.git('switch', 'main'); await writeFile(join(f.repo, 'conflict.txt'), 'main\n'); await f.git('add', '.'); await f.git('commit', '-m', 'main')
    await assert.rejects(f.git('merge', 'other'))
    const status = await f.call('status'); assert.equal(status.fileCount, 1); assert.equal(status.files[0].status, 'conflicted')
    const diff = await f.call('diff', { path: 'conflict.txt' }); assert.match(diff.newText, /<<<<<<< HEAD/u)
    await assert.rejects(f.call('commit', { message: 'unresolved' })); assert.match(await readFile(join(f.repo, 'conflict.txt'), 'utf8'), /<<<<<<< HEAD/u)
  } finally { await f.close() }
})
test('index-only changes are available in staged view even when net worktree changes are zero', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.repo, 'file.txt'), 'staged\n'); await f.git('add', 'file.txt'); await writeFile(join(f.repo, 'file.txt'), 'one\ntwo\nthree\n')
    const status = await f.call('status'); assert.equal(status.fileCount, 0)
    const staged = await f.call('status', { scope: 'staged' }); assert.equal(staged.fileCount, 1)
    await f.call('unstage', { paths: ['file.txt'] }); assert.equal((await f.call('status', { scope: 'staged' })).fileCount, 0)
  } finally { await f.close() }
})
test('unstaging a rename restores both index paths without changing worktree files', async () => {
  const f = await fixture({ 'old.txt': 'keep\n' })
  try {
    await rename(join(f.repo, 'old.txt'), join(f.repo, 'new.txt')); await f.git('add', '-A')
    await f.call('unstage', { paths: ['new.txt'] })
    assert.equal((await f.call('status', { scope: 'staged' })).fileCount, 0)
    assert.equal(await readFile(join(f.repo, 'new.txt'), 'utf8'), 'keep\n')
  } finally { await f.close() }
})
test('the first turn starting during branch preparation prevents the final branch write', async () => {
  const f = await fixture()
  try {
    await f.call('status'); let started = false, calls = 0
    const context = { ...f.context(), get started() { return started }, async assertIdle() { if (++calls === 2) { await Promise.resolve(); started = true } } }
    await assert.rejects(f.service.execute(context, { op: 'createBranch', sessionId: 'chat-a', branch: 'too-late' }), e => e.code === 'BRANCH_LOCKED')
    assert.equal((await f.call('branches')).some(branch => branch.name === 'too-late'), false); assert.equal((await f.call('status')).branch, 'main')
  } finally { await f.close() }
})
test('a live agent starting during mutation preparation prevents index writes', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.repo, 'file.txt'), 'change\n'); let running = false, calls = 0
    const context = { ...f.context(), get running() { return running }, async assertIdle() { if (++calls === 2) { await Promise.resolve(); running = true } } }
    await assert.rejects(f.service.execute(context, { op: 'stage', sessionId: 'chat-a', paths: ['file.txt'] }), e => e.code === 'SESSION_BUSY')
    assert.equal((await f.call('status', { scope: 'staged' })).fileCount, 0)
  } finally { await f.close() }
})
test('an external branch switch during final preparation prevents staging onto the new branch', async () => {
  const f = await fixture()
  try {
    await f.call('status'); await writeFile(join(f.repo, 'file.txt'), 'change\n'); let calls = 0
    const context = { ...f.context(), async assertIdle() { if (++calls === 2) await f.git('switch', '-c', 'external') } }
    await assert.rejects(f.service.execute(context, { op: 'stage', sessionId: 'chat-a', paths: ['file.txt'] }), e => e.code === 'STALE_STATE')
    assert.equal((await f.git('diff', '--cached', '--name-only')).trim(), '')
  } finally { await f.close() }
})
test('remote worktree bases do not silently reuse a divergent local branch and establish tracking for matching new names', async () => {
  const f = await fixture()
  try {
    const remote = join(f.directory, 'remote.git'); await exec('git', ['init', '--bare', remote]); await f.git('remote', 'add', 'origin', remote)
    await f.git('branch', 'dev'); const oldDev = (await f.git('rev-parse', 'dev')).trim()
    await writeFile(join(f.repo, 'file.txt'), 'new remote version\n'); await f.git('add', '.'); await f.git('commit', '-m', 'remote base')
    await f.git('push', 'origin', 'main:dev', 'main:new-dev'); await f.call('fetch')
    await assert.rejects(f.call('createWorktree', { branch: 'dev', base: 'refs/remotes/origin/dev' }), e => e.code === 'BRANCH_CONFLICT')
    assert.equal((await f.git('rev-parse', 'dev')).trim(), oldDev)
    const created = await f.call('createWorktree', { branch: 'new-dev', base: 'refs/remotes/origin/new-dev' })
    const snapshot = await f.service.execute({ ...f.context(), sessionId: 'chat-worktree', cwd: created.worktreePath }, { op: 'status', sessionId: 'chat-worktree' })
    assert.equal(snapshot.branch, 'new-dev'); assert.equal(snapshot.upstream, 'origin/new-dev'); assert.equal(snapshot.mode, 'worktree'); assert.equal(snapshot.repoName, 'remote')
  } finally { await f.close() }
})
test('managed worktrees without remotes preserve the source repository name', async () => {
  const f = await fixture()
  try {
    const created = await f.call('createWorktree', { branch: 'new-worktree' })
    const snapshot = await f.service.execute({ ...f.context(), sessionId: 'chat-worktree', cwd: created.worktreePath }, { op: 'status', sessionId: 'chat-worktree' })
    assert.equal(snapshot.repoName, 'repo'); assert.equal(snapshot.mode, 'worktree')
  } finally { await f.close() }
})
test('recent commits use safe field boundaries, millisecond timestamps, and a twenty-commit limit', async () => {
  const f = await fixture()
  try {
    for (let i = 1; i <= 21; i++) await f.git('commit', '--allow-empty', '-m', `Record ${i}`)
    const log = await f.call('log'); assert.equal(log.length, 20); assert.equal(log[0].subject, 'Record 21'); assert.equal(log.at(-1).subject, 'Record 2')
    assert.match(log[0].hash, /^[a-f0-9]{40,64}$/u); assert.equal(log[0].author, 'Git Fixture'); assert.ok(log[0].at > 1_000_000_000_000)
    assert.equal(log[0].hash.startsWith(log[0].shortHash), true)
  } finally { await f.close() }
})
test('pre-step checks before a durable first turn do not permanently lock the branch', async () => {
  const f = await fixture()
  try {
    await f.service.checkBinding(f.context()); await f.service.lock(f.context())
    assert.equal((await f.call('status')).locked, false)
    await f.call('createBranch', { branch: 'still-configurable' })
    f.control.started = true; await f.service.lock(f.context())
    assert.equal((await f.call('status')).locked, true)
    await assert.rejects(f.call('createBranch', { branch: 'too-late' }), e => e.code === 'BRANCH_LOCKED')
  } finally { await f.close() }
})
