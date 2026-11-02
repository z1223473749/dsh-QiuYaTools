import { MAX_THEME_IMAGE_BYTES } from '../custom-themes.ts'
export type ThemeImageError = 'qThemeImageInvalid' | 'qThemeImageLarge'
export interface ImportedThemeImage { image: string; width: number; height: number; accent: string }
/** Decode and re-encode locally to remove metadata and bound profile size. */
export async function importThemeImage(file: File): Promise<ImportedThemeImage> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size) throw new Error('qThemeImageInvalid')
  if (file.size > 10 * 1024 * 1024) throw new Error('qThemeImageLarge')
  const url = URL.createObjectURL(file)
  try {
    const img = new Image(); img.src = url
    try { await img.decode() } catch { throw new Error('qThemeImageInvalid') }
    if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 40_000_000) throw new Error('qThemeImageLarge')
    const ratio = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio))
    const painter = canvas.getContext('2d')
    if (!painter) throw new Error('qThemeImageInvalid')
    painter.fillStyle = '#fffaf5'; painter.fillRect(0, 0, canvas.width, canvas.height); painter.drawImage(img, 0, 0, canvas.width, canvas.height)
    let image = ''
    for (const quality of [.84, .7, .54, .38]) {
      image = canvas.toDataURL('image/webp', quality)
      if ((image.length - image.indexOf(',') - 1) * 3 / 4 <= MAX_THEME_IMAGE_BYTES) break
    }
    // Highly detailed images can remain large even at low quality. Reduce
    // resolution rather than retaining an oversized image in the profile.
    while ((image.length - image.indexOf(',') - 1) * 3 / 4 > MAX_THEME_IMAGE_BYTES) {
      canvas.width = Math.max(1, Math.floor(canvas.width * .75)); canvas.height = Math.max(1, Math.floor(canvas.height * .75))
      painter.fillStyle = '#fffaf5'; painter.fillRect(0, 0, canvas.width, canvas.height); painter.drawImage(img, 0, 0, canvas.width, canvas.height)
      image = canvas.toDataURL('image/webp', .7)
      if (canvas.width === 1 && canvas.height === 1 && !image.startsWith('data:image/')) throw new Error('qThemeImageInvalid')
    }
    const sample = document.createElement('canvas'); sample.width = sample.height = 24
    const context = sample.getContext('2d')!
    context.drawImage(canvas, 0, 0, 24, 24)
    const pixels = context.getImageData(0, 0, 24, 24).data, colors = new Map<string, { sum: number[]; count: number }>()
    for (let i = 0; i < pixels.length; i += 4) {
      const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]], max = Math.max(...rgb), min = Math.min(...rgb)
      if (max < 45 || min > 220 || max - min < 18) continue
      const key = rgb.map(v => Math.floor(v / 48)).join(',')
      const bucket = colors.get(key) ?? { sum: [0, 0, 0], count: 0 }; bucket.count++; rgb.forEach((v, c) => { bucket.sum[c] += v }); colors.set(key, bucket)
    }
    const chosen = [...colors.values()].sort((a, b) => b.count - a.count)[0]
    const accent = chosen ? '#' + chosen.sum.map(v => Math.round(v / chosen.count).toString(16).padStart(2, '0')).join('') : '#ad563e'
    return { image, width: canvas.width, height: canvas.height, accent }
  } finally { URL.revokeObjectURL(url) }
}
