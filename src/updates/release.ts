import { parseSemanticVersion } from './version.ts'
import type { UpdateRelease } from './contract.ts'

export interface GitHubRepository { readonly owner: string; readonly repo: string; readonly url: string }
export interface ReleaseAsset {
  readonly id: number
  readonly name: string
  readonly url: string
  readonly size: number
  readonly sha256: string
}
export interface ValidatedRelease extends UpdateRelease { readonly asset?: ReleaseAsset }

/** Resolve only an explicit public GitHub repository from trusted package metadata. */
export function resolveGitHubRepository(input: unknown): GitHubRepository | undefined {
  const raw = typeof input === 'object' && input !== null ? (input as { url?: unknown }).url : input
  if (typeof raw !== 'string' || raw.length > 300 || /[\s\\%]/u.test(raw)) return undefined
  const normalized = raw.replace(/^git\+/, '')
  let url: URL
  try { url = new URL(normalized) } catch { return undefined }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port !== '' || url.username || url.password || url.search || url.hash) return undefined
  const segments = url.pathname.replace(/\/$/, '').split('/')
  if (segments.length !== 3) return undefined
  const owner = segments[1]!
  const repo = segments[2]!.replace(/\.git$/, '')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo === '.' || repo === '..') return undefined
  return Object.freeze({ owner, repo, url: `https://github.com/${owner}/${repo}` })
}

function object(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid GitHub release metadata')
  return input as Record<string, unknown>
}
function positiveInteger(input: unknown): input is number { return typeof input === 'number' && Number.isSafeInteger(input) && input > 0 }
function exactUrl(input: unknown, expected: string): string {
  if (typeof input !== 'string' || /[\s\\]/u.test(input)) throw new Error('Unexpected GitHub release URL')
  const actual = new URL(input)
  const trusted = new URL(expected)
  if (actual.origin !== trusted.origin || actual.username || actual.password || actual.search || actual.hash) throw new Error('Unexpected GitHub release URL')
  const parts = actual.pathname.split('/')
  const expectedParts = trusted.pathname.split('/')
  const identities = actual.hostname === 'api.github.com' ? [2, 3] : [1, 2]
  if (parts.length !== expectedParts.length || parts.some((part, index) => identities.includes(index)
    ? part.toLowerCase() !== expectedParts[index]!.toLowerCase() : part !== expectedParts[index])) throw new Error('Unexpected GitHub release URL')
  // Repository names are case-insensitive; publish the URL built from trusted configuration.
  return expected
}

/** Only deterministic architecture-specific assets or the universal package may be installed. */
export function updateAssetNames(packageName: string, architecture: 'arm64' | 'x64', platform: 'darwin' | 'win32' = 'darwin'): readonly string[] {
  if (!/^[a-z0-9][a-z0-9._-]{0,213}$/.test(packageName)) throw new Error('Invalid update package name')
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(architecture)) throw new Error('Unsupported update platform')
  return platform === 'win32' ? [`${packageName}-win32-${architecture}.tgz`] : [`${packageName}-darwin-universal.tgz`, `${packageName}-darwin-${architecture}.tgz`]
}

/** Check one public stable Release and bind every selected asset to that exact repository and tag. */
export function validateReleaseMetadata(input: unknown, repository: GitHubRepository, packageName: string, architecture: 'arm64' | 'x64', platform: 'darwin' | 'win32' = 'darwin'): ValidatedRelease {
  const data = object(input)
  const version = parseSemanticVersion(data.tag_name)
  if (version === undefined || version.prerelease.length > 0 || data.draft !== false || data.prerelease !== false || !positiveInteger(data.id)) throw new Error('Invalid stable GitHub release')
  const tag = data.tag_name as string
  exactUrl(data.url, `https://api.github.com/repos/${repository.owner}/${repository.repo}/releases/${data.id}`)
  const url = exactUrl(data.html_url, `${repository.url}/releases/tag/${encodeURIComponent(tag)}`)
  if (typeof data.published_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(data.published_at) || !Number.isFinite(Date.parse(data.published_at))) throw new Error('Invalid release publication time')
  if (!Array.isArray(data.assets) || data.assets.length > 1000) throw new Error('Invalid release assets')
  let asset: ReleaseAsset | undefined
  for (const expectedName of updateAssetNames(packageName, architecture, platform)) {
    const matches = data.assets.filter(item => item !== null && typeof item === 'object' && (item as { name?: unknown }).name === expectedName)
    if (matches.length > 1) throw new Error('Ambiguous release asset')
    if (matches.length === 0) continue
    const selected = object(matches[0])
    if (selected.state !== 'uploaded' || !positiveInteger(selected.id) || !positiveInteger(selected.size) || selected.size > 64 * 1024 * 1024) throw new Error('Invalid release asset')
    const assetUrl = exactUrl(selected.browser_download_url, `${repository.url}/releases/download/${encodeURIComponent(tag)}/${expectedName}`)
    exactUrl(selected.url, `https://api.github.com/repos/${repository.owner}/${repository.repo}/releases/assets/${selected.id}`)
    if (typeof selected.digest !== 'string' || !/^sha256:[a-fA-F0-9]{64}$/.test(selected.digest)) throw new Error('Missing release asset integrity digest')
    asset = Object.freeze({ id: selected.id, name: expectedName, url: assetUrl, size: selected.size, sha256: selected.digest.slice(7).toLowerCase() })
    break
  }
  return Object.freeze({
    version: version.version, tag, url,
    title: typeof data.name === 'string' ? data.name.slice(0, 200) : tag,
    notes: typeof data.body === 'string' ? data.body.slice(0, 16_384) : '',
    publishedAt: data.published_at,
    ...asset === undefined ? {} : { asset },
  })
}
