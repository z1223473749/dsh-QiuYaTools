/** Local test transport around the production Host; no user profile/accounts. */
import { build } from 'esbuild'
export async function createThemeVideoFixture(directory) {
  const bundle = await build({ entryPoints: ['src/features/theme-video/host.ts'], bundle: true, write: false, platform: 'node', format: 'esm' })
  const { installThemeVideoHost } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
  const routes = new Map()
  const stop = installThemeVideoHost({ profileContext: { dir: directory }, connection: { browserPeer: { principal: { kind: 'owner' } }, fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } } })
  return {
    stop,
    async handle(request, response) {
      const route = routes.get(request.url)
      if (!route || request.method !== 'POST') return false
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const result = await route.fetch(new Request('http://fixture' + request.url, { method: 'POST', body: Buffer.concat(chunks) }))
      response.writeHead(result.status, Object.fromEntries(result.headers))
      response.end(Buffer.from(await result.arrayBuffer()))
      return true
    },
  }
}
