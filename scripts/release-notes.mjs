import { readFile, realpath, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Select exactly one version section; never fall back to another release's notes. */
export function extractReleaseNotes(changelog, version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error('Invalid release version')
  }
  const lines = changelog.replaceAll('\r\n', '\n').split('\n')
  const headings = []
  let fence
  for (let index = 0; index < lines.length; index++) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(lines[index])
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined
      continue
    }
    if (marker) { fence = { character: marker[1][0], length: marker[1].length }; continue }
    const heading = /^ {0,3}##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u.exec(lines[index])
    if (heading) headings.push({ version: heading[1], line: index })
  }
  const matches = headings.filter(heading => heading.version === version)
  if (matches.length !== 1) throw new Error(matches.length ? `Duplicate changelog section for ${version}` : `Missing changelog section for ${version}`)
  const start = matches[0]
  const end = headings.find(heading => heading.line > start.line)?.line ?? lines.length
  const notes = lines.slice(start.line + 1, end).join('\n').trim()
  if (!notes) throw new Error(`Empty changelog section for ${version}`)
  return `${notes}\n`
}

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/release-notes.mjs <output-file>')
  const root = new URL('../', import.meta.url)
  const [metadata, changelog] = await Promise.all([
    readFile(new URL('package.json', root), 'utf8'),
    readFile(new URL('CHANGELOG.md', root), 'utf8'),
  ])
  const { version } = JSON.parse(metadata)
  // Validate before writing, so a missing section cannot leave publishable notes.
  const notes = extractReleaseNotes(changelog, version)
  await writeFile(resolve(process.argv[2]), notes, { encoding: 'utf8', flag: 'wx' })
  console.log(`Prepared release notes for ${version}`)
}

if (process.argv[1] && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) await main()
