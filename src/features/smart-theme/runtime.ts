import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
const revision = '5850ab45f587c112167512ffef949107115e26a0'
const artifacts = {
  encoder: { name: 'encoder.onnx', url: `https://huggingface.co/Xenova/slimsam-77-uniform/resolve/${revision}/onnx/vision_encoder_quantized.onnx`, hash: 'cce23c7b2e5d4f330932738fb67ba518e04b0d99ccdd1cccd22a7da4e01f2971', limit: 10_000_000 },
  decoder: { name: 'decoder.onnx', url: `https://huggingface.co/Xenova/slimsam-77-uniform/resolve/${revision}/onnx/prompt_encoder_mask_decoder_quantized.onnx`, hash: 'cb90b279f549d2cab7fd6e20c38522438c65d84bdcca3d2a764cff7d857fdce2', limit: 6_000_000 },
  wasm: { name: 'runtime.wasm', url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort-wasm-simd-threaded.wasm', hash: '207d02be4591c156b0a98f024f3d58005b5b04c92274d759fb390338c63559ea', limit: 13_000_000 },
} as const
const scripts = { worker: 'worker.js', ort: 'ort.wasm.min.mjs', binding: 'ort-wasm-simd-threaded.mjs' } as const
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
/** Fixed, integrity-pinned public weights. This route accepts no URL/path and
 * never sends user images anywhere. Cached weights are profile-local. */
export async function smartSegmentationRuntime(part: unknown, cache: string, signal: AbortSignal, runtime = new URL('./smart-segmentation/', import.meta.url)): Promise<string> {
  if (typeof part !== 'string') throw new Error('invalid-request')
  if (Object.hasOwn(scripts, part)) return (await readFile(new URL(scripts[part as keyof typeof scripts], runtime))).toString('base64')
  if (!Object.hasOwn(artifacts, part)) throw new Error('invalid-request')
  const artifact = artifacts[part as keyof typeof artifacts], path = join(cache, artifact.name)
  try { const bytes = await readFile(path); if (bytes.length <= artifact.limit && sha(bytes) === artifact.hash) return bytes.toString('base64') } catch {}
  const response = await fetch(artifact.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]) })
  if (!response.ok || Number(response.headers.get('content-length')) > artifact.limit || !response.body) throw new Error('segmentation-unavailable')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > artifact.limit) throw new Error('segmentation-unavailable'); chunks.push(value) } }
  finally { await reader.cancel().catch(() => {}) }
  const bytes = Buffer.concat(chunks)
  if (sha(bytes) !== artifact.hash) throw new Error('segmentation-unavailable')
  await mkdir(cache, { recursive: true, mode: 0o700 }); const temporary = path + '.' + randomUUID() + '.tmp'
  try { await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await rename(temporary, path) } finally { await rm(temporary, { force: true }) }
  return bytes.toString('base64')
}
