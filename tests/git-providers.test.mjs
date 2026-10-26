import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const directory = await mkdtemp(join(tmpdir(), 'qyt-git-providers-'))
await build({ entryPoints: [fileURLToPath(new URL('../src/features/git/providers.ts', import.meta.url))], bundle: true, outfile: join(directory, 'providers.mjs'), platform: 'node', format: 'esm' })
const { GitProviderClient, parseGitRemote, gitProviderCapabilities } = await import(pathToFileURL(join(directory, 'providers.mjs')).href)
test.after(() => rm(directory, { recursive: true, force: true }))
const signal = () => new AbortController().signal
const token = 'SYNTHETIC-PRIVATE-TOKEN'
const input = { title: 'Change title', body: 'First line\nSecond line', sourceBranch: 'feature/custom', targetBranch: 'main' }
function repo(provider) { return parseGitRemote(`git@${provider}.com:owner/project.git`) }
function pull(provider, changes = {}) { return provider === 'gitlab' ? { iid: 7, title: input.title, description: input.body, state: 'opened', source_branch: input.sourceBranch, target_branch: 'main', source_project_id: 1, target_project_id: 1, ...changes } : { number: 7, title: input.title, body: input.body, state: 'open', head: { ref: input.sourceBranch, repo: { full_name: 'owner/project' } }, base: { ref: 'main' }, ...changes } }
function fixture(provider, responses) {
  const calls = []
  const fetch = async (url, options) => {
    calls.push({ url, options })
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer')
    assert.ok(!url.includes(token)); assert.ok(!String(options.body).includes(token))
    const response = responses.shift()
    assert.notEqual(response, undefined, `Unexpected ${options.method} request`)
    if (response instanceof Error) throw response
    if (typeof response === 'function') return response(url, options)
    return response instanceof Response ? response : Response.json(response)
  }
  const client = new GitProviderClient(repo(provider), token, { fetch })
  return { client, calls }
}

test('Git remotes identify three public hosts, strip credentials and preserve GitLab subgroups', () => {
  assert.equal(parseGitRemote('git@github.com:owner/project.git').fullName, 'owner/project')
  assert.equal(parseGitRemote('ssh://git@gitee.com:22/owner/project.git').provider, 'gitee')
  const value = parseGitRemote('https://user:SYNTHETIC@gitlab.com/group/subgroup/repo.git')
  assert.equal(value.owner, 'group/subgroup'); assert.equal(value.fullName, 'group/subgroup/repo'); assert.equal(value.apiBase, 'https://gitlab.com/api/v4')
  assert.equal(value.webUrl, 'https://gitlab.com/group/subgroup/repo'); assert.ok(!JSON.stringify(value).includes('SYNTHETIC'))
  assert.equal(parseGitRemote('https://gitee.com/owner/project.git/').repository, 'project')
})

test('untrusted or ambiguous remote destinations are rejected', () => {
  for (const value of ['file:///tmp/repo', '/tmp/repo', 'http://github.com/owner/repo', 'https://github.com.evil.test/owner/repo', 'https://github.com:444/owner/repo', 'ssh://git@github.com:2222/owner/repo', 'https://github.com/owner/repo?q=token', 'https://github.com/owner/repo#fragment', 'git@github.com:owner/repo/other', 'git@gitlab.com:owner/../repo', 'git@gitlab.com:owner/repo\n', 'https://gitee.com/owner/repo%2fother', 'https://github.com/owner/space%20name']) assert.equal(parseGitRemote(value), undefined, value)
  assert.throws(() => new GitProviderClient({ ...repo('github'), apiBase: 'https://evil.test' }, token), { code: 'PR_INVALID_REPOSITORY' })
  assert.throws(() => new GitProviderClient(repo('github'), 'invalid\r\nHeader'), { code: 'PR_INVALID_CREDENTIAL' })
})

for (const provider of ['github', 'gitlab', 'gitee']) {
  test(provider + ' creates a PR/MR with explicit source, target, title, body and header-only credentials', async () => {
    const f = fixture(provider, [[], pull(provider, { draft: true })])
    const result = await f.client.create({ ...input, draft: true }, signal())
    assert.equal(result.number, 7); assert.equal(result.sourceBranch, input.sourceBranch); assert.equal(result.targetBranch, 'main'); assert.equal(result.draft, true); assert.equal(result.checkStatus, 'unknown')
    assert.equal(f.calls.length, 2); assert.equal(f.calls[0].options.method, 'GET'); assert.equal(f.calls[1].options.method, 'POST')
    const url = new URL(f.calls[0].url), request = f.calls[1]
    if (provider === 'gitlab') {
      assert.equal(url.pathname, '/api/v4/projects/owner%2Fproject/merge_requests'); assert.equal(url.searchParams.get('source_branch'), input.sourceBranch)
      assert.equal(request.options.headers['PRIVATE-TOKEN'], token)
      assert.deepEqual(JSON.parse(request.options.body), { title: 'Draft: Change title', description: input.body, source_branch: input.sourceBranch, target_branch: 'main' })
      assert.equal(result.url, 'https://gitlab.com/owner/project/-/merge_requests/7')
    } else {
      assert.equal(request.options.headers.Authorization, `Bearer ${token}`)
      const data = provider === 'gitee' ? Object.fromEntries(new URLSearchParams(request.options.body)) : JSON.parse(request.options.body)
      assert.equal(data.head, input.sourceBranch); assert.equal(data.base, 'main'); assert.equal(data.title, input.title); assert.equal(data.body, input.body); assert.equal(String(data.draft), 'true')
      assert.equal(url.searchParams.get('head'), provider === 'github' ? `owner:${input.sourceBranch}` : input.sourceBranch)
      assert.equal(result.url, `https://${provider}.com/owner/project/${provider === 'github' ? 'pull' : 'pulls'}/7`)
    }
  })

  test(provider + ' reuses an existing open PR instead of posting a duplicate', async () => {
    const f = fixture(provider, [[pull(provider)]])
    assert.equal((await f.client.create(input, signal())).number, 7)
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.method, 'GET')
  })

  test(provider + ' reconciles one uncertain create without sending a second POST', async () => {
    const f = fixture(provider, [[], new Error('PRIVATE network error ' + token), [pull(provider)]])
    assert.equal((await f.client.create(input, signal())).number, 7)
    assert.deepEqual(f.calls.map(call => call.options.method), ['GET', 'POST', 'GET'])
  })

  test(provider + ' reports an unconfirmed result after a lost create response and an empty reconciliation', async () => {
    const f = fixture(provider, [[], new Error('PRIVATE ' + token), []])
    await assert.rejects(f.client.create(input, signal()), error => { assert.equal(error.code, 'PR_UNCONFIRMED'); assert.ok(!error.message.includes(token)); assert.ok(!error.message.includes('PRIVATE')); return true })
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1)
  })

  test(provider + ' updates existing PR content using the correct API dialect', async () => {
    const changes = provider === 'gitlab' ? { title: 'Updated', description: '', target_branch: 'develop' } : { title: 'Updated', body: '', base: { ref: 'develop' } }
    const f = fixture(provider, [pull(provider, changes)])
    const fields = { title: 'Updated', body: '', ...(provider === 'gitee' ? {} : { targetBranch: 'develop' }) }
    const result = await f.client.update(7, fields, signal())
    assert.equal(result.title, 'Updated'); assert.equal(result.body, '')
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.method, provider === 'gitlab' ? 'PUT' : 'PATCH')
    const data = provider === 'gitee' ? Object.fromEntries(new URLSearchParams(f.calls[0].options.body)) : JSON.parse(f.calls[0].options.body)
    assert.deepEqual(data, provider === 'gitlab' ? { title: 'Updated', description: '', target_branch: 'develop' } : provider === 'github' ? { title: 'Updated', body: '', base: 'develop' } : { title: 'Updated', body: '' })
  })

  test(provider + ' keeps merged state separate from closed state', async () => {
    const f = fixture(provider, [[pull(provider, { state: 'closed', merged_at: '2026-10-26T00:00:00Z', html_url: 'https://evil.test/secret' })]])
    const [value] = await f.client.list(input.sourceBranch, signal())
    assert.equal(value.state, 'merged'); assert.ok(value.url.startsWith(`https://${provider}.com/owner/project/`)); assert.equal(value.checkStatus, 'unknown')
  })
}

test('provider capabilities expose Gitee retarget limitation and supported drafts', async () => {
  assert.deepEqual(gitProviderCapabilities(repo('gitee')), { draft: true, retarget: false })
  assert.deepEqual(gitProviderCapabilities(repo('github')), { draft: true, retarget: true })
  const f = fixture('gitee', [])
  await assert.rejects(f.client.update(7, { targetBranch: 'develop' }, signal()), { code: 'PR_RETARGET_UNSUPPORTED' })
  assert.equal(f.calls.length, 0)
})

test('same-name fork branches cannot reconcile to a PR from a different source repository', async () => {
  for (const provider of ['github', 'gitlab', 'gitee']) {
    const other = provider === 'gitlab' ? { source_project_id: 2, target_project_id: 1 } : { head: { ref: input.sourceBranch, repo: { full_name: 'other/project' } } }
    const f = fixture(provider, [[pull(provider, other)], pull(provider)])
    await f.client.create(input, signal())
    assert.deepEqual(f.calls.map(call => call.options.method), ['GET', 'POST'])
  }
})

test('GitLab maps actual pipeline statuses without inferring CI success from mergeability', async () => {
  for (const [status, expected] of [['success', 'success'], ['failed', 'failure'], ['running', 'pending'], ['skipped', 'unknown']]) {
    const f = fixture('gitlab', [[pull('gitlab', { head_pipeline: { status }, detailed_merge_status: 'mergeable' })]])
    assert.equal((await f.client.list(input.sourceBranch, signal()))[0].checkStatus, expected)
  }
})

test('authentication and rate-limit failures are finite and never expose server content', async () => {
  for (const [status, headers, code] of [[401, {}, 'PR_AUTH_REQUIRED'], [403, {}, 'PR_FORBIDDEN'], [403, { 'x-ratelimit-remaining': '0' }, 'PR_RATE_LIMITED'], [429, {}, 'PR_RATE_LIMITED'], [404, {}, 'PR_NOT_FOUND']]) {
    const f = fixture('github', [new Response('PRIVATE ' + token, { status, headers })])
    await assert.rejects(f.client.list(input.sourceBranch, signal()), error => { assert.equal(error.code, code); assert.ok(!error.message.includes(token)); return true })
  }
})

test('invalid creation inputs and missing write credentials do not initiate any HTTP request', async () => {
  const f = fixture('github', [])
  for (const fields of [{ title: '' }, { sourceBranch: 'main' }, { sourceBranch: '-unsafe' }, { targetBranch: 'bad..name' }, { body: '\0' }, { draft: 'yes' }]) await assert.rejects(f.client.create({ ...input, ...fields }, signal()))
  assert.equal(f.calls.length, 0)
  const client = new GitProviderClient(repo('github'), '', { fetch: async () => { assert.fail('No write credential must not send a request') } })
  await assert.rejects(client.create(input, signal()), { code: 'PR_AUTH_REQUIRED' })
})

test('malformed and oversized responses do not become successful PRs', async () => {
  for (const response of [new Response('{broken'), Response.json({}), Response.json([{}]), new Response('[]', { headers: { 'content-length': '999999999' } })]) {
    const f = fixture('github', [response])
    await assert.rejects(f.client.list(input.sourceBranch, signal()), error => ['PR_RESPONSE_INVALID', 'PR_RESPONSE_LIMIT'].includes(error.code))
  }
})

test('a lost update response is unconfirmed and is never retried automatically', async () => {
  const f = fixture('github', [new Error(token)])
  await assert.rejects(f.client.update(7, { body: 'Updated' }, signal()), { code: 'PR_UNCONFIRMED' })
  assert.equal(f.calls.length, 1)
})

test('a caller cancelled before an operation cannot send requests', async () => {
  const f = fixture('github', []), controller = new AbortController(); controller.abort()
  await assert.rejects(f.client.list(input.sourceBranch, controller.signal)); assert.equal(f.calls.length, 0)
})

test('cancellation bounds a transport that ignores its signal', { timeout: 1000 }, async () => {
  const controller = new AbortController()
  const client = new GitProviderClient(repo('github'), token, { fetch: () => new Promise(() => {}) })
  const pending = client.list(input.sourceBranch, controller.signal)
  controller.abort()
  await assert.rejects(pending, { code: 'PR_NETWORK' })
})

test('cancellation releases an incomplete response body without waiting for another chunk', { timeout: 1000 }, async () => {
  const controller = new AbortController(); let cancelled = 0
  const stream = new ReadableStream({ start(value) { value.enqueue(new TextEncoder().encode('[')) }, cancel() { cancelled++ } })
  const f = fixture('github', [new Response(stream)])
  const pending = f.client.list(input.sourceBranch, controller.signal)
  await new Promise(resolve => setImmediate(resolve)); controller.abort()
  await assert.rejects(pending, { code: 'PR_NETWORK' }); assert.equal(cancelled, 1)
})

test('actual streamed response size is bounded even when no content-length is supplied', async () => {
  let cancelled = 0
  const stream = new ReadableStream({ start(value) { value.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)) }, cancel() { cancelled++ } })
  const f = fixture('github', [new Response(stream)])
  await assert.rejects(f.client.list(input.sourceBranch, signal()), { code: 'PR_RESPONSE_LIMIT' }); assert.equal(cancelled, 1)
})

test('a caller cancelled after POST receives an uncertain outcome without resending', async () => {
  const controller = new AbortController(), f = fixture('github', [[], () => { controller.abort(); throw Error(token) }])
  await assert.rejects(f.client.create(input, controller.signal), { code: 'PR_UNCONFIRMED' })
  assert.deepEqual(f.calls.map(call => call.options.method), ['GET', 'POST'])
})

test('a validation race can discover the already-created PR without repeating creation', async () => {
  const f = fixture('github', [[], new Response('Already exists', { status: 422 }), [pull('github')]])
  assert.equal((await f.client.create(input, signal())).number, 7)
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1)
})

test('pagination stays on the fixed API origin and filters exact source branches', async () => {
  const page = Array.from({ length: 100 }, (_, index) => pull('github', { number: index + 1, state: 'closed' }))
  const f = fixture('github', [page, [pull('github', { number: 101, head: { ref: 'different' } })]])
  assert.equal((await f.client.list(input.sourceBranch, signal())).length, 100)
  assert.equal(f.calls.length, 2); assert.equal(new URL(f.calls[1].url).searchParams.get('page'), '2')
  assert.ok(f.calls.every(call => new URL(call.url).origin === 'https://api.github.com'))
})
