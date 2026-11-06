import { readdir, readFile } from 'node:fs/promises'

// Embed the originals only in standalone browser fixtures so their generated
// previews also work when opened as local HTML without a network connection.
export async function themeArtFixture() {
  const assets = new URL('../assets/', import.meta.url)
  const names = (await readdir(assets)).filter(name => /^q-[\w-]+\.(jpg|webp)$/.test(name))
  const art = Object.fromEntries(await Promise.all(names.map(async name => [name, (await readFile(new URL(name, assets))).toString('base64')])))
  return `(() => {
    const art = ${JSON.stringify(art)};
    return async (channel, method, { id }) => channel === '/api' && method === 'qiuya-tools/theme-art/get' && Object.hasOwn(art, id)
      ? { ok: true, value: art[id] } : { ok: false };
  })()`
}
