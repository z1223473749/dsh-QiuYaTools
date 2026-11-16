import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = join(root, 'artifacts/ocean-scene/bluefish-3d')
let page, revision, building = false, queued = false, debounce
let revisionPolls = 0, pageLoads = 0
async function rebuild() {
  if (building) { queued = true; return }
  building = true
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/preview-bluefish-3d.mjs', '--generate-only'], { cwd: root, stdio: ['ignore','ignore','inherit'] })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Build exited ${code}`)))
    })
    const nextPage = await readFile(join(output, 'bluefish-3d.html'))
    const nextRevision = nextPage.toString().match(/name="bluefish-model-revision" content="([a-f0-9]{64})"/)?.[1]
    if (!nextRevision) throw new Error('Preview revision is missing')
    page = nextPage
    revision = nextRevision
    console.log(`Updated model ${revision.slice(0,12)}`)
  } catch (error) { console.error(error) }
  finally {
    building = false
    if (queued) { queued = false; void rebuild() }
  }
}
await rebuild()
if (!page) throw new Error('Initial preview build failed')
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  if (request.url === '/__bluefish_revision') {
    revisionPolls++
    response.setHeader('Content-Type', 'text/plain')
    response.end(revision)
  } else if (request.url === '/__bluefish_stats') {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ revision, revisionPolls, pageLoads }))
  } else if (request.url === '/' || request.url?.startsWith('/?')) {
    pageLoads++
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(page)
  } else if (request.url === '/favicon.ico') {
    response.writeHead(204).end()
  } else { response.writeHead(404).end() }
})
server.listen(58385, '127.0.0.1', () => console.log('Live model: http://127.0.0.1:58385/'))
const changed = () => { clearTimeout(debounce); debounce = setTimeout(() => { void rebuild() }, 250) }
const watchers = [watch(join(root, 'src/client/bluefish-3d'), changed), watch(join(root, 'scripts/preview-bluefish-3d.mjs'), changed)]
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { watchers.forEach(w => w.close()); server.close(); process.exit(0) })
