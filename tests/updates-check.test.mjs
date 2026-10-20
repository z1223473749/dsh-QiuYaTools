import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'

const source = await build({
  stdin: { contents: "export * from './src/updates/version.ts'; export * from './src/updates/release.ts'; export * from './src/updates/check.ts'", resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', target: 'node22', format: 'cjs',
})
const module = { exports: {} }
vm.runInNewContext(source.outputFiles[0].text, { module, exports: module.exports, URL, Date, AbortController, TextDecoder, setTimeout, clearTimeout, Response })
const { parseSemanticVersion, compareVersions, resolveGitHubRepository, validateReleaseMetadata, GitHubReleaseChecker } = module.exports
const repository = 'https://github.com/QiuYa/QiuYaTools'
function release(overrides = {}) {
  return {
    id: 21, tag_name: 'v1.2.0', draft: false, prerelease: false,
    url: 'https://api.github.com/repos/QiuYa/QiuYaTools/releases/21',
    html_url: `${repository}/releases/tag/v1.2.0`, published_at: '2026-10-20T10:00:00Z',
    name: 'New release', body: 'Release notes',
    assets: [{
      id: 22, name: 'dsh-qiuya-tools-darwin-universal.tgz', state: 'uploaded', size: 100,
      url: 'https://api.github.com/repos/QiuYa/QiuYaTools/releases/assets/22',
      browser_download_url: `${repository}/releases/download/v1.2.0/dsh-qiuya-tools-darwin-universal.tgz`,
      digest: `sha256:${'a'.repeat(64)}`,
    }], ...overrides,
  }
}
const checker = (fetch, extra = {}) => new GitHubReleaseChecker({ repository, currentVersion: '1.1.0', packageName: 'dsh-qiuya-tools', fetch, ...extra })

test('update semver follows numeric and prerelease precedence without integer precision loss', () => {
  const sequence = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.2.0', '1.10.0', '2.0.0']
  for (let index = 1; index < sequence.length; index++) {
    assert.equal(compareVersions(sequence[index - 1], sequence[index]), -1)
    assert.equal(compareVersions(sequence[index], sequence[index - 1]), 1)
  }
  assert.equal(compareVersions('v1.0.0+first', '1.0.0+second'), 0)
  assert.equal(compareVersions('9007199254740992.0.0', '9007199254740993.0.0'), -1)
  assert.equal(compareVersions('1.0.0-alpha.9007199254740992', '1.0.0-alpha.9007199254740993'), -1)
  for (const value of ['1', '1.0', '01.0.0', '1.00.0', '1.0.0-01', '1.0.0-', '1.0.0+', '1.0.0\n', ' 1.0.0', '1.0.0-alpha..one']) assert.equal(parseSemanticVersion(value), undefined, value)
  assert.equal(parseSemanticVersion('1.0.0' + String.fromCharCode(10)), undefined)
  assert.throws(() => compareVersions('invalid', '1.0.0'))
})

test('update repository metadata accepts only a fixed public GitHub HTTPS repository', () => {
  assert.equal(resolveGitHubRepository({ type: 'git', url: 'git+https://github.com/QiuYa/QiuYaTools.git' }).url, repository)
  for (const url of [undefined, 'http://github.com/QiuYa/QiuYaTools', 'https://github.com.evil.test/QiuYa/QiuYaTools', 'https://user:secret@github.com/QiuYa/QiuYaTools', 'https://github.com/QiuYa/QiuYaTools?x=1', 'https://github.com/QiuYa/QiuYaTools#branch', 'https://github.com/QiuYa/%2e%2e', 'https://github.com/QiuYa/QiuYaTools/extra', 'https://github.com/QiuYa\\QiuYaTools']) assert.equal(resolveGitHubRepository(url), undefined, String(url))
})

test('release validation binds stable metadata and the preferred universal asset to the exact repository', () => {
  const parsed = validateReleaseMetadata(release(), resolveGitHubRepository(repository), 'dsh-qiuya-tools', 'arm64')
  assert.equal(parsed.version, '1.2.0')
  assert.equal(parsed.asset.name, 'dsh-qiuya-tools-darwin-universal.tgz')
  assert.equal(parsed.asset.sha256, 'a'.repeat(64))
  assert.equal(validateReleaseMetadata(release(), resolveGitHubRepository(repository.toLowerCase()), 'dsh-qiuya-tools', 'arm64').version, '1.2.0')
  assert.equal(validateReleaseMetadata(release({ assets: [] }), resolveGitHubRepository(repository), 'dsh-qiuya-tools', 'arm64').asset, undefined)
  for (const patch of [
    { draft: true }, { prerelease: true }, { tag_name: 'v1.2.0-rc.1' },
    { html_url: `${repository}/releases/tag/v1.2.0?redirect=evil` },
    { url: 'https://api.github.com/repos/attacker/other/releases/21' },
  ]) assert.throws(() => validateReleaseMetadata(release(patch), resolveGitHubRepository(repository), 'dsh-qiuya-tools', 'arm64'))
  for (const patch of [
    { browser_download_url: 'https://evil.test/pkg.tgz' },
    { browser_download_url: `${repository}/releases/download/v1.2.0/%2e%2e/dsh-qiuya-tools-darwin-universal.tgz` },
    { url: 'https://api.github.com/repos/attacker/other/releases/assets/22' },
    { size: 0 }, { size: 64 * 1024 * 1024 + 1 }, { digest: null }, { digest: 'sha256:bad' },
  ]) {
    const data = release()
    Object.assign(data.assets[0], patch)
    assert.throws(() => validateReleaseMetadata(data, resolveGitHubRepository(repository), 'dsh-qiuya-tools', 'arm64'))
  }
})

test('GitHub checks coalesce requests, cache successful results, and support explicit fresh checks', async () => {
  let complete
  let calls = 0
  let clock = 100
  const first = new Promise(resolve => { complete = resolve })
  const api = checker(async (url, init) => {
    calls++
    assert.equal(url, 'https://api.github.com/repos/QiuYa/QiuYaTools/releases/latest')
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'error')
    assert.equal(init.credentials, 'omit')
    return calls === 1 ? first : new Response(JSON.stringify(release()))
  }, { now: () => clock, cacheMs: 500 })
  try {
    const a = api.check()
    const b = api.check({ force: true })
    assert.equal(a, b)
    complete(new Response(JSON.stringify(release())))
    assert.equal((await a).status, 'available')
    assert.equal((await api.check()).status, 'available')
    assert.equal(calls, 1)
    await api.check({ force: true })
    assert.equal(calls, 2)
    clock += 501
    await api.check()
    assert.equal(calls, 3)
  } finally { api.dispose() }
})

test('GitHub checks handle newer local builds, no release, invalid data, timeouts, rate limits and unreachable networks safely', async () => {
  const cases = [
    [async () => new Response(JSON.stringify(release())), { currentVersion: '1.3.0' }, 'up-to-date', undefined],
    [async () => new Response('', { status: 404 }), {}, 'no-release', undefined],
    [async () => new Response('HTML instead of JSON'), {}, 'error', 'invalid-release'],
    [async () => new Response('', { status: 429 }), {}, 'error', 'rate-limited'],
    [async () => { throw Error('secret diagnostic should not escape') }, {}, 'error', 'network'],
    [async () => new Promise(() => {}), { timeoutMs: 10 }, 'error', 'timeout'],
  ]
  for (const [request, options, status, code] of cases) {
    const api = checker(request, options)
    try {
      const result = await api.check()
      assert.equal(result.status, status)
      assert.equal(result.problem?.code, code)
      assert.doesNotMatch(JSON.stringify(result), /secret diagnostic/)
    } finally { api.dispose() }
  }
  let requests = 0
  const api = checker(async () => { requests++; throw Error('unexpected') }, { repository: undefined })
  assert.equal((await api.check()).status, 'not-configured')
  assert.equal(requests, 0)
  api.dispose()
  assert.equal((await api.check()).problem.code, 'disposed')
})
