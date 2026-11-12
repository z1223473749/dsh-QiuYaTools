/** Test real installed Host SDK modules without opening the UI or touching a profile. */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = resolve(process.argv[2] ?? '/Applications/DeepSeek Harness.app')
const temporary = await mkdtemp(join(tmpdir(), 'qiuya-harness-agents-'))
try {
  const bundle = join(temporary, 'routing.mjs')
  await build({
    stdin: { contents: "export * from './src/host-agents.ts'; export * from './src/features/computer-use/tool-routing.ts'", resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
    outfile: bundle, bundle: true, platform: 'node', format: 'esm',
  })
  const result = spawnSync(join(app, 'Contents/MacOS/DeepSeek Harness'), [
    fileURLToPath(new URL('../tests/fixtures/harness-agent-compatibility.mjs', import.meta.url)),
    join(app, 'Contents/Resources/app.asar/dsh/package.json'), bundle,
  ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Runtime exited ${result.status}`)
  process.stdout.write(result.stdout)
} finally { await rm(temporary, { recursive: true, force: true }) }
