import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'

/** One local PDF page per task, bounded pixels and a worker with no document URL. */
let previous: Promise<void> = Promise.resolve()
export function readPdfPreview(file: File): Promise<{ kind: 'page'; url: string }> {
  const result = previous.then(() => renderPdfPage(file))
  previous = result.then(() => {}, () => {})
  return result
}

async function renderPdfPage(file: File): Promise<{ kind: 'page'; url: string }> {
  if (file.size > 32 * 1024 * 1024) throw Error('PDF preview limit')
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs')
  const data = new Uint8Array(await file.arrayBuffer())
  const workerURL = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
  let worker: Worker
  try { worker = new Worker(workerURL, { type: 'module' }) }
  catch (error) { URL.revokeObjectURL(workerURL); throw error }
  // PDF.js 5's generated declaration incorrectly infers the default null port.
  const pdfWorker = new pdfjs.PDFWorker({ port: worker as unknown as null })
  const task = pdfjs.getDocument({
    data, worker: pdfWorker,
    isEvalSupported: false, useSystemFonts: true, disableFontFace: true,
    disableAutoFetch: true, disableStream: true, isOffscreenCanvasSupported: false,
    maxImageSize: 16_000_000, canvasMaxAreaInBytes: 4 * 1024 * 1024,
  })
  const timer = setTimeout(() => { void task.destroy().catch(() => {}) }, 12000)
  try {
    const document = await task.promise
    const page = await document.getPage(1)
    const original = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: Math.min(360 / original.width, 540 / original.height) })
    const canvas = window.document.createElement('canvas')
    canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height))
    await page.render({ canvas, viewport, background: '#ffffff' }).promise
    return { kind: 'page', url: canvas.toDataURL('image/png') }
  } finally {
    clearTimeout(timer)
    await task.destroy().catch(() => {})
    pdfWorker.destroy(); worker.terminate(); URL.revokeObjectURL(workerURL)
  }
}
