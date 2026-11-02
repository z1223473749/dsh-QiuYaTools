import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { composerPreviewBuild } from '../scripts/composer-preview-build.mjs'

test('PDF worker has identical bundled bytes after relocating the checkout and installed dependencies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qyt-preview-build-paths-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const outputs = []
  for (const name of ['developer-checkout', 'github-runner']) {
    const directory = join(root, name), dependency = join(directory, 'node_modules/pdfjs-dist/build')
    await mkdir(dependency, { recursive: true })
    const workerSourcePath = join(dependency, 'pdf.worker.min.mjs')
    await writeFile(workerSourcePath, '/* identical local worker */\nexport const version = "fixture";\n')
    const result = await build({
      stdin: { contents: 'export async function worker() { return (await import("pdfjs-dist/build/pdf.worker.min.mjs?raw")).default }', resolveDir: directory },
      absWorkingDir: directory, outfile: join(directory, 'client.js'), bundle: true,
      write: false, platform: 'browser', format: 'cjs', minifyWhitespace: true,
      plugins: [composerPreviewBuild({ workerSourcePath })],
    })
    const output = result.outputFiles[0].text
    assert.equal(output.includes(root), false, 'Build must not retain the physical dependency location')
    assert.ok(output.includes('qyt-worker-source:pdf.worker.min.mjs'))
    assert.ok(output.includes('identical local worker'))
    outputs.push(output)
  }
  assert.equal(outputs[0], outputs[1], 'Different checkout roots must produce the same client bytes')
})
