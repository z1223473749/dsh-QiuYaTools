import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** Stable virtual identities keep the client identical on developer and CI paths. */
export function composerPreviewBuild({ workerSourcePath = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs') } = {}) {
  return {
    name: 'qiuya-document-preview-assets',
    setup(build) {
      build.onResolve({ filter: /^pdfjs-dist\/build\/pdf\.worker\.min\.mjs\?raw$/ }, () => ({
        path: 'pdf.worker.min.mjs', namespace: 'qyt-worker-source',
      }))
      build.onLoad({ filter: /.*/, namespace: 'qyt-worker-source' }, async () => ({
        contents: await readFile(workerSourcePath, 'utf8'), loader: 'text',
      }))
      build.onLoad({ filter: /[\\/]pdfjs-dist[\\/]build[\\/]pdf\.mjs$/ }, async ({ path }) => {
        const source = await readFile(path, 'utf8')
        if (!source.includes('globalThis.pdfjsLib = {')) throw Error('PDF.js export face changed')
        return { loader: 'js', contents: '/*! Modified by QiuYaTools: isolate PDF.js global exports from the Host preview runtime. */\n' + source
          .replace('globalThis.pdfjsLib = {', 'const qytPdfjsLib = {')
          .replace('globalThis._pdfjsTestingUtils = {', 'const qytPdfjsTestingUtils = {') }
      })
    },
  }
}
