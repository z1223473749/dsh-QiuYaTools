import { mkdir, writeFile } from 'node:fs/promises'

// Optional artwork export only; normal builds use the checked-in assets and
// do not require sharp. QIUYA_SHARP_MODULE can point at a bundled installation.
const { default: sharp } = await import(process.env.QIUYA_SHARP_MODULE || 'sharp')
const root = new URL('../', import.meta.url)
const color = new URL('design/icon-concepts/B-color-original.png', root)
const mono = new URL('design/icon-concepts/B-menu-original.png', root)
const output = new URL('assets/', root)
await mkdir(output, { recursive: true })

await sharp(color.pathname).resize(512, 512, { fit: 'contain', background: '#00000000' })
  .webp({ quality: 90, alphaQuality: 100, effort: 6 }).toFile(new URL('icon-color.webp', output).pathname)

// Preserve the generated black ink as an alpha mask. White paper/cutouts
// become transparent so CSS currentColor works on both light and dark menus.
const { data, info } = await sharp(mono.pathname).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
for (let i = 0; i < data.length; i += 4) {
  const luminance = .2126 * data[i] + .7152 * data[i + 1] + .0722 * data[i + 2]
  data[i + 3] = Math.round(data[i + 3] * (1 - luminance / 255))
  data[i] = data[i + 1] = data[i + 2] = 0
}
await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
  .trim().resize(240, 240, { fit: 'contain', background: '#00000000' })
  .extend({ top: 8, bottom: 8, left: 8, right: 8, background: '#00000000' })
  .png({ compressionLevel: 9 }).toFile(new URL('icon-menu.png', output).pathname)

const metadata = await Promise.all(['icon-color.webp', 'icon-menu.png'].map(async name => {
  const path = new URL(name, output).pathname
  const result = await sharp(path).metadata()
  return { file: name, width: result.width, height: result.height, format: result.format }
}))
await writeFile(new URL('brand.json', output), JSON.stringify({ name: 'QiuYa 增强工具箱', concept: 'B：温柔手绘', icons: metadata }, null, 2) + '\n')
console.log(JSON.stringify(metadata))
