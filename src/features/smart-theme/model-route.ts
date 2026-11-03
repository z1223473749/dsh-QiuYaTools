/** Model identity is supplied by Harness, not a fixed list of product versions. */
export interface SmartThemeModelRoute { provider: string; model: string; name: string }
export interface SmartThemeModelCatalogEntry { id: string; name: string; inputModalities?: readonly string[] }
export interface SmartThemeModelDirectory {
  listProviders(): { id: string; name: string }[]
  listModels(provider: string): Promise<SmartThemeModelCatalogEntry[]>
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<SmartThemeModelCatalogEntry>
}
function versionOf(text: string): number[] {
  const match = text.match(/deepseek[\s_-]*v?(\d+(?:\.\d+)*)/i)
  return match ? match[1].split('.').map(Number) : []
}
function compareVersions(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (b[i] ?? 0) - (a[i] ?? 0); if (d) return d }
  return 0
}
/** Prefer the signed-in account's current catalog. Explicit versions sort newest
 * first; unknown aliases retain the adapter's preferred order. Capability is
 * resolved for exact routes when advisory listings omit it. No model is called. */
export async function discoverSmartThemeModels(directory: SmartThemeModelDirectory, signal?: AbortSignal): Promise<SmartThemeModelRoute[]> {
  const providers = directory.listProviders()
  const catalogs = await Promise.allSettled(providers.map(provider => directory.listModels(provider.id)))
  signal?.throwIfAborted()
  const candidates = await Promise.all(providers.map(async (provider, providerIndex) => {
    const catalog = catalogs[providerIndex]
    if (catalog.status !== 'fulfilled') return []
    const models = await Promise.all(catalog.value.map(async (entry, modelIndex) => {
      if (!/deepseek/i.test(`${provider.id} ${provider.name} ${entry.id} ${entry.name}`)) return null
      let model = entry
      if (model.inputModalities === undefined && directory.resolveModelInfo) {
        try { model = await directory.resolveModelInfo(provider.id, entry.id, signal) } catch { return null }
      }
      if (!model.inputModalities?.includes('image')) return null
      return { provider: provider.id, model: entry.id, name: `${provider.name} · ${model.name || entry.name}`,
        account: provider.id === 'deepseek-account', providerIndex, modelIndex, version: versionOf((model.name || entry.name) + ' ' + entry.id) }
    }))
    return models.filter((model): model is NonNullable<typeof model> => model !== null)
  }))
  signal?.throwIfAborted()
  return candidates.flat().sort((a, b) => Number(b.account) - Number(a.account) || (a.providerIndex === b.providerIndex ? compareVersions(a.version, b.version) : 0) || a.providerIndex - b.providerIndex || a.modelIndex - b.modelIndex)
    .map(({ provider, model, name }) => ({ provider, model, name }))
}
